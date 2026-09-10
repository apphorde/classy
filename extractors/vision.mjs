export default {
  id: 'vision-classification',
  version: 2,
  supports: ({ type }) => type === 'photo' || type === 'video',
  async run({ type, filePath, queryOllama, extractVideoFrames, visionModel }) {
    let imagePath = filePath;
    let prompt;

    if (type === 'video') {
      imagePath = extractVideoFrames(filePath);
      if (!imagePath) throw new Error('Video frame extraction failed');
      prompt = 'This image consists of 3 sequential timeline frames extracted from a home/archive video. Return valid JSON containing a broad "category", a one-sentence "summary" of what is happening in the video clip, and "tags" as an array of 3-12 concise lowercase nouns or short phrases describing visible subjects, setting, activity, and mood.';
    } else {
      prompt = 'Analyze this family/personal archive photo. Return valid JSON containing "category" (e.g., Travel, Family, Document, Event), a one-sentence "summary" describing the visual context, and "tags" as an array of 3-12 concise lowercase nouns or short phrases describing visible subjects, setting, activity, and mood (for example: animals, beach, family, sand). Do not invent names or locations.';
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
