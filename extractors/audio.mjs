export default {
  id: 'audio-metadata',
  version: 2,
  supports: ({ type }) => type === 'audio',
  async run({ filePath, fileName, runPythonExtractor, queryOllama, textModel }) {
    const rawMetadata = runPythonExtractor('extract_audio.py', filePath);
    const fields = {
      rawMetadata,
      extractedDate: rawMetadata.year || null,
      category: rawMetadata.genre || 'Music',
      summary: `${rawMetadata.title || fileName} by ${rawMetadata.artist || 'Unknown Artist'} (Album: ${rawMetadata.album || 'Unknown Album'})`,
      tags: [],
    };

    if (rawMetadata.genre) return { fields };

    const result = await queryOllama(
      textModel,
      `Infer the most likely music genre and style from this audio file's available filename and folder context. Do not claim certainty and do not invent an artist. Return valid JSON with "genre" (one concise genre), "style" (a concise descriptor), "category" (usually Music), "summary" (one sentence), and "tags" (3-8 lowercase genre or mood tags). Filename: "${fileName}". Path context: "${filePath}". Metadata: ${JSON.stringify(rawMetadata)}.`,
    );
    fields.category = result.genre || result.category || 'Music';
    fields.summary = result.summary || `${fileName} (genre inferred from filename and folder context)`;
    fields.tags = result.tags;
    fields.rawMetadata = { ...rawMetadata, genre_source: 'llm-inferred-from-filename-and-folder-context', ...(result.style ? { style: result.style } : {}) };
    fields.llmError = result.error;
    return { fields };
  },
};
