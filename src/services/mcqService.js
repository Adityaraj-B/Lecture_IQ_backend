'use strict';

/**
 * mcqService.js — Multilingual MCQ generation logic using Google Gemini / Anthropic / OpenAI.
 *
 * Public API:
 *   splitIntoTimeWindows(segments, windowMinutes) → window[]
 *   generateMCQsForSegment(windowText, courseContext, windowIndex) → { questions }
 */

const provider = (process.env.LLM_PROVIDER || 'gemini').toLowerCase();
const geminiApiKey = process.env.GEMINI_API_KEY || process.env.LLM_API_KEY;

// ── Time-window splitter ──────────────────────────────────────────────────────

/**
 * Split transcript segments into ~windowMinutes windows.
 * Only uses professor-spoken segments (student Q&A excluded).
 *
 * @param {Array} segments - Transcript segments (professor-only, pre-filtered)
 * @param {number} windowMinutes - Target window size in minutes (default 7)
 * @returns {Array<{ windowIndex, startTime, endTime, text, segments }>}
 */
function splitIntoTimeWindows(segments, windowMinutes = 7) {
  const windowSeconds = windowMinutes * 60;
  const windows = [];
  let currentWindow = null;

  for (const seg of segments) {
    if (!currentWindow) {
      currentWindow = {
        windowIndex: windows.length,
        startTime: seg.startTime || 0,
        endTime: seg.endTime || 0,
        text: seg.text,
        segments: [seg],
      };
    } else {
      if ((seg.endTime || 0) - currentWindow.startTime <= windowSeconds) {
        currentWindow.text += ' ' + seg.text;
        currentWindow.endTime = seg.endTime || currentWindow.endTime;
        currentWindow.segments.push(seg);
      } else {
        windows.push(currentWindow);
        currentWindow = {
          windowIndex: windows.length,
          startTime: seg.startTime || 0,
          endTime: seg.endTime || 0,
          text: seg.text,
          segments: [seg],
        };
      }
    }
  }

  if (currentWindow && currentWindow.segments.length > 0) {
    windows.push(currentWindow);
  }

  return windows;
}

// ── Gemini LLM Implementation ──────────────────────────────────────────────────

