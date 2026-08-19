'use strict';

const multer = require('multer');

// Store uploads in memory — we stream them to GCS immediately
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024, // 50 MB per chunk max
  },
  fileFilter: (_req, file, cb) => {
    // Accept audio files and generic binary (for testing with text files)
    const allowed = ['audio/wav', 'audio/mpeg', 'audio/mp4', 'audio/ogg',
                     'audio/webm', 'application/octet-stream'];
    if (allowed.includes(file.mimetype) || file.mimetype.startsWith('audio/')) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported file type: ${file.mimetype}`), false);
    }
  },
});

module.exports = { upload };
