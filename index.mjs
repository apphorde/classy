import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execFileSync } from 'child_process';
import mime from 'mime-types';
import exifParser from 'exif-parser';
import console from 'console';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

// Import your custom remote SQLite module
let db;

// Configuration (Pull from environment variables passed to Docker container)
const OLLAMA_URL = process.env.OLLAMA_URL;
const SCAN_DIR = path.join(process.cwd(), 'data');
const VISION_MODEL = process.env.VISION_MODEL || 'qwen2.5-vl:7b';
const TEXT_MODEL = process.env.TEXT_MODEL || 'gemma2:27b';
const DB_URL = process.env.DATABASE_URL;
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SCAN_INTERVAL_HOURS = Math.max(Number(process.env.SCAN_INTERVAL_HOURS) || 12, 1);
const SCAN_INTERVAL_MS = SCAN_INTERVAL_HOURS * 60 * 60 * 1000;

const scanStatus = {
  scanDir: SCAN_DIR,
  running: false,
  scanned: 0,
  indexed: 0,
  skipped: 0,
  failed: 0,
  removed: 0,
  lastStartedAt: null,
  lastCompletedAt: null,
  lastIndexedPath: null,
  lastPrunedAt: null,
  nextScheduledAt: null,
  lastError: null,
};

if (!DB_URL) {
  console.log('Set DATABASE_URL first!');
  process.exit(1);
}

if (!OLLAMA_URL) {
  console.log('Set OLLAMA_URL first!');
  process.exit(1);
}

/**
 * Ensures required models are pulled and ready on the remote Ollama server at startup
 */
async function bootstrapOllama() {
  const models = [VISION_MODEL, TEXT_MODEL];
  const baseUrl = new URL(OLLAMA_URL.endsWith('/v1') ? OLLAMA_URL.slice(0, -3) : OLLAMA_URL);

  for (const model of models) {
    console.log(`📡 Checking remote Ollama for model: ${model}...`);
    try {
      const response = await fetch(new URL(`/api/pull`, baseUrl), {
        method: 'POST',
        body: JSON.stringify({ name: model, stream: false }),
      });

      if (response.ok) {
        console.log(`✅ Model ${model} is ready and verified.`);
      } else {
        console.error(`⚠️ Failed to pull model ${model}:`, await response.text());
      }
    } catch (err) {
      console.error(`❌ Error communicating with Ollama endpoint:`, err.message);
    }
  }
}

/**
 * Initializes the database schemas if they do not exist
 */
async function initializeDatabase() {
  db = await import(DB_URL);
  console.log('🗄️ Verifying remote database schema...');

  await db.run(`
    CREATE TABLE IF NOT EXISTS media_signatures (
      sha256 TEXT PRIMARY KEY,
      file_type TEXT,
      extracted_date TEXT,
      ai_category TEXT,
      ai_summary TEXT,
      raw_metadata TEXT,
      ai_tags TEXT,
      enrichment_version INTEGER NOT NULL DEFAULT 0,
      llm_error TEXT
    )
  `);

  await db.run(`
    CREATE TABLE IF NOT EXISTS file_locations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sha256 TEXT,
      file_path TEXT UNIQUE,
      file_size INTEGER
    )
  `);
  await db.run(`CREATE INDEX IF NOT EXISTS idx_file_locations_sha256 ON file_locations (sha256)`);
  try {
    await db.run(`ALTER TABLE media_signatures ADD COLUMN llm_error TEXT`);
  } catch {
    // Existing installations already have this column.
  }
  try {
    await db.run(`ALTER TABLE media_signatures ADD COLUMN ai_tags TEXT`);
  } catch {
    // Existing installations already have this column.
  }
  try {
    await db.run(`ALTER TABLE media_signatures ADD COLUMN enrichment_version INTEGER NOT NULL DEFAULT 0`);
  } catch {
    // Existing installations already have this column.
  }
  await db.run(`UPDATE media_signatures SET ai_tags = '[]' WHERE ai_tags IS NULL OR ai_tags = ''`);
  await db.run(`
    UPDATE media_signatures
    SET llm_error = 'Legacy classification failure; the original reason was not captured.'
    WHERE ai_summary = 'Failed to classify via LLM' AND (llm_error IS NULL OR llm_error = '')
  `);
  console.log('✅ Schema initialized successfully.');
}

