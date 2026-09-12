export default {
  id: 'thumbnail',
  version: 1,
  supports: ({ type }) => type === 'photo' || type === 'video' || type === 'pdf',
  async run({ filePath, sha256, type, generateThumbnail }) {
    const thumbnailPath = generateThumbnail(filePath, sha256, type);
    return { fields: { thumbnailPath } };
  },
};
