export default {
  id: 'document-classification',
  version: 2,
  supports: ({ type }) => type === 'pdf' || type === 'ebook',
  async run({ filePath, fileName, runPythonExtractor, queryOllama, textModel }) {
    const rawMetadata = runPythonExtractor('extract_doc.py', filePath);
    const fields = {
      rawMetadata,
      extractedDate: rawMetadata.date || null,
      category: 'Unsorted',
      summary: 'No description available.',
      tags: [],
    };
    if (!rawMetadata.text_chunk) return { fields };

    const result = await queryOllama(
      textModel,
      `Analyze this text excerpt from a document/book titled "${rawMetadata.title || fileName}". Return valid JSON containing a high-level classification "category" (e.g., Finance, Technical Manual, Novel, Receipt), a concise one-sentence "summary", and "tags" as an array of 3-12 concise lowercase topical keywords. Text: "${rawMetadata.text_chunk.slice(0, 1500)}"`,
    );
    fields.category = result.category || fields.category;
    fields.summary = result.summary || fields.summary;
    fields.tags = result.tags;
    fields.llmError = result.error;
    delete fields.rawMetadata.text_chunk;
    return { fields };
  },
};
