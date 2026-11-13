// Labels a transcript as English, Hindi or Hinglish, so lecturers never pick a language:
// Whisper auto-detects the speech, and this decides whether students may see the raw
// transcript (English lectures only). Generated questions and notes are always English.

const DEVANAGARI = /\p{Script=Devanagari}/gu; // Hindi script
const LETTERS = /\p{L}/gu;

// Common romanised Hindi function words. Words that are also everyday English
// ("to", "me", "the", "par", "is") are deliberately left out.
const HINDI_WORDS = new Set(
  `hai hain ho hota hoti hote tha thi raha rahi rahe hoga hogi ka ki ke ko se mein nahi nahin kya kyun kyunki
   aur toh matlab yeh ye woh wo jo jab agar lekin bhi kuch sab abhi accha acha theek samjho samajh dekho chalo
   apna apne hum humein aap tum iska uska isko usko iske uske wala wali wale karna karte karo kar diya liya gaya
   sakte sakta chahiye bahut zyada kaise kaun kab kahan yahan wahan isliye phir fir haan bas`.split(/\s+/),
);

const DEVANAGARI_SHARE = 0.2; // of all letters
const HINGLISH_SHARE = 0.08; // of all words
const MIN_WORDS = 8;

/**
 * @param {string} text transcript
 * @returns {'en' | 'hi' | 'hinglish'}
 */
export function detectLanguage(text) {
  const t = String(text ?? '');
  const letters = t.match(LETTERS)?.length ?? 0;
  if (letters && (t.match(DEVANAGARI)?.length ?? 0) / letters >= DEVANAGARI_SHARE) return 'hi';

  const words = t.toLowerCase().match(/[a-z]+/g) ?? [];
  if (words.length < MIN_WORDS) return 'en';
  const hindi = words.filter((w) => HINDI_WORDS.has(w)).length;
  return hindi / words.length >= HINGLISH_SHARE ? 'hinglish' : 'en';
}
