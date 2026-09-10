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

const scanStatus = {
  scanDir: SCAN_DIR,
  running: false,
  scanned: 0,
  indexed: 0,
  skipped: 0,
  failed: 0,
  lastStartedAt: null,
  lastCompletedAt: null,
  lastIndexedPath: null,
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
      raw_metadata TEXT
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
  console.log('✅ Schema initialized successfully.');
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
        'default=noprint_wrappers=1:nocorrect_bps=1',
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
    options: { temperature: 0.2 },
    ...(openAiCompatible ? { response_format: { type: 'json_object' } } : { format: 'json' }),
  };

  if (imagePath && fs.existsSync(imagePath)) {
    const base64Image = fs.readFileSync(imagePath).toString('base64');
    payload.messages[0].images = [base64Image];
  }

  try {
    const chatUrl = openAiCompatible ? new URL('chat', `${ollamaUrl.toString().replace(/\/$/, '')}/`) : new URL('/api/chat', ollamaUrl);
    const res = await fetch(chatUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`Ollama returned HTTP ${res.status}`);
    const json = await res.json();
    return JSON.parse(json.message.content);
  } catch (err) {
    return { category: 'Unknown', summary: 'Failed to classify via LLM' };
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
  const existingSignature = await db.get(`SELECT sha256 FROM media_signatures WHERE sha256 = ?`, [sha256]);
  if (existingPath?.sha256 === sha256 && existingSignature) return false;

  console.log(`🔍 Scanning: ${fileName}`);

  // Reuse metadata for duplicate content, but only write the location after it is known valid.
  if (existingSignature) {
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
  let rawMeta = {};

  // 4. Processing logic by file class
  if (type === 'photo') {
    try {
      const buffer = fs.readFileSync(filePath);
      const parser = exifParser.create(buffer);
      const result = parser.parse();
      rawMeta = result.tags;
      if (result.tags.CreateDate) extractedDate = new Date(result.tags.CreateDate * 1000).toISOString();
    } catch {}

    const prompt = `Analyze this family/personal archive photo. Return valid JSON containing "category" (e.g., Travel, Family, Document, Event) and a one-sentence "summary" describing the visual context.`;
    const aiResult = await queryOllama(VISION_MODEL, prompt, filePath);
    aiCategory = aiResult.category;
    aiSummary = aiResult.summary;
  } else if (type === 'video') {
    const singleCompositeFrame = extractVideoFrames(filePath);
    if (singleCompositeFrame) {
      const prompt = `This image consists of 3 sequential timeline frames extracted from a home/archive video. Analyze them and return valid JSON containing a broad "category" and a one-sentence "summary" of what is happening in the video clip.`;
      const aiResult = await queryOllama(VISION_MODEL, prompt, singleCompositeFrame);
      aiCategory = aiResult.category;
      aiSummary = aiResult.summary;
    }
  } else if (type === 'audio') {
    // Run local helper script for music
    rawMeta = runPythonExtractor('extract_audio.py', filePath);
    extractedDate = rawMeta.year || extractedDate;
    aiCategory = rawMeta.genre || 'Music';
    aiSummary = `${rawMeta.title || fileName} by ${rawMeta.artist || 'Unknown Artist'} (Album: ${rawMeta.album || 'Unknown Album'})`;
  } else if (type === 'pdf' || type === 'ebook') {
    rawMeta = runPythonExtractor('extract_doc.py', filePath);
    extractedDate = rawMeta.date || extractedDate;

    if (rawMeta.text_chunk) {
      const prompt = `Analyze this text excerpt from a document/book titled "${rawMeta.title || fileName}". Return valid JSON containing a high-level classification "category" (e.g., Finance, Technical Manual, Novel, Receipt) and a concise one-sentence "summary". Text: "${rawMeta.text_chunk.slice(0, 1500)}"`;
      const aiResult = await queryOllama(TEXT_MODEL, prompt);
      aiCategory = aiResult.category;
      aiSummary = aiResult.summary;
      delete rawMeta.text_chunk; // Keep DB payload light
    }
  }

  // Save the record
  await db.run(
    `
    INSERT INTO media_signatures (sha256, file_type, extracted_date, ai_category, ai_summary, raw_metadata)
    VALUES (?, ?, ?, ?, ?, ?)
  `,
    [sha256, type, extractedDate, aiCategory, aiSummary, JSON.stringify(rawMeta)],
  );
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

let inProgress = false;
async function run() {
  if (inProgress) return;

  inProgress = true;
  scanStatus.running = true;
  scanStatus.scanned = 0;
  scanStatus.indexed = 0;
  scanStatus.skipped = 0;
  scanStatus.failed = 0;
  scanStatus.lastError = null;
  scanStatus.lastStartedAt = new Date().toISOString();

  try {
    console.log(`🚀 Starting processing engine on target: ${SCAN_DIR}`);
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
  await initializeDatabase();
  await bootstrapOllama();
}

const startup = main()
  .then(() => run())
  .catch((error) => {
    scanStatus.lastError = error.message;
    console.error(error);
  });

createServer(function (req, res) {
  const url = new URL(req.url, 'http://local');
  const route = `${req.method} ${url.pathname}`;

  switch (route) {
    case 'POST /scan':
      startup.then(() => run());
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: 'Scanning started' }));
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

main().catch(console.error);