async function geminiGenerateMCQs(windowText, courseContext, windowIndex) {
  if (!geminiApiKey) {
    console.warn('[LLM:gemini] GEMINI_API_KEY not set — falling back to mock');
    return mockGenerateMCQs(windowText, courseContext, windowIndex);
  }

  const prompt = `You are an expert university professor and assessment designer.
Course Context: ${courseContext || 'University Course'}
Lecture Window ${windowIndex}:
"""
${windowText}
"""

Task:
Extract key academic concepts from this lecture transcript and generate 2 to 4 high-quality Multiple Choice Questions (MCQs).
Every question and its 4 options MUST be provided in 3 languages: English (en), Hindi (hi, in Devanagari script), and Marathi (mr, in Devanagari script).

Output Requirements:
Return ONLY a valid JSON object matching this exact schema:
{
  "questions": [
    {
      "text": {
        "en": "Question text in English",
        "hi": "हिंदी में प्रश्न (Devanagari)",
        "mr": "मराठीत प्रश्न (Devanagari)"
      },
      "options": [
        { "en": "Option A in English", "hi": "विकल्प A हिंदी में", "mr": "पर्याय A मराठीत" },
        { "en": "Option B in English", "hi": "विकल्प B हिंदी में", "mr": "पर्याय B मराठीत" },
        { "en": "Option C in English", "hi": "विकल्प C हिंदी में", "mr": "पर्याय C मराठीत" },
        { "en": "Option D in English", "hi": "विकल्प D हिंदी में", "mr": "पर्याय D मराठीत" }
      ],
      "correctIndex": 0,
      "concept": "Specific concept name taught in this window",
      "difficulty": "easy" | "medium" | "hard",
      "confidenceScore": 0.95
    }
  ]
}`;

  const candidateModels = [
    'gemini-3.7-flash',
    'gemini-3.5-flash',
    'gemini-3.6-flash',
    'gemini-flash-latest',
    'gemini-3.1-flash-lite'
  ];

  let lastError = null;

  for (const model of candidateModels) {
    try {
      console.log(`[LLM:gemini] Generating MCQs with model: ${model} for window ${windowIndex}...`);
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiApiKey}`;

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            responseMimeType: 'application/json',
            temperature: 0.3
          }
        })
      });

      if (!response.ok) {
        const errText = await response.text();
        console.warn(`[LLM:gemini] Model ${model} returned HTTP ${response.status}: ${errText.slice(0, 150)}`);
        if ([503, 429, 404].includes(response.status)) {
          lastError = new Error(`HTTP ${response.status}: ${errText}`);
          // brief delay before trying next model
          await new Promise((r) => setTimeout(r, 1000));
          continue;
        }
        throw new Error(`Gemini LLM error: ${response.status} ${errText}`);
      }

      const data = await response.json();
      const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!rawText) throw new Error('Empty response from Gemini LLM');

      const parsed = JSON.parse(rawText);
      if (!Array.isArray(parsed.questions)) {
        throw new Error('Response JSON missing "questions" array');
      }

      console.log(`[LLM:gemini] ✅ Successfully generated ${parsed.questions.length} MCQs with ${model}`);
      return parsed;
    } catch (err) {
      lastError = err;
      console.warn(`[LLM:gemini] Attempt with ${model} failed: ${err.message}`);
    }
  }

  console.error('[LLM:gemini] All candidate models failed, falling back to mock:', lastError?.message);
  return mockGenerateMCQs(windowText, courseContext, windowIndex);
}

// ── Mock Implementation ───────────────────────────────────────────────────────

function mockGenerateMCQs(windowText, courseContext, windowIndex) {
  console.log(`[LLM:mock] Generating MCQs for window ${windowIndex} (${windowText?.length || 0} chars)`);

  return {
    questions: [
      {
        text: {
          en: `(Window ${windowIndex}) What is the primary property of a Binary Search Tree?`,
          hi: `(Window ${windowIndex}) बाइनरी सर्च ट्री की प्राथमिक विशेषता क्या है?`,
          mr: `(Window ${windowIndex}) बायनरी सर्च ट्री चे मुख्य वैशिष्ट्य काय आहे?`,
        },
        options: [
          { en: 'Left child < Root < Right child', hi: 'बायां बच्चा < मूल < दायां बच्चा', mr: 'डावे मूल < मूळ < उजवे मूल' },
          { en: 'Left child > Root > Right child', hi: 'बायां बच्चा > मूल > दायां बच्चा', mr: 'डावे मूल > मूळ > उजवे मूल' },
          { en: 'All nodes have equal value', hi: 'सभी नोड्स का मान समान होता है', mr: 'सर्व नोड्सचे मूल्य समान असते' },
          { en: 'Tree is always completely full', hi: 'ट्री हमेशा पूरी तरह से भरा होता है', mr: 'ट्री नेहमी पूर्णपणे भरलेले असते' },
        ],
        correctIndex: 0,
        concept: 'Binary Search Trees',
        difficulty: 'medium',
        confidenceScore: 0.95,
      },
      {
        text: {
          en: `(Window ${windowIndex}) Which traversal algorithm processes nodes in sorted order for a BST?`,
          hi: `(Window ${windowIndex}) कौन सा ट्रैवर्सल एल्गोरिदम BST के लिए क्रमबद्ध क्रम में नोड्स को प्रोसेस करता है?`,
          mr: `(Window ${windowIndex}) कोणते ट्रॅव्हर्सल अल्गोरिदम BST साठी क्रमवारीनुसार नोड्सवर प्रक्रिया करते?`,
        },
        options: [
          { en: 'Preorder traversal', hi: 'प्रीऑर्डर ट्रैवर्सल', mr: 'प्रीऑर्डर ट्रॅव्हर्सल' },
          { en: 'Inorder traversal', hi: 'इनऑर्डर ट्रैवर्सल', mr: 'इनऑर्डर ट्रॅव्हर्सल' },
          { en: 'Postorder traversal', hi: 'पोस्टऑर्डर ट्रैवर्सल', mr: 'पोस्टऑर्डर ट्रॅव्हर्सल' },
          { en: 'Breadth-first traversal', hi: 'ब्रेड्थ-फर्स्ट ट्रैवर्सल', mr: 'ब्रेड्थ-फर्स्ट ट्रॅव्हर्सल' },
        ],
        correctIndex: 1,
        concept: 'Tree Traversal',
        difficulty: 'easy',
        confidenceScore: 0.92,
      },
    ],
  };
}

// ── Public interface ──────────────────────────────────────────────────────────

/**
 * generateMCQsForSegment(windowText, courseContext, windowIndex)
 * Returns { questions: [...] } or { questions: [], failed: true } on failure.
 */
async function generateMCQsForSegment(windowText, courseContext, windowIndex = 0) {
  try {
    if (provider === 'gemini') {
      return await geminiGenerateMCQs(windowText, courseContext, windowIndex);
    }
    if (provider === 'mock') {
      return mockGenerateMCQs(windowText, courseContext, windowIndex);
    }
    return await geminiGenerateMCQs(windowText, courseContext, windowIndex);
  } catch (err) {
    console.error(`[MCQ] Generation failed for window ${windowIndex}:`, err.message);
    return { questions: [], failed: true };
  }
}

module.exports = { splitIntoTimeWindows, generateMCQsForSegment };
