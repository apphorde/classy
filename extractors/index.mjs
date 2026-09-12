import exif from './exif.mjs';
import vision from './vision.mjs';
import audio from './audio.mjs';
import document from './document.mjs';
import faces from './faces.mjs';
import thumbnail from './thumbnail.mjs';

export const extractors = [exif, vision, audio, document, faces, thumbnail];