async function initializeDatabaseWithRetry() {
  let lastError;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      await initializeDatabase();
      return;
    } catch (error) {
      lastError = error;
      console.error(`⚠️ Database initialization attempt ${attempt}/5 failed:`, error.message);
      if (attempt < 5) await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
  throw lastError;
}

/**
 * Helper to calculate a file's SHA-256 hash smoothly
 */
function getFileHash(filePath) {
  const hash = crypto.createHash('sha256');
  const fileBuffer = fs.readFileSync(filePath);
  hash.update(fileBuffer);
  return hash.digest('hex');
}

/**
 * Helper to execute Python blocks dynamically to extract deeper document/audio metadata
 */
function runPythonExtractor(scriptPath, filePath) {
  try {
    const output = execFileSync('python3', [path.join(SCRIPT_DIR, scriptPath), filePath], { encoding: 'utf-8' });
    return JSON.parse(output.trim());
  } catch (error) {
    return { error: error.message };
  }
}

/**
 * Extracts 3 frames from a video using FFmpeg and merges them into a horizontal strip
 */
function extractVideoFrames(videoPath) {
  const tempDir = '/tmp/frames';
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

  const f1 = path.join(tempDir, 'f1.jpg');
  const f2 = path.join(tempDir, 'f2.jpg');
  const f3 = path.join(tempDir, 'f3.jpg');
  const combined = path.join(tempDir, 'combined.jpg');

  try {
    // Get duration
    const duration = parseFloat(
      execFileSync('ffprobe', [
        '-v',
        'error',
        '-show_entries',
        'format=duration',
        '-of',
        'default=noprint_wrappers=1',
        videoPath,
      ])
        .toString()
        .trim(),
    );

    // Extract frames at 10%, 50%, and 90% marks
    execFileSync('ffmpeg', ['-y', '-ss', String(duration * 0.1), '-i', videoPath, '-vframes', '1', '-q:v', '2', f1], {
      stdio: 'ignore',
    });
    execFileSync('ffmpeg', ['-y', '-ss', String(duration * 0.5), '-i', videoPath, '-vframes', '1', '-q:v', '2', f2], {
      stdio: 'ignore',
    });
    execFileSync('ffmpeg', ['-y', '-ss', String(duration * 0.9), '-i', videoPath, '-vframes', '1', '-q:v', '2', f3], {
      stdio: 'ignore',
    });

    // Merge frames into one image for the vision model
    execFileSync('ffmpeg', [
      '-y',
      '-i',
      f1,
      '-i',
      f2,
      '-i',
      f3,
      '-filter_complex',
      'hstack=inputs=3',
      combined,
    ], { stdio: 'ignore' });
    return combined;
  } catch (err) {
    console.error(`⚠️ Video frame extraction failed for ${path.basename(videoPath)}`);
    return null;
  }
}

/**
 * Interacts with Ollama Chat API
 */
async function queryOllama(model, prompt, imagePath = null) {
  const ollamaUrl = new URL(OLLAMA_URL);
  const openAiCompatible = ollamaUrl.pathname.replace(/\/+$/, '').endsWith('/v1');
  const payload = {
    model: model,
    messages: [{ role: 'user', content: prompt }],
    stream: false,
    ...(openAiCompatible ? { temperature: 0.2 } : { options: { temperature: 0.2 } }),
    ...(openAiCompatible ? { response_format: { type: 'json_object' } } : { format: 'json' }),
  };

  if (imagePath && fs.existsSync(imagePath)) {
    const base64Image = fs.readFileSync(imagePath).toString('base64');
    payload.messages[0].images = [base64Image];
  }

  try {
    const chatUrl = openAiCompatible ? new URL('chat/completions', `${ollamaUrl.toString().replace(/\/$/, '')}/`) : new URL('/api/chat', ollamaUrl);
    const res = await fetch(chatUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`Ollama returned HTTP ${res.status}`);
    const json = await res.json();
    const content = openAiCompatible ? json.choices?.[0]?.message?.content : json.message?.content;
    if (!content) throw new Error('Ollama response did not contain message content');
    return { ...JSON.parse(content), error: null };
  } catch (err) {
    return { category: 'Unknown', summary: 'Failed to classify via LLM', error: err.message };
  }
}

