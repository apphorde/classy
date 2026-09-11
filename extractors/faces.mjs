export default {
  id: 'face-embeddings',
  version: 1,
  supports: ({ type }) => type === 'photo',
  async run({ filePath, extractFaces }) {
    const faces = await extractFaces(filePath);
    return { fields: { faceEmbeddings: faces } };
  },
};
