import { randomBytes } from 'node:crypto';

const env = process.env;

// Secrets come only from the environment: backend/.env locally, the Render dashboard in production.
const authSecret = env.AUTH_SECRET || env.JWT_SECRET || '';

export const config = {
  port: Number(env.PORT) || 8080,
  appKey: env.APP_KEY || '',
  /** Local fallback storage when no MongoDB is configured. */
  dataDir: env.DATA_DIR || 'data',
  mongo: {
    uri: env.MONGODB_URI || env.MONGO_URI || '',
    dbName: env.MONGODB_DB || 'lectureiq_app',
  },
  /** One-tap demo sign-in with seeded data. Set DEMO_MODE=false for real classes. */
  demoMode: env.DEMO_MODE !== 'false',
  auth: {
    /** Signs session tokens. Without it a random one is used, so sessions end on restart. */
    secret: authSecret || randomBytes(32).toString('hex'),
    secretConfigured: Boolean(authSecret),
    tokenTtlMs: 30 * 24 * 60 * 60 * 1000,
    /** Optional: when set, registering as a professor requires this code. */
    facultyCode: env.FACULTY_CODE || '',
  },
  groq: {
    apiKey: env.GROQ_API_KEY || '',
    baseUrl: 'https://api.groq.com/openai/v1',
    sttModel: env.GROQ_STT_MODEL || 'whisper-large-v3-turbo',
    llmModel: env.GROQ_LLM_MODEL || 'openai/gpt-oss-120b',
  },
  gemini: {
    apiKey: env.GEMINI_API_KEY || '',
    model: env.GEMINI_MODEL || 'gemini-2.5-flash',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
  },
  limits: {
    maxUploadBytes: 25 * 1024 * 1024, // Groq free-tier upload cap
    maxTranscriptChars: 200_000,
  },
};

export function describeConfig() {
  return {
    groq: Boolean(config.groq.apiKey),
    gemini: Boolean(config.gemini.apiKey),
    geminiModel: config.gemini.model,
    storage: config.mongo.uri ? 'mongodb' : 'file',
    appKeyRequired: Boolean(config.appKey),
    facultyCodeRequired: Boolean(config.auth.facultyCode),
    demoMode: config.demoMode,
  };
}
