# LectureIQ API

Node/Express backend for the LectureIQ Flutter app:

- **Speech to text**: lecture audio chunks → Groq Whisper.
- **Quiz generation**: transcript → Gemini (falls back to Groq) multiple-choice questions.
- **Classroom**: professor/student accounts, classes with join codes, published quizzes (answers hidden until submitted, graded on the server), analytics.
- **Live delivery**: Server-Sent Events push new quizzes to students and submissions to professors the moment they happen.

Data lives in MongoDB (Atlas free tier works). Without `MONGODB_URI` it falls back to a local `data/db.json`, which is handy for development.

## Run locally

```bash
cp .env.example .env   # fill in GROQ_API_KEY, GEMINI_API_KEY; leave MONGODB_URI unset to use a local file
npm install
npm run dev            # http://localhost:8080
npm test
```

Phone over USB: `adb reverse tcp:8080 tcp:8080`, then set the app's server to `http://localhost:8080`.

## Deploy on Render (free)

1. Connect this repo as a **Web Service**: build `npm ci --omit=dev`, start `npm start`, health check `/health`.
2. In **Environment**, set `GROQ_API_KEY`, `GEMINI_API_KEY`, `MONGODB_URI`, `AUTH_SECRET` (any long random string) and optionally `DEMO_MODE` / `FACULTY_CODE`.
3. In MongoDB Atlas → **Network Access**, allow `0.0.0.0/0` (Render free has no fixed outbound IP). Use a strong database password.
4. Point the app at `https://<your-service>.onrender.com` (Server settings, or `--dart-define=API_URL=...`).

The free instance sleeps after ~15 idle minutes and takes about a minute to wake; the app pings `/health` early to hide most of it. Data is safe in MongoDB across sleeps and redeploys. Run a single instance: the server keeps the working set in memory and writes changes through to MongoDB.

`MONGO_URI` and `JWT_SECRET` are accepted as aliases for `MONGODB_URI` and `AUTH_SECRET`.

## Endpoints

| | |
|---|---|
| `GET /health` | Public status: which keys are configured, storage kind, demo mode. |
| `POST /v1/transcribe` | multipart `file` (+ `subject`, `previousText`, `language`: `en` · `hi` · `hinglish`). Hindi/Hinglish audio is transcribed as spoken; every question, note and answer generated from it is in English. |
| `POST /v1/quiz` | `{ transcript, count, difficulty, subject }` → questions. |
| `POST /v1/auth/register` · `/login` · `/demo` · `GET /v1/auth/me` | Accounts; `/demo` signs in to the real, empty test professor or student account when `DEMO_MODE` is on. |
| `GET/POST /v1/courses` · `POST /v1/courses/join` · `DELETE /v1/courses/:id/membership` | Classes and join codes. |
| `GET/POST /v1/assignments` · `POST /:id/start` · `POST /:id/submit` · `GET /:id/results` · `DELETE /:id` | Published quizzes (optional `dueAt`, `timeLimitMin` 1–180, per-student `shuffle`), server-timed attempts, grading, per-quiz analytics. |
| `GET /v1/courses/:id/gradebook.csv` | Professor: one row per student, one column per quiz (score %, `missed`, or blank while open). |
| `GET/POST /v1/notes` · `GET/DELETE /v1/notes/:id` · `POST /v1/notes/:id/ask` | Lecture notes: English summary, key points and flashcards (generated once per lecture), and Q&A answered from the lecture only. |
| `POST /v1/practice` | Student: a private practice set on their weakest topics (reuses past questions when AI is unavailable). |
| `GET /v1/analytics/overview` | Professor dashboard. |
| `GET /v1/events` | Server-Sent Events stream for the signed-in user. |

AI-backed routes have per-user daily caps (notes 40, ask 30, practice 15) to stay inside free-tier quotas; over the cap they return 429 `daily_limit`.

All `/v1` routes require `x-app-key` when `APP_KEY` is set; classroom routes need `Authorization: Bearer <token>`.
