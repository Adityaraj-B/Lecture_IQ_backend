'use strict';

/**
 * cloudinary.js — Cloudinary v2 client configuration.
 *
 * Credentials are loaded from environment variables:
 *   CLOUDINARY_CLOUD_NAME
 *   CLOUDINARY_API_KEY
 *   CLOUDINARY_API_SECRET
 *
 * Note: Public raw delivery is used for simplicity. If lecture audio ever
 * needs to be access-controlled, migrate to Cloudinary's authenticated
 * delivery (signed URLs) as a future hardening step.
 */

const cloudinary = require('cloudinary').v2;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure:     true,
});

/**
 * Returns true if all three Cloudinary credentials are present in env.
 * Used to decide whether to use Cloudinary or fall back to local disk.
 *
 * @returns {boolean}
 */
function isConfigured() {
  return !!(
    process.env.CLOUDINARY_CLOUD_NAME &&
    process.env.CLOUDINARY_API_KEY &&
    process.env.CLOUDINARY_API_SECRET
  );
}

module.exports = { cloudinary, isConfigured };
