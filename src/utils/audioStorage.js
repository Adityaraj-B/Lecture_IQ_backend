'use strict';

/**
 * audioStorage.js — Cloudinary-backed audio storage utility.
 *
 * Replaces the old gcsUpload.js. Provides two functions:
 *   uploadAudioChunk(buffer, destination, options) → { url, publicId, bytes }
 *   getAudioBuffer(sourceRef) → Buffer | null
 *
 * Cloudinary is the primary backend. When credentials are absent (local dev
 * without a Cloudinary account), the functions fall back to local disk under
 * backend/storage/, matching the old behaviour.
 */

const fs   = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { cloudinary, isConfigured } = require('../config/cloudinary');

const STORAGE_DIR = path.resolve(__dirname, '../../storage');

// ── Upload ────────────────────────────────────────────────────────────────────

/**
 * Upload an audio buffer to Cloudinary (or local disk as fallback).
 *
 * @param {Buffer}  buffer      - Raw audio bytes
 * @param {string}  destination - Logical path used as Cloudinary public_id,
 *                                e.g. "lectures/<lectureId>/chunk_0000"
 *                                (no file extension — Cloudinary raw preserves as-is)
 * @param {object}  [options]
 * @param {string}  [options.contentType='audio/wav']
 * @returns {Promise<{ url: string, publicId: string, bytes: number }>}
 */
async function uploadAudioChunk(buffer, destination, { contentType = 'audio/wav' } = {}) {
  if (!isConfigured()) {
    // ── Local-disk fallback (dev without Cloudinary credentials) ─────────────
    console.warn('[AudioStorage] Cloudinary not configured — writing to local disk as fallback');
    const localFilePath = path.join(STORAGE_DIR, destination + '.wav');
    fs.mkdirSync(path.dirname(localFilePath), { recursive: true });
    fs.writeFileSync(localFilePath, buffer);
    console.log(`[AudioStorage] Local fallback → ${localFilePath}`);
    return { url: localFilePath, publicId: destination, bytes: buffer.length };
  }

  // ── Cloudinary upload via streaming (no temp file) ────────────────────────
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        resource_type: 'video',  // Cloudinary's correct category for audio files (WAV/MP3/FLAC).
                                   // Audio is treated as 'video' (no visual track), NOT 'raw'.
                                   // 'raw' is for non-media files (fonts, subtitles, arbitrary blobs).
        public_id:     destination,
        folder:        undefined, // destination already contains the full logical path
        overwrite:     true,      // idempotent re-upload of the same chunk sequence
      },
      (error, result) => {
        if (error) {
          return reject(new Error(`[AudioStorage] Cloudinary upload failed for "${destination}": ${error.message}`));
        }
        console.log(`[AudioStorage] Cloudinary ✅ → ${result.secure_url} (${result.bytes} bytes)`);
        resolve({ url: result.secure_url, publicId: result.public_id, bytes: result.bytes });
      }
    );

    Readable.from(buffer).pipe(uploadStream);
  });
}

// ── Fetch ─────────────────────────────────────────────────────────────────────

/**
 * Fetch the audio buffer from a Cloudinary URL or a legacy local path.
 *
 * Accepts:
 *   - Cloudinary secure URL: "https://res.cloudinary.com/..."
 *   - Legacy local path (absolute or relative under storage/)
 *   - Legacy gs:// path (strips the gs://bucket/ prefix and checks local disk)
 *
 * @param {string} sourceRef - Cloudinary URL or local/legacy path
 * @returns {Promise<Buffer|null>}
 */
async function getAudioBuffer(sourceRef) {
  if (!sourceRef) return null;

  // ── Path 1: Cloudinary URL ────────────────────────────────────────────────
  if (sourceRef.startsWith('https://res.cloudinary.com/')) {
    try {
      const response = await fetch(sourceRef);
      if (!response.ok) {
        console.warn(`[AudioStorage] Cloudinary fetch HTTP ${response.status} for ${sourceRef}`);
        return null;
      }
      const arrayBuffer = await response.arrayBuffer();
      return Buffer.from(arrayBuffer);
    } catch (err) {
      console.warn(`[AudioStorage] Cloudinary fetch error for ${sourceRef}:`, err.message);
      return null;
    }
  }

  // ── Path 2: Local/legacy disk path ───────────────────────────────────────
  // Strip gs://bucket/ prefix if still present in old DB documents
  const relativePath = sourceRef.replace(/^gs:\/\/[^/]+\//, '');
  const localFilePath = path.isAbsolute(relativePath)
    ? relativePath
    : path.join(STORAGE_DIR, relativePath);

  if (fs.existsSync(localFilePath)) {
    return fs.readFileSync(localFilePath);
  }

  console.warn(`[AudioStorage] Could not resolve audio at: ${sourceRef}`);
  return null;
}

module.exports = { uploadAudioChunk, getAudioBuffer };
