import fs from 'node:fs';
import exifParser from 'exif-parser';

export default {
  id: 'image-exif',
  version: 1,
  supports: ({ type }) => type === 'photo',
  async run({ filePath }) {
    try {
      const result = exifParser.create(fs.readFileSync(filePath)).parse();
      return {
        fields: {
          rawMetadata: result.tags,
          extractedDate: result.tags.CreateDate ? new Date(result.tags.CreateDate * 1000).toISOString() : null,
        },
      };
    } catch (error) {
      throw new Error(`EXIF parse failed: ${error.message}`);
    }
  },
};
