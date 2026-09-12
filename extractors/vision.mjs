export default {
  id: 'vision-classification',
  version: 4,
  supports: ({ type }) => type === 'photo' || type === 'video',
  async run({ type, filePath, queryOllama, extractVideoFrames, visionModel }) {
    let imagePath = filePath;
    let prompt;

    if (type === 'video') {
      imagePath = extractVideoFrames(filePath);
      if (!imagePath) throw new Error('Video frame extraction failed');
      prompt = 'This image consists of 3 sequential timeline frames extracted from a home/archive video. Describe only what is visibly present in these frames. Choose one grounded category from Animals, People, Nature, Travel, Food, Object, Event, Architecture, Document, or Other. Use Document only when a page, receipt, poster, or screen with visible text dominates the frame; never use Document just because text or an object appears in the background. Do not infer a family gathering, celebration, room, event, or people unless clearly visible. Return valid JSON containing "category", a factual one-sentence "summary", and "tags" as an array of 3-12 concise lowercase nouns or short phrases for visible subjects, setting, activity, and mood.';
    } else {
      prompt = 'Describe only what is visibly present in this image. Choose one grounded category from Animals, People, Nature, Travel, Food, Object, Event, Architecture, Document, or Other. Use Document only when a page, receipt, poster, or screen with visible text dominates the image; never use Document just because text or an object appears in the background. If the image shows an animal, identify the animal only when visually clear. Return valid JSON containing "category", a factual one-sentence "summary", and "tags" as an array of 3-12 concise lowercase nouns or short phrases for visible subjects, setting, activity, and mood (for example: cat, beach, sand). Do not invent names or locations.';
    }

    const result = await queryOllama(visionModel, prompt, imagePath);
    return {
      fields: {
        category: result.category,
        summary: result.summary,
        tags: result.tags,
        llmError: result.error,
      },
    };
  },
};
