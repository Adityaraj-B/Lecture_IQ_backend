# LectureIQ Backend

LectureIQ Backend is a Node.js/Express + MongoDB + BullMQ/Redis backend designed for real-time lecture audio capture, chunked transcription, LLM-driven multilingual MCQ quiz generation, professor review workflows, and instant Firestore delivery to students.

---

## 📖 Complete Documentation & Architecture

For the complete architectural design, Mermaid flowcharts, queue diagrams, schema definitions, and API specifications, see:
👉 **[ARCHITECTURE.md](ARCHITECTURE.md)**

---

## 🚀 Quick Start

### 1. Prerequisites
- Node.js v18+
- MongoDB instance (e.g., MongoDB Atlas URI)
- Redis instance (e.g., Upstash Redis with TLS support)

### 2. Installation
```powershell
cd backend
npm install
```

### 3. Environment Variables
Copy `.env.example` to `.env` and fill in your connection strings:
```powershell
cp .env.example .env
```

### 4. Database Seeding
Create default test users (`prof.test@lectureiq.dev` / `password123`) and a sample course:
```powershell
npm run seed
```

### 5. Running the Application

#### Start the API Server
```powershell
npm run dev
```

#### Start Background Workers (in separate terminals)
```powershell
# Worker 1: Audio Transcription
node src/workers/transcribeChunkWorker.js

# Worker 2: Transcript Assembly & Diarization
node src/workers/assembleTranscriptWorker.js

# Worker 3: LLM MCQ Generation
node src/workers/generateMCQsWorker.js
```

---

## 📡 API Overview

| Route Prefix | Purpose | Key Roles |
|---|---|---|
| `/api/auth` | Register & Login (JWT) | Public |
| `/api/lectures` | Start, upload chunks, finalize, review, publish | Professor |
| `/api/attempts` | Submit quiz attempt & instant auto-grading | Student |
| `/api/students` | Quizzes list (pending/completed) & mastery dashboard | Student / Admin |
| `/api/professors` | Class score distribution & concept heatmap | Professor / Admin |
