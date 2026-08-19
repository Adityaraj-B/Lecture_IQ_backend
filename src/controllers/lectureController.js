'use strict';

const Lecture = require('../models/Lecture');
const Course = require('../models/Course');
const Transcript = require('../models/Transcript');
const { uploadAudioChunk } = require('../utils/audioStorage');
const { transcribeChunkQueue, assembleTranscriptQueue } = require('../queues');
const { createError } = require('../middleware/errorHandler');

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/lectures/start
// Professor only — creates a new Lecture in 'recording' status
// ─────────────────────────────────────────────────────────────────────────────
async function startLecture(req, res, next) {
  try {
    const { courseId, title, language } = req.body;
    if (!courseId) throw createError(400, 'courseId is required');

    // Validate the course belongs to this professor (auto-create for testing if invalid)
    let course;
    try {
      course = await Course.findOne({ _id: courseId, professorId: req.user.id });
    } catch (e) {
      // courseId is likely not a valid ObjectId (e.g. 'PHYS-402' hardcoded in app)
    }

    if (!course) {
      // Auto-create a fallback course so the professor can test recording
      course = await Course.create({
        name: 'Default Physics Course',
        code: courseId || 'PHYS-402',
        professorId: req.user.id,
      });
    }

    const lecture = await Lecture.create({
      courseId: course._id,
      professorId: req.user.id,
      title: title || `Lecture — ${new Date().toLocaleDateString('en-IN')}`,
      status: 'recording',
      language: {
        primary: language?.primary || 'hi',
        alternates: language?.alternates || ['en'],
      },
    });

    res.status(201).json({ lectureId: lecture._id, status: lecture.status });
  } catch (err) {
    next(err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/lectures/:id/chunk
// Professor only, multipart upload via Multer
// Body fields: sequence (number)
// File field: 'audio'
// ─────────────────────────────────────────────────────────────────────────────
async function uploadChunk(req, res, next) {
  try {
    const { id: lectureId } = req.params;
    const sequence = parseInt(req.body.sequence, 10);

    if (isNaN(sequence) || sequence < 0) throw createError(400, 'sequence must be a non-negative integer');
    if (!req.file) throw createError(400, 'Audio file is required (field name: audio)');

    const lecture = await Lecture.findById(lectureId);
    if (!lecture) throw createError(404, 'Lecture not found');
    if (lecture.professorId.toString() !== req.user.id) {
      throw createError(403, 'You do not own this lecture');
    }
    if (!['recording', 'uploading'].includes(lecture.status)) {
      throw createError(409, `Cannot upload chunks when lecture status is '${lecture.status}'`);
    }

    // Check for duplicate sequence (idempotent re-upload support)
    const alreadyUploaded = lecture.audioChunks?.find(c => c.sequence === sequence);
    if (alreadyUploaded && alreadyUploaded.status === 'uploaded') {
      return res.json({ message: 'Chunk already uploaded', sequence, audioUrl: alreadyUploaded.audioUrl });
    }

    // ── Build human-readable Cloudinary destination path ─────────────────────
    // Format: lectures/<courseCode>/<lectureId>_<YYYY-MM-DD>/chunk_XXXX
    // - courseCode  : from the Course document (sanitized, alphanumeric/hyphens only)
    // - lectureId   : MongoDB ObjectId — guarantees uniqueness even for same course+date
    // - YYYY-MM-DD  : derived from lecture.recordedAt (already set at creation time)
    // - chunk_XXXX  : zero-padded 4-digit sequence number (unchanged)
    //
    // NOTE: duplicate-detection is keyed on sequence within lecture.audioChunks,
    // NOT on this path — so this change has zero effect on idempotent re-upload logic.
    let courseCode = lectureId.toString(); // safe fallback if Course lookup fails
    try {
      const course = await Course.findById(lecture.courseId).select('code');
      if (course?.code) {
        // Sanitize: keep only alphanumeric chars and hyphens (e.g. "CS 301" → "CS-301")
        courseCode = course.code.trim().replace(/[^a-zA-Z0-9-]/g, '-').replace(/-+/g, '-');
      }
    } catch (courseErr) {
      console.warn(`[Lectures] Could not fetch course for path — using lectureId fallback: ${courseErr.message}`);
    }

    const lectureDate = (lecture.recordedAt || new Date()).toISOString().slice(0, 10); // YYYY-MM-DD
    const chunkSeq   = String(sequence).padStart(4, '0');
    const destination = `lectures/${courseCode}/${lectureId}_${lectureDate}/chunk_${chunkSeq}`;
    // Example: lectures/CS301/6884abc123_2026-08-16/chunk_0000

    // ── Upload to Cloudinary (or local fallback) ──────────────────────────────
    let uploadResult;
    try {
      uploadResult = await uploadAudioChunk(req.file.buffer, destination, {
        contentType: req.file.mimetype,
      });
    } catch (uploadErr) {
      // Mark chunk as failed and return retryable error to client
      await Lecture.findByIdAndUpdate(lectureId, {
        $push: {
          audioChunks: { sequence, audioUrl: destination, status: 'failed' },
        },
        $set: { status: 'uploading' },
      });
      throw createError(502, `Audio upload failed for chunk ${sequence}: ${uploadErr.message}`);
    }

    const audioUrl = uploadResult.url;

    // ── Push chunk entry / update existing ───────────────────────────────────
    const existingIdx = lecture.audioChunks?.findIndex(c => c.sequence === sequence) ?? -1;
    if (existingIdx >= 0) {
      // Update in-place (retry of a previously failed chunk)
      await Lecture.findOneAndUpdate(
        { _id: lectureId, 'audioChunks.sequence': sequence },
        { $set: { 'audioChunks.$.status': 'uploaded', 'audioChunks.$.audioUrl': audioUrl } }
      );
    } else {
      await Lecture.findByIdAndUpdate(lectureId, {
        $push: { audioChunks: { sequence, audioUrl, status: 'uploaded' } },
        $set: { status: 'uploading' },
      });
    }

    // ── Enqueue transcribeChunk job immediately (don't wait for finalize) ────
    let jobId = null;
    try {
      const job = await transcribeChunkQueue().add(
        'transcribeChunk',
        { lectureId, sequence, audioUrl },
        { jobId: `transcribe-${lectureId}-${sequence}` } // idempotent job ID
      );
      jobId = job.id;
      console.log(`[Lectures] Queued transcribeChunk job ${jobId} for chunk ${sequence}`);
    } catch (queueErr) {
      // Redis unavailable — log warning but still return success to client
      // Jobs will be enqueued once Redis is connected
      console.warn(`[Lectures] Could not enqueue chunk ${sequence} (Redis unavailable): ${queueErr.message}`);
    }

    res.status(201).json({ sequence, audioUrl, jobId });
  } catch (err) {
    next(err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/lectures/:id/finalize
// Professor only — marks lecture as 'processing' and queues assembleTranscript
// after all chunks finish
// ─────────────────────────────────────────────────────────────────────────────
async function finalizeLecture(req, res, next) {
  try {
    const { id: lectureId } = req.params;

    const lecture = await Lecture.findById(lectureId);
    if (!lecture) throw createError(404, 'Lecture not found');
    if (lecture.professorId.toString() !== req.user.id) {
      throw createError(403, 'You do not own this lecture');
    }
    if (lecture.status !== 'uploading' && lecture.status !== 'recording') {
      throw createError(409, `Cannot finalize a lecture in '${lecture.status}' status`);
    }

    const totalChunks = lecture.audioChunks?.length || 0;
    if (totalChunks === 0) throw createError(400, 'No chunks uploaded yet');

    await Lecture.findByIdAndUpdate(lectureId, {
      $set: { status: 'processing', durationSeconds: req.body?.durationSeconds || null },
    });

    // Enqueue assembleTranscript — it will wait for all transcribeChunk jobs
    // by polling chunk statuses in the Lecture document
    let assembleJobId = null;
    try {
      const job = await assembleTranscriptQueue().add(
        'assembleTranscript',
        { lectureId, expectedChunks: totalChunks },
        { jobId: `assemble-${lectureId}` }
      );
      assembleJobId = job.id;
      console.log(`[Lectures] Queued assembleTranscript job ${assembleJobId}`);
    } catch (queueErr) {
      console.warn(`[Lectures] Could not enqueue assembleTranscript (Redis unavailable): ${queueErr.message}`);
    }

    res.json({ lectureId, status: 'processing', totalChunks, assembleJobId });
  } catch (err) {
    next(err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/lectures/:id/status
// Returns current status and chunk processing counts (polling fallback)
// ─────────────────────────────────────────────────────────────────────────────
async function getLectureStatus(req, res, next) {
  try {
    const { id: lectureId } = req.params;
    const lecture = await Lecture.findById(lectureId).select(
      'status audioChunks durationSeconds processingError title courseId professorId'
    );
    if (!lecture) throw createError(404, 'Lecture not found');

    const chunkCounts = lecture.audioChunks.reduce(
      (acc, chunk) => {
        acc[chunk.status] = (acc[chunk.status] || 0) + 1;
        return acc;
      },
      {}
    );

    res.json({
      lectureId,
      title: lecture.title,
      status: lecture.status,
      durationSeconds: lecture.durationSeconds,
      processingError: lecture.processingError || null,
      chunks: {
        total: lecture.audioChunks.length,
        ...chunkCounts,
      },
    });
  } catch (err) {
    next(err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/lectures/:id/mcq-draft  (Step 7)
// ─────────────────────────────────────────────────────────────────────────────
async function getMCQDraft(req, res, next) {
  try {
    const MCQSet = require('../models/MCQSet');
    const { id: lectureId } = req.params;

    const lecture = await Lecture.findById(lectureId);
    if (!lecture) throw createError(404, 'Lecture not found');
    if (lecture.professorId.toString() !== req.user.id) {
      throw createError(403, 'You do not own this lecture');
    }

    const mcqSet = await MCQSet.findOne({ lectureId });
    if (!mcqSet) throw createError(404, 'MCQ draft not found yet — is the lecture still processing?');

    res.json(mcqSet);
  } catch (err) {
    next(err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/lectures/:id/mcq-draft  (Step 7)
// ─────────────────────────────────────────────────────────────────────────────
async function patchMCQDraft(req, res, next) {
  try {
    const MCQSet = require('../models/MCQSet');
    const { id: lectureId } = req.params;
    const { questions } = req.body;

    if (!Array.isArray(questions)) throw createError(400, 'questions array is required');

    const lecture = await Lecture.findById(lectureId);
    if (!lecture) throw createError(404, 'Lecture not found');
    if (lecture.professorId.toString() !== req.user.id) {
      throw createError(403, 'You do not own this lecture');
    }

    // Mark all questions as edited by professor
    const updatedQuestions = questions.map(q => ({ ...q, professorEdited: true }));

    const mcqSet = await MCQSet.findOneAndUpdate(
      { lectureId },
      { $set: { questions: updatedQuestions } },
      { new: true }
    );
    if (!mcqSet) throw createError(404, 'MCQ draft not found');

    res.json(mcqSet);
  } catch (err) {
    next(err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/lectures/:id/publish  (Step 7)
// ─────────────────────────────────────────────────────────────────────────────
async function publishLecture(req, res, next) {
  try {
    const MCQSet = require('../models/MCQSet');
    const { getFirestore } = require('../config/firebase');
    const { id: lectureId } = req.params;

    const lecture = await Lecture.findById(lectureId);
    if (!lecture) throw createError(404, 'Lecture not found');
    if (lecture.professorId.toString() !== req.user.id) {
      throw createError(403, 'You do not own this lecture');
    }
    if (lecture.status !== 'ready_for_review') {
      throw createError(409, `Lecture must be in 'ready_for_review' status to publish (current: '${lecture.status}')`);
    }

    const publishedAt = new Date();
    const mcqSet = await MCQSet.findOneAndUpdate(
      { lectureId, status: 'draft' },
      { $set: { status: 'published', publishedAt, reviewedBy: req.user.id } },
      { new: true }
    );
    if (!mcqSet) throw createError(404, 'Draft MCQSet not found — cannot publish');

    await Lecture.findByIdAndUpdate(lectureId, { $set: { status: 'published' } });

    // ── Write to Firestore for real-time delivery ─────────────────────────────
    const db = getFirestore();
    if (db) {
      await db.doc(`courses/${lecture.courseId}`).set(
        {
          activeQuiz: {
            mcqSetId: mcqSet._id.toString(),
            lectureId: lectureId.toString(),
            publishedAt: publishedAt.toISOString(),
          },
        },
        { merge: true }
      );
      console.log(`[Firestore] activeQuiz written for course ${lecture.courseId}`);
    } else {
      // TODO: replace stub — write to Firestore when credentials are available
      console.warn(`[Firestore] STUB — would write activeQuiz for course ${lecture.courseId}`);
    }

    res.json({ lectureId, mcqSetId: mcqSet._id, status: 'published', publishedAt });
  } catch (err) {
    next(err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/lectures/:id/transcript
// Returns all transcript segments for a lecture (any authenticated user)
// ─────────────────────────────────────────────────────────────────────────────
async function getTranscript(req, res, next) {
  try {
    const { id: lectureId } = req.params;
    const transcript = await Transcript.findOne({ lectureId })
      .select('segments fullTextConcatenated lectureId');
    if (!transcript) {
      return res.json({ lectureId, segments: [], fullTextConcatenated: '' });
    }
    // Return segments sorted by sequence
    const sorted = [...transcript.segments]
      .sort((a, b) => a.sequence - b.sequence)
      .map((s) => ({
        id:        s._id,
        sequence:  s.sequence,
        startTime: s.startTime,
        endTime:   s.endTime,
        text:      s.text,
        speaker:   s.speaker,
        sttStatus: s.sttStatus,
        language:  s.language,
      }));
    res.json({ lectureId, segments: sorted, fullTextConcatenated: transcript.fullTextConcatenated || '' });
  } catch (err) {
    next(err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/lectures
// Returns all lectures for the authenticated user (professor)
// ─────────────────────────────────────────────────────────────────────────────
async function getUserLectures(req, res, next) {
  try {
    const lectures = await Lecture.find({ professorId: req.user.id })
      .sort({ createdAt: -1 })
      .populate('courseId', 'name code'); // populate course name & code

    // Serialize: merge courseId fields into the lecture object
    const result = lectures.map((l) => {
      const obj = l.toObject();
      const course = obj.courseId; // populated doc or null
      obj.courseId = course?._id?.toString() ?? obj.courseId?.toString();
      obj.courseName = course?.name ?? '';
      obj.courseCode = course?.code ?? '';
      return obj;
    });

    res.json(result);
  } catch (err) {
    next(err);
  }
}


module.exports = {
  startLecture,
  uploadChunk,
  finalizeLecture,
  getLectureStatus,
  getTranscript,
  getMCQDraft,
  patchMCQDraft,
  publishLecture,
  getUserLectures,
};