/**
 * Core processor for single items
 */
async function processFile(filePath) {
  const fileName = path.basename(filePath);
  const stats = fs.statSync(filePath);
  const mimeType = mime.lookup(filePath) || '';
  const sha256 = getFileHash(filePath);

  // Hash before deciding whether a path is already indexed so replacements are reprocessed.
  const existingPath = await db.get(`SELECT id, sha256 FROM file_locations WHERE file_path = ?`, [filePath]);
  const existingSignature = await db.get(`SELECT sha256, llm_error, enrichment_version FROM media_signatures WHERE sha256 = ?`, [sha256]);
  if (existingPath?.sha256 === sha256 && existingSignature && !existingSignature.llm_error && existingSignature.enrichment_version >= 1) return false;

  console.log(`🔍 Scanning: ${fileName}`);

  // Reuse metadata for duplicate content, but only write the location after it is known valid.
  if (existingSignature && !existingSignature.llm_error && existingSignature.enrichment_version >= 1) {
    await saveLocation(filePath, sha256, stats.size, existingPath);
    console.log(`➡️ Duplicate content identified. Logged location and skipped deep analysis.`);
    return true;
  }

  // Determine media category type
  let type = 'unknown';
  if (mimeType.startsWith('image/')) type = 'photo';
  else if (mimeType.startsWith('video/')) type = 'video';
  else if (mimeType.startsWith('audio/')) type = 'audio';
  else if (mimeType === 'application/pdf') type = 'pdf';
  else if (mimeType.includes('epub') || mimeType.includes('mobipocket')) type = 'ebook';

  let extractedDate = stats.birthtime.toISOString();
  let aiCategory = 'Unsorted';
  let aiSummary = 'No description available.';
  let aiTags = [];
  let rawMeta = {};
  let llmError = null;

  // 4. Processing logic by file class
  if (type === 'photo') {
    try {
      const buffer = fs.readFileSync(filePath);
      const parser = exifParser.create(buffer);
      const result = parser.parse();
      rawMeta = result.tags;
      if (result.tags.CreateDate) extractedDate = new Date(result.tags.CreateDate * 1000).toISOString();
    } catch {}

    const prompt = `Analyze this family/personal archive photo. Return valid JSON containing "category" (e.g., Travel, Family, Document, Event), a one-sentence "summary" describing the visual context, and "tags" as an array of 3-12 concise lowercase nouns or short phrases describing visible subjects, setting, activity, and mood (for example: animals, beach, family, sand). Do not invent names or locations.`;
    const aiResult = await queryOllama(VISION_MODEL, prompt, filePath);
    aiCategory = aiResult.category;
    aiSummary = aiResult.summary;
    aiTags = normalizeTags(aiResult.tags);
    llmError = aiResult.error;
  } else if (type === 'video') {
    const singleCompositeFrame = extractVideoFrames(filePath);
    if (singleCompositeFrame) {
      const prompt = `This image consists of 3 sequential timeline frames extracted from a home/archive video. Analyze them and return valid JSON containing a broad "category", a one-sentence "summary" of what is happening in the video clip, and "tags" as an array of 3-12 concise lowercase nouns or short phrases describing visible subjects, setting, activity, and mood.`;
      const aiResult = await queryOllama(VISION_MODEL, prompt, singleCompositeFrame);
      aiCategory = aiResult.category;
      aiSummary = aiResult.summary;
      aiTags = normalizeTags(aiResult.tags);
      llmError = aiResult.error;
    }
  } else if (type === 'audio') {
    // Run local helper script for music
    rawMeta = runPythonExtractor('extract_audio.py', filePath);
    extractedDate = rawMeta.year || extractedDate;
    aiCategory = rawMeta.genre || 'Music';
    aiSummary = `${rawMeta.title || fileName} by ${rawMeta.artist || 'Unknown Artist'} (Album: ${rawMeta.album || 'Unknown Album'})`;
    if (!rawMeta.genre) {
      const prompt = `Infer the most likely music genre and style from this audio file's available filename and folder context. Do not claim certainty and do not invent an artist. Return valid JSON with "genre" (one concise genre), "style" (a concise descriptor), "category" (usually Music), "summary" (one sentence), and "tags" (3-8 lowercase genre or mood tags). Filename: "${fileName}". Path context: "${filePath}". Metadata: ${JSON.stringify(rawMeta)}.`;
      const aiResult = await queryOllama(TEXT_MODEL, prompt);
      aiCategory = aiResult.genre || aiResult.category || 'Music';
      aiSummary = aiResult.summary || `${fileName} (genre inferred from filename and folder context)`;
      aiTags = normalizeTags(aiResult.tags);
      rawMeta.genre_source = 'llm-inferred-from-filename-and-folder-context';
      if (aiResult.style) rawMeta.style = aiResult.style;
      llmError = aiResult.error;
    }
  } else if (type === 'pdf' || type === 'ebook') {
    rawMeta = runPythonExtractor('extract_doc.py', filePath);
    extractedDate = rawMeta.date || extractedDate;

    if (rawMeta.text_chunk) {
      const prompt = `Analyze this text excerpt from a document/book titled "${rawMeta.title || fileName}". Return valid JSON containing a high-level classification "category" (e.g., Finance, Technical Manual, Novel, Receipt), a concise one-sentence "summary", and "tags" as an array of 3-12 concise lowercase topical keywords. Text: "${rawMeta.text_chunk.slice(0, 1500)}"`;
      const aiResult = await queryOllama(TEXT_MODEL, prompt);
      aiCategory = aiResult.category;
      aiSummary = aiResult.summary;
      aiTags = normalizeTags(aiResult.tags);
      llmError = aiResult.error;
      delete rawMeta.text_chunk; // Keep DB payload light
    }
  }

  // Save the record
  const signatureValues = [type, extractedDate, aiCategory, aiSummary, JSON.stringify(rawMeta), JSON.stringify(aiTags), 1, llmError];
  if (existingSignature) {
    await db.run(
      `UPDATE media_signatures SET file_type = ?, extracted_date = ?, ai_category = ?, ai_summary = ?, raw_metadata = ?, ai_tags = ?, enrichment_version = ?, llm_error = ? WHERE sha256 = ?`,
      [...signatureValues, sha256],
    );
  } else {
    await db.run(
      `INSERT INTO media_signatures (sha256, file_type, extracted_date, ai_category, ai_summary, raw_metadata, ai_tags, enrichment_version, llm_error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [sha256, ...signatureValues],
    );
  }
  await saveLocation(filePath, sha256, stats.size, existingPath);
  return true;
}

async function saveLocation(filePath, sha256, fileSize, existingPath) {
  if (existingPath) {
    await db.run(`UPDATE file_locations SET sha256 = ?, file_size = ? WHERE id = ?`, [sha256, fileSize, existingPath.id]);
    return;
  }

  await db.run(`INSERT INTO file_locations (sha256, file_path, file_size) VALUES (?, ?, ?)`, [sha256, filePath, fileSize]);
}

/**
 * Scan folders recursively
 */
async function startCrawling(dir) {
  if (!fs.existsSync(dir)) throw new Error(`Scan directory does not exist: ${dir}`);

  const items = fs.readdirSync(dir);
  for (const item of items) {
    const fullPath = path.join(dir, item);
    if (fs.statSync(fullPath).isDirectory()) {
      await startCrawling(fullPath);
    } else {
      scanStatus.scanned += 1;
      try {
        const indexed = await processFile(fullPath);
        if (indexed) {
          scanStatus.indexed += 1;
          scanStatus.lastIndexedPath = fullPath;
        }
        else scanStatus.skipped += 1;
      } catch (error) {
        scanStatus.failed += 1;
        scanStatus.lastError = `${fullPath}: ${error.message}`;
        console.error(`⚠️ Failed to index ${fullPath}:`, error.message);
      }
    }
  }
}

async function pruneMissingLocations() {
  const locations = await db.all(`SELECT id, file_path FROM file_locations`);
  let removed = 0;

  for (const location of locations) {
    try {
      fs.statSync(location.file_path);
    } catch (error) {
      if (error.code !== 'ENOENT') continue;
      await db.run(`DELETE FROM file_locations WHERE id = ?`, [location.id]);
      removed += 1;
    }
  }

  scanStatus.removed = removed;
  scanStatus.lastPrunedAt = new Date().toISOString();
  if (removed) console.log(`🧹 Removed ${removed} missing file location${removed === 1 ? '' : 's'}.`);
}

function parseMetadata(value) {
  if (!value) return {};
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function normalizeTags(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((tag) => typeof tag === 'string')
    .map((tag) => tag.trim().toLowerCase())
    .filter(Boolean))].slice(0, 30);
}

function serializeMedia(row) {
  const metadata = parseMetadata(row.raw_metadata);
  return {
    id: row.id,
    name: path.basename(row.file_path),
    relativePath: path.relative(SCAN_DIR, row.file_path),
    size: row.file_size,
    type: row.file_type || 'unknown',
    date: row.extracted_date || null,
    category: row.ai_category || 'Unsorted',
    summary: row.ai_summary || '',
    tags: normalizeTags(parseMetadata(row.ai_tags)),
    llmError: row.llm_error || null,
    metadata,
    contentUrl: `/api/media/${row.id}/content`,
  };
}

async function listMedia(url) {
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 48, 1), 100);
  const offset = Math.max(Number(url.searchParams.get('offset')) || 0, 0);
  const search = url.searchParams.get('search')?.trim() || '';
  const type = url.searchParams.get('type')?.trim() || '';
  const category = url.searchParams.get('category')?.trim() || '';
  const conditions = [];
  const params = [];

  if (search) {
    conditions.push('(l.file_path LIKE ? OR s.ai_summary LIKE ? OR s.ai_category LIKE ?)');
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }
  if (type) {
    conditions.push('s.file_type = ?');
    params.push(type);
  }
  if (category) {
    conditions.push('s.ai_category = ?');
    params.push(category);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = await db.all(
    `
      SELECT l.id, l.file_path, l.file_size, s.file_type, s.extracted_date,
             s.ai_category, s.ai_summary, s.raw_metadata, s.ai_tags, s.llm_error
      FROM file_locations l
      LEFT JOIN media_signatures s ON s.sha256 = l.sha256
      ${where}
      ORDER BY COALESCE(s.extracted_date, '') DESC, l.id DESC
      LIMIT ? OFFSET ?
    `,
    [...params, limit, offset],
  );
  const count = await db.get(
    `
      SELECT COUNT(*) AS total
      FROM file_locations l
      LEFT JOIN media_signatures s ON s.sha256 = l.sha256
      ${where}
    `,
    params,
  );
  return {
    items: rows.map(serializeMedia),
    total: Number(count?.total || 0),
    limit,
    offset,
  };
}

async function getMedia(id) {
  return db.get(
    `
      SELECT l.id, l.file_path, l.file_size, s.file_type, s.extracted_date,
             s.ai_category, s.ai_summary, s.raw_metadata, s.ai_tags, s.llm_error
      FROM file_locations l
      LEFT JOIN media_signatures s ON s.sha256 = l.sha256
      WHERE l.id = ?
    `,
    [id],
  );
}

function sendJson(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

const openApiDocument = {
  openapi: '3.1.0',
  info: {
    title: 'Classy Archive API',
    version: '1.0.0',
    description: 'Read indexed private media and trigger background archive scans.',
  },
  servers: [{ url: 'https://classy.api.apphor.de' }],
  security: [{ basicAuth: [] }],
  components: {
    securitySchemes: {
      basicAuth: { type: 'http', scheme: 'basic' },
    },
    schemas: {
      Media: {
        type: 'object',
        required: ['id', 'name', 'size', 'type', 'category', 'contentUrl'],
        properties: {
          id: { type: 'integer' },
          name: { type: 'string' },
          relativePath: { type: 'string' },
          size: { type: 'integer' },
          type: { type: 'string', enum: ['photo', 'video', 'audio', 'pdf', 'ebook', 'unknown'] },
          date: { type: ['string', 'null'], format: 'date-time' },
          category: { type: 'string' },
          summary: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
          llmError: { type: ['string', 'null'] },
          metadata: { type: 'object', additionalProperties: true },
          contentUrl: { type: 'string' },
        },
      },
    },
  },
  paths: {
    '/api': {
      get: { summary: 'Get this OpenAPI document', security: [], responses: { 200: { description: 'OpenAPI 3.1 document' } } },
    },
    '/api/media': {
      get: {
        summary: 'List indexed media',
        parameters: [
          { name: 'search', in: 'query', schema: { type: 'string' } },
          { name: 'type', in: 'query', schema: { type: 'string' } },
          { name: 'category', in: 'query', schema: { type: 'string' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 48 } },
          { name: 'offset', in: 'query', schema: { type: 'integer', minimum: 0, default: 0 } },
        ],
        responses: { 200: { description: 'Paginated media list' } },
      },
    },
    '/api/media/{id}': {
      get: {
        summary: 'Get media metadata',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
        responses: { 200: { description: 'Media record', content: { 'application/json': { schema: { $ref: '#/components/schemas/Media' } } } }, 404: { description: 'Media not found' } },
      },
    },
    '/api/media/{id}/content': {
      get: {
        summary: 'Stream original media',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }, { name: 'Range', in: 'header', schema: { type: 'string' } }],
        responses: { 200: { description: 'Media bytes' }, 206: { description: 'Partial media bytes' }, 404: { description: 'Media not found' } },
      },
      head: { summary: 'Inspect media headers', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }], responses: { 200: { description: 'Media headers' } } },
    },
    '/api/status': {
      get: { summary: 'Get scan status', responses: { 200: { description: 'Current scan and maintenance counters' } } },
    },
    '/api/scan': {
      post: { summary: 'Trigger a background scan', responses: { 202: { description: 'Scan accepted' } } },
    },
  },
};

async function serveMediaContent(req, res, id) {
  const row = await getMedia(id);
  if (!row) return sendJson(res, 404, { error: 'Media not found' });

  const filePath = path.resolve(row.file_path);
  const scanRoot = path.resolve(SCAN_DIR);
  if (filePath !== scanRoot && !filePath.startsWith(`${scanRoot}${path.sep}`)) {
    return sendJson(res, 403, { error: 'Media path is outside the scan directory' });
  }

  let stats;
  try {
    stats = fs.statSync(filePath);
  } catch {
    return sendJson(res, 404, { error: 'Media file is unavailable' });
  }

  const contentType = mime.lookup(filePath) || 'application/octet-stream';
  const headers = {
    'Content-Type': contentType,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'public, max-age=3600',
  };
  const range = req.headers.range;
  let start = 0;
  let end = stats.size - 1;
  let status = 200;

  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match) return sendJson(res, 416, { error: 'Invalid byte range' });
    if (match[1]) start = Number(match[1]);
    if (match[2]) end = Number(match[2]);
    if (!match[1]) start = Math.max(stats.size - end, 0);
    if (!match[2]) end = stats.size - 1;
    if (start > end || start >= stats.size) return sendJson(res, 416, { error: 'Range not satisfiable' });
    end = Math.min(end, stats.size - 1);
    status = 206;
    headers['Content-Range'] = `bytes ${start}-${end}/${stats.size}`;
  }

  headers['Content-Length'] = end - start + 1;
  res.writeHead(status, headers);
  if (req.method !== 'HEAD') fs.createReadStream(filePath, { start, end }).pipe(res);
  else res.end();
}

let inProgress = false;
async function run() {
  if (inProgress) return;

  inProgress = true;
  scanStatus.running = true;
  scanStatus.scanned = 0;
  scanStatus.indexed = 0;
  scanStatus.skipped = 0;
  scanStatus.failed = 0;
  scanStatus.removed = 0;
  scanStatus.lastError = null;
  scanStatus.lastStartedAt = new Date().toISOString();

  try {
    console.log(`🚀 Starting processing engine on target: ${SCAN_DIR}`);
    await pruneMissingLocations();
    await startCrawling(SCAN_DIR);
    console.log('🏁 Loop execution completed successfully.');
  } catch (e) {
    scanStatus.lastError = e.message;
    console.error(e);
  } finally {
    inProgress = false;
    scanStatus.running = false;
    scanStatus.lastCompletedAt = new Date().toISOString();
  }
}

// Master execution block
async function main() {
  await initializeDatabaseWithRetry();
  await bootstrapOllama();
}

const ready = main();
ready.then(async () => {
  await run();
  scanStatus.nextScheduledAt = new Date(Date.now() + SCAN_INTERVAL_MS).toISOString();
  setInterval(async () => {
    await run();
    scanStatus.nextScheduledAt = new Date(Date.now() + SCAN_INTERVAL_MS).toISOString();
  }, SCAN_INTERVAL_MS);
}).catch((error) => {
  scanStatus.lastError = error.message;
  console.error(error);
});

createServer(function (req, res) {
  const url = new URL(req.url, 'http://local');
  const route = `${req.method} ${url.pathname}`;

  const mediaContentMatch = /^(?:GET|HEAD) \/api\/media\/(\d+)\/content$/.exec(route);
  if (mediaContentMatch) {
    ready.then(() => serveMediaContent(req, res, mediaContentMatch[1])).catch((error) => sendJson(res, 503, { error: error.message }));
    return;
  }

  const mediaDetailMatch = /^GET \/api\/media\/(\d+)$/.exec(route);
  if (mediaDetailMatch) {
    ready.then(() => getMedia(mediaDetailMatch[1])).then((row) => row ? sendJson(res, 200, serializeMedia(row)) : sendJson(res, 404, { error: 'Media not found' })).catch((error) => sendJson(res, 503, { error: error.message }));
    return;
  }

  switch (route) {
    case 'GET /api':
    case 'GET /api/':
      sendJson(res, 200, openApiDocument);
      break;
    case 'GET /':
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(path.join(SCRIPT_DIR, 'public/index.html')));
      break;
    case 'GET /manifest.webmanifest':
      res.writeHead(200, { 'Content-Type': 'application/manifest+json; charset=utf-8', 'Cache-Control': 'public, max-age=3600' });
      res.end(fs.readFileSync(path.join(SCRIPT_DIR, 'public/manifest.webmanifest')));
      break;
    case 'GET /icon.svg':
      res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' });
      res.end(fs.readFileSync(path.join(SCRIPT_DIR, 'public/icon.svg')));
      break;
    case 'GET /sw.js':
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(fs.readFileSync(path.join(SCRIPT_DIR, 'public/sw.js')));
      break;
    case 'GET /api/media':
      ready.then(() => listMedia(url)).then((data) => sendJson(res, 200, data)).catch((error) => sendJson(res, 503, { error: error.message }));
      break;
    case 'GET /api/status':
      ready.then(() => db.get('SELECT COUNT(*) AS total FROM file_locations')).then((count) => sendJson(res, 200, { ...scanStatus, total: Number(count?.total || 0) })).catch((error) => sendJson(res, 503, { error: error.message }));
      break;
    case 'POST /api/scan':
      ready.then(() => run());
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: 'Scanning started', statusUrl: '/api/status' }));
      break;
    case 'GET /status':
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(scanStatus));
      break;

    default:
      res.end('OK');
  }
}).listen(process.env.PORT, function () {
  console.log('Classy started on port ' + process.env.PORT);
});
