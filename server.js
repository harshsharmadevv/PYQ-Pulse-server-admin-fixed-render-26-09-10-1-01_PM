require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const app = express();

const PORT = Number(process.env.PORT || 4000);
const HOST = process.env.HOST || '0.0.0.0';

const SUPABASE_URL = process.env.SUPABASE_URL || '';

const SUPABASE_ADMIN_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZlbGl1a3dvc3ZqaWpuenNjanZpIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4NjMwMTI0NywiZXhwIjoyMTAxODc3MjQ3fQ.Kgm3F-KMXnlUpwei5EJsPxPeNPSQtnWC0qGPvE2H7L8";

if (!SUPABASE_URL || !SUPABASE_ADMIN_KEY) {
  throw new Error(
    'SUPABASE_URL and SUPABASE_SECRET_KEY are required. Do not use the Supabase anon/publishable key.'
  );
}

const supabaseAdmin = createClient(
  SUPABASE_URL,
  SUPABASE_ADMIN_KEY,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  }
);

const MEDIA_BUCKET = process.env.SUPABASE_MEDIA_BUCKET || 'pyq-pulse-media';
let mediaBucketReady = null;

/*
|--------------------------------------------------------------------------
| Express
|--------------------------------------------------------------------------
*/

app.disable('x-powered-by');
app.disable('etag');

// Admin data must always be fetched fresh. This also prevents stale 304
// responses from making the admin panel display an older exam name.
app.use('/api/admin', (req, res, next) => {
  res.setHeader(
    'Cache-Control',
    'no-store, no-cache, must-revalidate, proxy-revalidate'
  );
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Surrogate-Control', 'no-store');
  next();
});

app.use(helmet());

app.use(
  cors({
    origin:
      process.env.CORS_ORIGIN === '*' || !process.env.CORS_ORIGIN
        ? true
        : process.env.CORS_ORIGIN
            .split(',')
            .map((x) => x.trim()),
    credentials: true,
  })
);

app.use(express.json({ limit: '1mb' }));
app.use(morgan('dev'));

/*
|--------------------------------------------------------------------------
| Helpers
|--------------------------------------------------------------------------
*/

const now = () => new Date().toISOString();

const id = (prefix) =>
  `${prefix}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;

function response(res, data, status = 200) {
  return res.status(status).json({
    success: true,
    data,
  });
}

function error(res, status, message, code) {
  return res.status(status).json({
    success: false,
    message,
    ...(code ? { code } : {}),
  });
}

function number(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function bool(value) {
  return value === true;
}

function getAdminEmails() {
  return [
    ...new Set(
      String(process.env.ADMIN_EMAILS || '')
        .split(',')
        .map((email) => email.trim().toLowerCase())
        .filter(Boolean)
    ),
  ];
}

function isAdminEmail(email) {
  const adminEmails = getAdminEmails();
  return adminEmails.length > 0 &&
    adminEmails.includes(String(email || '').trim().toLowerCase());
}

/*
|--------------------------------------------------------------------------
| Supabase Media Storage
|--------------------------------------------------------------------------
*/

async function ensureMediaBucket() {
  if (!mediaBucketReady) {
    mediaBucketReady = (async () => {
      const { data: buckets, error: listError } = await supabaseAdmin.storage.listBuckets();
      if (listError) throw listError;
      const existing = (buckets || []).find((b) => b.name === MEDIA_BUCKET);
      if (existing) {
        if (existing.public === false) {
          console.warn(
            `[ADMIN MEDIA] Bucket ${MEDIA_BUCKET} exists but is private; public image URLs may not work.`
          );
        }
        return;
      }
      const { error: createError } = await supabaseAdmin.storage.createBucket(MEDIA_BUCKET, {
        public: true,
        fileSizeLimit: '10MB',
      });
      if (createError && !/already exists/i.test(String(createError.message || ''))) throw createError;
    })().catch((e) => { mediaBucketReady = null; throw e; });
  }
  return mediaBucketReady;
}

function parseMultipart(req, maxBytes = 10 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const contentType = String(req.headers['content-type'] || '');

    const match = contentType.match(
      /boundary=(?:"([^"]+)"|([^;]+))/i
    );

    if (!match) {
      return reject(
        Object.assign(
          new Error('Invalid multipart request.'),
          { status: 400 }
        )
      );
    }

    const boundaryValue = match[1] || match[2];
    const boundary = Buffer.from(`--${boundaryValue}`);

    const chunks = [];
    let size = 0;
    let settled = false;

    const fail = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    req.on('data', (chunk) => {
      if (settled) return;

      size += chunk.length;

      if (size > maxBytes) {
        return fail(
          Object.assign(
            new Error('Image is too large. Maximum size is 10MB.'),
            { status: 413 }
          )
        );
      }

      chunks.push(chunk);
    });

    req.on('error', fail);

    req.on('end', () => {
      if (settled) return;

      try {
        const buffer = Buffer.concat(chunks);
        const parts = [];

        let cursor = 0;

        while (true) {
          const start = buffer.indexOf(boundary, cursor);

          if (start < 0) break;

          const next = buffer.indexOf(
            boundary,
            start + boundary.length
          );

          if (next < 0) break;

          let part = buffer.slice(
            start + boundary.length,
            next
          );

          // Remove CRLF before part
          if (
            part.length >= 2 &&
            part.subarray(0, 2).equals(
              Buffer.from('\r\n')
            )
          ) {
            part = part.subarray(2);
          }

          // Remove CRLF after content
          if (
            part.length >= 2 &&
            part.subarray(-2).equals(
              Buffer.from('\r\n')
            )
          ) {
            part = part.subarray(0, -2);
          }

          // Ignore terminating boundary
          if (
            part.length >= 2 &&
            part.subarray(0, 2).equals(
              Buffer.from('--')
            )
          ) {
            break;
          }

          const separator = Buffer.from(
            '\r\n\r\n'
          );

          const split = part.indexOf(separator);

          if (split < 0) {
            cursor = next;
            continue;
          }

          const headerText = part
            .slice(0, split)
            .toString('utf8');

          const content = part.slice(
            split + separator.length
          );

          const dispositionMatch =
            headerText.match(
              /Content-Disposition:\s*form-data;\s*([^\r\n]+)/i
            );

          const disposition =
            dispositionMatch?.[1] || '';

          const nameMatch =
            disposition.match(
              /name="([^"]+)"/i
            );

          const filenameMatch =
            disposition.match(
              /filename="([^"]*)"/i
            );

          const name =
            nameMatch?.[1] || '';

          const filename =
            filenameMatch?.[1] || '';

          const typeMatch =
            headerText.match(
              /Content-Type:\s*([^\r\n]+)/i
            );

          const type =
            typeMatch?.[1]?.trim() ||
            'application/octet-stream';

          if (name) {
            parts.push({
              name,
              filename,
              type,
              data: content,
            });
          }

          cursor = next;
        }

        settled = true;
        resolve(parts);
      } catch (e) {
        fail(e);
      }
    });
  });
}

function safeFileExtension(filename, contentType) {
  const ext = String(filename || '')
    .split('.')
    .pop()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

  if (ext && ext.length <= 8) {
    return ext;
  }

  const byType = {
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/svg+xml': 'svg',
    'image/avif': 'avif',
    'image/bmp': 'bmp',
    'image/x-icon': 'ico',
  };

  return byType[
    String(contentType || '').toLowerCase()
  ] || 'jpg';
}

async function uploadAdminImage(req, res) {
  try {
    await ensureMediaBucket();

    const parts = await parseMultipart(req);

    /*
     * Accept all normal admin image field names.
     * This makes the endpoint compatible with:
     * file / image / logo / banner
     */
    const imageFieldNames = new Set([
      'file',
      'image',
      'logo',
      'banner',
    ]);

    const file = parts.find(
      (p) =>
        imageFieldNames.has(
          String(p.name || '').toLowerCase()
        ) &&
        p.data &&
        p.data.length > 0
    );

    const folderPart = parts.find(
      (p) =>
        String(p.name || '').toLowerCase() ===
        'folder'
    );

    const folder =
      (
        folderPart?.data
          ?.toString('utf8')
          .trim() || 'general'
      )
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, '-')
        .slice(0, 40) || 'general';

    if (!file) {
      return error(
        res,
        400,
        'Image file is required.',
        'image_required'
      );
    }

    const contentType = String(
      file.type || ''
    ).toLowerCase();

    if (!contentType.startsWith('image/')) {
      return error(
        res,
        400,
        'Only image files are allowed.',
        'invalid_image_type'
      );
    }

    /*
     * Some FormData implementations may not provide
     * filename correctly. Extension will therefore
     * safely fall back to Content-Type.
     */
    const extension = safeFileExtension(
      file.filename,
      contentType
    );

    const objectPath =
      `${folder}/${Date.now()}-${crypto.randomUUID()}.${extension}`;

    const {
      error: uploadError,
    } = await supabaseAdmin.storage
      .from(MEDIA_BUCKET)
      .upload(
        objectPath,
        file.data,
        {
          contentType,
          upsert: false,
          cacheControl: '31536000',
        }
      );

    if (uploadError) {
      throw uploadError;
    }

    const {
      data: publicUrlData,
    } =
      supabaseAdmin.storage
        .from(MEDIA_BUCKET)
        .getPublicUrl(objectPath);

    return response(
      res,
      {
        url: publicUrlData.publicUrl,
        path: objectPath,
        bucket: MEDIA_BUCKET,
      },
      201
    );
  } catch (e) {
    console.error(
      '[ADMIN MEDIA UPLOAD ERROR]',
      e
    );

    return adminFail(
      res,
      e,
      'admin_image_upload_error'
    );
  }
}

/*
|--------------------------------------------------------------------------
| Authentication - Admin
|--------------------------------------------------------------------------
*/

async function auth(req, res, next) {
  try {
    const header = String(req.get('authorization') || '').trim();
    const match = header.match(/^Bearer\s+(.+)$/i);

    if (!match) {
      return error(res, 401, 'Authorization required.', 'auth_required');
    }

    const token = match[1].trim();
    if (!token) {
      return error(res, 401, 'Invalid or expired token.', 'auth_invalid');
    }

    const { data, error: authError } =
      await supabaseAdmin.auth.getUser(token);

    if (authError || !data?.user) {
      return error(res, 401, 'Invalid or expired token.', 'auth_invalid');
    }

    req.user = {
      id: data.user.id,
      email: data.user.email || null,
      name: data.user.user_metadata?.name || null,
    };

    return next();
  } catch (e) {
    console.error('User auth error:', e.message);
    return error(res, 401, 'Invalid authentication.', 'auth_invalid');
  }
}

async function adminAuth(req, res, next) {
  return auth(req, res, () => {
    if (!getAdminEmails().length) {
      console.error('ADMIN_EMAILS is not configured.');
      return error(
        res,
        503,
        'Admin access is not configured on the server.',
        'admin_not_configured'
      );
    }

    if (!isAdminEmail(req.user?.email)) {
      return error(res, 403, 'Admin access required.', 'admin_forbidden');
    }

    return next();
  });
}


/*
|--------------------------------------------------------------------------
| Profile
|--------------------------------------------------------------------------
*/

async function getProfile(userId) {
  const { data, error: dbError } = await supabaseAdmin
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .maybeSingle();

  if (dbError) throw dbError;

  return data;
}

/*
|--------------------------------------------------------------------------
| Question Mapping
|--------------------------------------------------------------------------
*/

function mapQuestion(row, options = {}) {
  const {
    includeAnswer = false,
    userState = {},
    answerState = null,
  } = options;

  const question = {
    id: row.id,

    questionId: row.question_id,
    stem: row.stem,
    questionType: row.question_type,
    difficulty: row.difficulty,
    sourceYear: row.source_year,
    examName: row.exam_name,

    examId: row.exam_id,
    subjectId: row.subject_id,
    topicId: row.topic_id,

    options: row.options || {},
    explanation: row.explanation || null,

    imageUrl: row.image_url || null,
    hasImage: Boolean(row.has_image),

    isBookmarked: Boolean(userState.isBookmarked),
    markedForReview: Boolean(userState.markedForReview),
    inRevisionQueue: Boolean(userState.inRevisionQueue),

    sources: userState.sources || [],
  };

  // Never expose the correct answer while the session is active.
  if (includeAnswer) {
    question.correctOption = row.correct_option;

    // The app uses the persisted session_answers as the source of truth
    // after submission. Keep the scoring metadata together with the result.
    question.correctMarks = 4;
    question.negativeMarks = 1;
    question.skipMarks = 0;

    if (answerState) {
      question.isCorrect =
        answerState.is_correct === null ||
        answerState.is_correct === undefined
          ? null
          : Boolean(answerState.is_correct);
      question.marksAwarded = Number(answerState.marks || 0);
      question.answeredAt = answerState.answered_at || null;
    } else {
      question.isCorrect = null;
      question.marksAwarded = 0;
      question.answeredAt = null;
    }
  }

  return question;
}

/*
|--------------------------------------------------------------------------
| User Question State
|--------------------------------------------------------------------------
*/

async function getUserQuestionStates(userId, questionIds = []) {
  if (!questionIds.length) {
    return {};
  }

  const result = {};

  questionIds.forEach((id) => {
    result[id] = {
      isBookmarked: false,
      markedForReview: false,
      inRevisionQueue: false,
      sources: [],
    };
  });

  const { data: bookmarks, error: bookmarkError } =
    await supabaseAdmin
      .from('bookmarks')
      .select('question_id')
      .eq('user_id', userId)
      .in('question_id', questionIds);

  if (bookmarkError) throw bookmarkError;

  for (const row of bookmarks || []) {
    if (result[row.question_id]) {
      result[row.question_id].isBookmarked = true;
      result[row.question_id].sources.push('bookmarks');
    }
  }

  const { data: marks, error: marksError } =
    await supabaseAdmin
      .from('revision_marks')
      .select('question_id, marked')
      .eq('user_id', userId)
      .eq('marked', true)
      .in('question_id', questionIds);

  if (marksError) throw marksError;

  for (const row of marks || []) {
    if (result[row.question_id]) {
      result[row.question_id].markedForReview = true;
      result[row.question_id].inRevisionQueue = true;
      result[row.question_id].sources.push('manual');
    }
  }

  const { data: revisionQuestions, error: revisionError } =
    await supabaseAdmin
      .from('revision_questions')
      .select('question_id, source')
      .eq('user_id', userId)
      .in('question_id', questionIds);

  if (revisionError) throw revisionError;

  for (const row of revisionQuestions || []) {
    if (!result[row.question_id]) continue;

    result[row.question_id].inRevisionQueue = true;

    if (row.source && !result[row.question_id].sources.includes(row.source)) {
      result[row.question_id].sources.push(row.source);
    }
  }

  const { data: wrongQuestions, error: wrongError } =
    await supabaseAdmin
      .from('wrong_questions')
      .select('question_id')
      .eq('user_id', userId)
      .in('question_id', questionIds);

  if (wrongError) throw wrongError;

  for (const row of wrongQuestions || []) {
    if (result[row.question_id]) {
      result[row.question_id].sources.push('wrong');
    }
  }

  const { data: weakTopics, error: weakError } =
    await supabaseAdmin
      .from('weak_topics')
      .select('question_id')
      .eq('user_id', userId)
      .in('question_id', questionIds);

  if (weakError) throw weakError;

  for (const row of weakTopics || []) {
    if (row.question_id && result[row.question_id]) {
      result[row.question_id].sources.push('weak_topics');
    }
  }

  for (const key of Object.keys(result)) {
    result[key].sources = [
      ...new Set(result[key].sources),
    ];
  }

  return result;
}

/*
|--------------------------------------------------------------------------
| Revision Summary
|--------------------------------------------------------------------------
*/

async function revisionSummary(userId) {
  const [
    wrongResult,
    bookmarkResult,
    weakResult,
    manualResult,
  ] = await Promise.all([
    supabaseAdmin
      .from('wrong_questions')
      .select('question_id')
      .eq('user_id', userId),

    supabaseAdmin
      .from('bookmarks')
      .select('question_id')
      .eq('user_id', userId),

    supabaseAdmin
      .from('weak_topics')
      .select('question_id, topic_id')
      .eq('user_id', userId),

    supabaseAdmin
      .from('revision_marks')
      .select('question_id')
      .eq('user_id', userId)
      .eq('marked', true),
  ]);

  if (wrongResult.error) throw wrongResult.error;
  if (bookmarkResult.error) throw bookmarkResult.error;
  if (weakResult.error) throw weakResult.error;
  if (manualResult.error) throw manualResult.error;

  const wrong = new Set(
    (wrongResult.data || []).map((x) => x.question_id)
  );

  const bookmarks = new Set(
    (bookmarkResult.data || []).map((x) => x.question_id)
  );

  const weak = new Set(
    (weakResult.data || [])
      .filter((x) => x.question_id)
      .map((x) => x.question_id)
  );

  const manual = new Set(
    (manualResult.data || []).map((x) => x.question_id)
  );

  const total = new Set([
    ...wrong,
    ...bookmarks,
    ...weak,
    ...manual,
  ]);

  return {
    wrongQuestions: wrong.size,
    bookmarks: bookmarks.size,
    weakTopics: weak.size,
    manualRevisionMarks: manual.size,
    total: total.size,
  };
}

/*
|--------------------------------------------------------------------------
| Revision Queue
|--------------------------------------------------------------------------
*/

async function queueFor(userId, sources) {
  const wanted = new Set();

  const normalized = Array.isArray(sources) && sources.length
    ? sources
    : ['wrong'];

  if (
    normalized.includes('wrong') ||
    normalized.includes('mixed')
  ) {
    const { data, error: dbError } = await supabaseAdmin
      .from('wrong_questions')
      .select('question_id')
      .eq('user_id', userId);

    if (dbError) throw dbError;

    for (const row of data || []) {
      wanted.add(row.question_id);
    }
  }

  if (
    normalized.includes('bookmarks') ||
    normalized.includes('mixed')
  ) {
    const { data, error: dbError } = await supabaseAdmin
      .from('bookmarks')
      .select('question_id')
      .eq('user_id', userId);

    if (dbError) throw dbError;

    for (const row of data || []) {
      wanted.add(row.question_id);
    }
  }

  if (
    normalized.includes('weak_topics') ||
    normalized.includes('mixed')
  ) {
    const { data, error: dbError } = await supabaseAdmin
      .from('weak_topics')
      .select('question_id')
      .eq('user_id', userId)
      .not('question_id', 'is', null);

    if (dbError) throw dbError;

    for (const row of data || []) {
      if (row.question_id) wanted.add(row.question_id);
    }
  }

  if (
    normalized.includes('manual') ||
    normalized.includes('mixed')
  ) {
    const { data, error: dbError } = await supabaseAdmin
      .from('revision_marks')
      .select('question_id')
      .eq('user_id', userId)
      .eq('marked', true);

    if (dbError) throw dbError;

    for (const row of data || []) {
      wanted.add(row.question_id);
    }
  }

  if (!wanted.size) {
    return [];
  }

  const ids = [...wanted];

  const { data: questions, error: questionError } =
    await supabaseAdmin
      .from('questions')
      .select('*')
      .in('id', ids);

  if (questionError) throw questionError;

  const states = await getUserQuestionStates(userId, ids);

  return (questions || []).map((question) =>
    mapQuestion(question, {
      includeAnswer: false,
      userState: states[question.id],
    })
  );
}

/*
|--------------------------------------------------------------------------
| Session Mapping
|--------------------------------------------------------------------------
*/

async function loadSession(sessionId, userId) {
  const { data: session, error: sessionError } =
    await supabaseAdmin
      .from('sessions')
      .select('*')
      .eq('id', sessionId)
      .eq('user_id', userId)
      .maybeSingle();

  if (sessionError) throw sessionError;

  if (!session) {
    return null;
  }

  const { data: sessionQuestions, error: questionsError } =
    await supabaseAdmin
      .from('session_questions')
      .select(`
        *,
        question:questions(*)
      `)
      .eq('session_id', sessionId)
      .order('position', { ascending: true });

  if (questionsError) throw questionsError;

  const questionIds = (sessionQuestions || []).map(
    (x) => x.question_id
  );

  const states = await getUserQuestionStates(
    userId,
    questionIds
  );

  const includeAnswer =
    session.status === 'COMPLETED' ||
    session.is_submitted === true;

  // Answers are stored separately from session_questions. Joining them here
  // is what makes result/review pages show the real correctness and marks.
  const answerMap = {};
  if (includeAnswer && questionIds.length) {
    const { data: answers, error: answersError } =
      await supabaseAdmin
        .from('session_answers')
        .select('question_id,answer,is_correct,marks,answered_at')
        .eq('session_id', sessionId)
        .in('question_id', questionIds);

    if (answersError) throw answersError;

    for (const answer of answers || []) {
      answerMap[answer.question_id] = answer;
    }
  }

  const questions = (sessionQuestions || []).map((row) => ({
    ...mapQuestion(row.question, {
      includeAnswer,
      userState: states[row.question_id],
      answerState: answerMap[row.question_id] || null,
    }),

    id: row.question.id,
    position: row.position,

    userAnswer:
      row.user_answer !== null && row.user_answer !== undefined
        ? row.user_answer
        : answerMap[row.question_id]?.answer ?? null,
    markedForReview: Boolean(row.marked_for_review),
    isBookmarked: Boolean(row.is_bookmarked),
    inRevisionQueue: Boolean(row.in_revision_queue),

    timeSpent: row.time_spent || 0,
  }));

  return {
    id: session.id,
    mode: session.mode,
    setId: session.set_id,
    setName: session.set_name,
    sessionType: session.session_type,

    status: session.status,

    startedAt: session.started_at,
    submittedAt: session.submitted_at,
    lastActivityAt: session.last_activity_at,

    durationSeconds: session.duration_seconds,
    timeSpent: session.time_spent,

    totalQuestions: session.total_questions,
    answeredQuestions: session.answered_questions,

    isSubmitted: session.is_submitted,

    result:
      session.score !== null
        ? {
            score: session.score,
            percentage: Number(session.percentage || 0),
            totalQuestions: session.total_questions,
            totalCorrect: session.total_correct || 0,
            totalWrong: session.total_wrong || 0,
            totalUnanswered: session.total_unanswered || 0,
          }
        : null,

    questions,
  };
}

/*
|--------------------------------------------------------------------------
| History
|--------------------------------------------------------------------------
*/

function historyFromSession(s) {
  return {
    id: s.id,
    setId: s.set_id,
    setName: s.set_name,
    sessionType: s.session_type,
    mode: s.mode,
    status: s.status,

    startedAt: s.started_at,
    submittedAt: s.submitted_at || null,
    lastActivityAt:
      s.last_activity_at ||
      s.submitted_at ||
      s.started_at,

    durationSeconds: s.duration_seconds,
    timeSpent: s.time_spent || 0,

    totalQuestions: s.total_questions,
    answeredQuestions: s.answered_questions,

    score: s.score ?? null,
    percentage:
      s.percentage !== null
        ? Number(s.percentage)
        : null,
  };
}

/*
|--------------------------------------------------------------------------
| Create Session
|--------------------------------------------------------------------------
*/

async function makeSession(
  userId,
  questionIds,
  mode = 'practice',
  sessionType = 'set_based',
  body = {}
) {
  const uniqueQuestionIds = [
    ...new Set(questionIds),
  ];

  if (!uniqueQuestionIds.length) {
    throw new Error('No questions available.');
  }

  const { data: questions, error: questionError } =
    await supabaseAdmin
      .from('questions')
      .select('*')
      .in('id', uniqueQuestionIds);

  if (questionError) throw questionError;

  if (!questions?.length) {
    throw new Error('No valid questions found.');
  }

  const questionMap = new Map(
    questions.map((q) => [q.id, q])
  );

  const orderedQuestions = uniqueQuestionIds
    .map((qid) => questionMap.get(qid))
    .filter(Boolean);

  const setId = body.setId || null;

  let setName = null;

  if (setId) {
    const { data: set, error: setError } =
      await supabaseAdmin
        .from('sets')
        .select('id, name')
        .eq('id', setId)
        .maybeSingle();

    if (setError) throw setError;

    setName = set?.name || null;
  }

  if (!setName) {
    setName =
      mode === 'review'
        ? 'Revision queue'
        : 'Practice session';
  }

  const durationSeconds = Math.max(
    0,
    number(body.durationSeconds, 1800)
  );

  const { data: session, error: sessionError } =
    await supabaseAdmin
      .from('sessions')
      .insert({
        user_id: userId,

        mode,
        set_id: setId,
        set_name: setName,

        session_type: sessionType,
        status: 'IN_PROGRESS',

        started_at: now(),
        last_activity_at: now(),

        duration_seconds: durationSeconds,

        total_questions: orderedQuestions.length,
        answered_questions: 0,

        is_submitted: false,
      })
      .select('*')
      .single();

  if (sessionError) throw sessionError;

  const sessionRows = orderedQuestions.map(
    (question, index) => ({
      session_id: session.id,
      question_id: question.id,
      position: index + 1,
      user_answer: null,
      marked_for_review: false,
      is_bookmarked: false,
      in_revision_queue: false,
      time_spent: 0,
    })
  );

  const { error: insertQuestionsError } =
    await supabaseAdmin
      .from('session_questions')
      .insert(sessionRows);

  if (insertQuestionsError) {
    await supabaseAdmin
      .from('sessions')
      .delete()
      .eq('id', session.id);

    throw insertQuestionsError;
  }

  return loadSession(session.id, userId);
}

/*
|--------------------------------------------------------------------------
| Answer
|--------------------------------------------------------------------------
*/

async function resolveQuestionId(value) {
  const input = String(value || '').trim();
  if (!input) return null;

  const byPublicId = await supabaseAdmin
    .from('questions')
    .select('id, question_id')
    .eq('question_id', input)
    .limit(1)
    .maybeSingle();

  if (byPublicId.error) throw byPublicId.error;
  if (byPublicId.data) return byPublicId.data;

  const byUuid = await supabaseAdmin
    .from('questions')
    .select('id, question_id')
    .eq('id', input)
    .limit(1)
    .maybeSingle();

  if (byUuid.error) throw byUuid.error;
  return byUuid.data || null;
}

async function applyAnswer(
  sessionId,
  userId,
  body
) {
  if (!body?.questionId) {
    throw new Error('questionId is required.');
  }

  // Accept both the public question_id and internal UUID.
  const question = await resolveQuestionId(body.questionId);

  if (!question) {
    throw new Error('Unknown questionId.');
  }

  const { data: sessionQuestion, error: sessionQuestionError } =
    await supabaseAdmin
      .from('session_questions')
      .select('*')
      .eq('session_id', sessionId)
      .eq('question_id', question.id)
      .maybeSingle();

  if (sessionQuestionError) throw sessionQuestionError;

  if (!sessionQuestion) {
    throw new Error(
      'Question does not belong to this session.'
    );
  }

  const update = {};

  if (
    Object.prototype.hasOwnProperty.call(
      body,
      'answer'
    )
  ) {
    update.user_answer = body.answer;
  }

  if (
    Object.prototype.hasOwnProperty.call(
      body,
      'markedForReview'
    )
  ) {
    update.marked_for_review =
      body.markedForReview === true;

    const { error } = await supabaseAdmin
      .from('revision_marks')
      .upsert(
        {
          user_id: userId,
          question_id: question.id,
          marked: body.markedForReview === true,
          updated_at: now(),
        },
        {
          onConflict: 'user_id,question_id',
        }
      );

    if (error) throw error;

    if (body.markedForReview === true) {
      await supabaseAdmin
        .from('revision_questions')
        .upsert(
          {
            user_id: userId,
            question_id: question.id,
            source: 'manual',
          },
          {
            onConflict:
              'user_id,question_id,source',
          }
        );
    }
  }

  const bookmarkValue =
    Object.prototype.hasOwnProperty.call(
      body,
      'bookmarked'
    )
      ? body.bookmarked
      : body.bookmark;

  if (bookmarkValue !== undefined) {
    update.is_bookmarked =
      bookmarkValue === true;

    if (bookmarkValue === true) {
      const { error } = await supabaseAdmin
        .from('bookmarks')
        .upsert(
          {
            user_id: userId,
            question_id: question.id,
          },
          {
            onConflict: 'user_id,question_id',
          }
        );

      if (error) throw error;
    } else {
      const { error } = await supabaseAdmin
        .from('bookmarks')
        .delete()
        .eq('user_id', userId)
        .eq('question_id', question.id);

      if (error) throw error;
    }
  }

  if (
    Object.prototype.hasOwnProperty.call(
      body,
      'inRevisionQueue'
    )
  ) {
    update.in_revision_queue =
      body.inRevisionQueue === true;
  }

  if (typeof body.timeSpent === 'number') {
    update.time_spent = Math.max(
      0,
      Math.floor(body.timeSpent)
    );
  }

  if (Object.keys(update).length > 0) {
    const { error: updateError } =
      await supabaseAdmin
        .from('session_questions')
        .update(update)
        .eq('id', sessionQuestion.id);

    if (updateError) throw updateError;
  }

  /*
   * Keep session answer table synchronized.
   */
  if (
    Object.prototype.hasOwnProperty.call(
      body,
      'answer'
    )
  ) {
    const { data: questionFull, error: qError } =
      await supabaseAdmin
        .from('questions')
        .select('correct_option')
        .eq('id', question.id)
        .single();

    if (qError) throw qError;

    const answer = body.answer;
    const isCorrect =
      answer != null &&
      answer === questionFull.correct_option;

    const marks = answer == null
      ? 0
      : isCorrect
        ? 4
        : -1;

    const { error: answerError } =
      await supabaseAdmin
        .from('session_answers')
        .upsert(
          {
            session_id: sessionId,
            question_id: question.id,
            answer: answer,
            is_correct:
              answer == null ? null : isCorrect,
            marks,
            answered_at: now(),
          },
          {
            onConflict:
              'session_id,question_id',
          }
        );

    if (answerError) throw answerError;
  }

  const { count: answeredCount, error: countError } =
    await supabaseAdmin
      .from('session_questions')
      .select('*', {
        count: 'exact',
        head: true,
      })
      .eq('session_id', sessionId)
      .not('user_answer', 'is', null);

  if (countError) throw countError;

  const { error: sessionUpdateError } =
    await supabaseAdmin
      .from('sessions')
      .update({
        answered_questions: answeredCount || 0,
        last_activity_at: now(),
      })
      .eq('id', sessionId)
      .eq('user_id', userId);

  if (sessionUpdateError) throw sessionUpdateError;

  return loadSession(sessionId, userId);
}

/*
|--------------------------------------------------------------------------
| Submit Session
|--------------------------------------------------------------------------
*/

async function saveWrongQuestion(userId, questionId) {
  const { data: existing, error: lookupError } = await supabaseAdmin
    .from('wrong_questions')
    .select('id, attempt_count')
    .eq('user_id', userId)
    .eq('question_id', questionId)
    .limit(1)
    .maybeSingle();

  if (lookupError) throw lookupError;

  if (existing) {
    const { error: updateError } = await supabaseAdmin
      .from('wrong_questions')
      .update({
        attempt_count: Number(existing.attempt_count || 0) + 1,
        last_wrong_at: now(),
      })
      .eq('id', existing.id);

    if (updateError) throw updateError;
    return;
  }

  const { error: insertError } = await supabaseAdmin
    .from('wrong_questions')
    .insert({
      user_id: userId,
      question_id: questionId,
      attempt_count: 1,
      last_wrong_at: now(),
    });

  if (insertError) throw insertError;
}

async function submitSession(sessionId, userId) {
  const { data: session, error: sessionError } =
    await supabaseAdmin
      .from('sessions')
      .select('*')
      .eq('id', sessionId)
      .eq('user_id', userId)
      .single();

  if (sessionError) throw sessionError;

  if (session.is_submitted) {
    return loadSession(sessionId, userId);
  }

  const { data: rows, error: rowsError } =
    await supabaseAdmin
      .from('session_questions')
      .select(`
        *,
        question:questions(
          id,
          question_id,
          correct_option
        )
      `)
      .eq('session_id', sessionId)
      .order('position', {
        ascending: true,
      });

  if (rowsError) throw rowsError;

  let correct = 0;
  let wrong = 0;
  let unanswered = 0;
  let timeSpent = 0;

  for (const row of rows || []) {
    timeSpent += Number(row.time_spent || 0);

    if (row.user_answer == null) {
      unanswered++;
      continue;
    }

    const isCorrect =
      row.user_answer ===
      row.question.correct_option;

    if (isCorrect) {
      correct++;
    } else {
      wrong++;

      await saveWrongQuestion(userId, row.question_id);
    }
  }

  const total = rows?.length || 0;

  const score =
    correct * 4 - wrong;

  const percentage =
    total > 0
      ? Math.round(
          (correct / total) * 100
        )
      : 0;

  /*
   * Update session.
   */
  const { error: updateError } =
    await supabaseAdmin
      .from('sessions')
      .update({
        status: 'COMPLETED',
        is_submitted: true,

        submitted_at: now(),
        last_activity_at: now(),

        answered_questions:
          correct + wrong,

        time_spent: timeSpent,

        score,
        percentage,

        total_correct: correct,
        total_wrong: wrong,
        total_unanswered: unanswered,
      })
      .eq('id', sessionId)
      .eq('user_id', userId);

  if (updateError) throw updateError;

  /*
   * Save final answers / marks.
   */
  for (const row of rows || []) {
    if (row.user_answer == null) continue;

    const isCorrect =
      row.user_answer ===
      row.question.correct_option;

    const { error: answerError } = await supabaseAdmin
      .from('session_answers')
      .upsert(
        {
          session_id: sessionId,
          question_id: row.question_id,
          answer: row.user_answer,
          is_correct: isCorrect,
          marks: isCorrect ? 4 : -1,
          answered_at: now(),
        },
        {
          onConflict:
            'session_id,question_id',
        }
      );

    if (answerError) throw answerError;
  }

  return loadSession(sessionId, userId);
}

/*
|--------------------------------------------------------------------------
| HEALTH
|--------------------------------------------------------------------------
*/

app.get('/health', async (req, res) => {
  try {
    const { error: dbError } = await supabaseAdmin
      .from('app_config')
      .select('key')
      .limit(1);

    if (dbError) {
      return res.status(503).json({
        status: 'error',
        service: 'pyq-pulse-express',
        database: 'unavailable',
        time: now(),
      });
    }

    return res.json({
      status: 'ok',
      service: 'pyq-pulse-express',
      database: 'connected',
      time: now(),
      authProvider: 'supabase',
      storageProvider: 'supabase',
    });
  } catch (e) {
    return res.status(503).json({
      status: 'error',
      service: 'pyq-pulse-express',
      database: 'unavailable',
      time: now(),
    });
  }
});

/*
|--------------------------------------------------------------------------
| AUTH
|--------------------------------------------------------------------------
*/

app.post('/auth/login', async (req, res) => {
  try {
    const {
      email,
      password,
    } = req.body || {};

    if (!email || !password) {
      return error(
        res,
        400,
        'Email and password are required.',
        'auth_missing_fields'
      );
    }

    const {
      data,
      error: authError,
    } = await supabaseAdmin.auth.signInWithPassword({
      email,
      password,
    });

    if (
      authError ||
      !data?.session ||
      !data?.user
    ) {
      return error(
        res,
        401,
        authError?.message || 'Login failed.',
        'auth_failed'
      );
    }

    if (!getAdminEmails().length) {
      return error(
        res,
        503,
        'Admin access is not configured on the server.',
        'admin_not_configured'
      );
    }

    if (!isAdminEmail(data.user.email)) {
      return error(
        res,
        403,
        'Admin access required.',
        'admin_forbidden'
      );
    }

    const profile =
      await getProfile(data.user.id);

    return response(res, {
      user: {
        id: data.user.id,
        email: data.user.email,
        name:
          profile?.name ||
          data.user.user_metadata?.name ||
          null,
        avatarUrl:
          profile?.avatar_url || null,
      },

      accessToken:
        data.session.access_token,

      refreshToken:
        data.session.refresh_token,
    });
  } catch (e) {
    console.error(e);

    return error(
      res,
      500,
      e.message,
      'auth_login_error'
    );
  }
});


app.post('/auth/refresh', async (req, res) => {
  try {
    const refreshToken = String(req.body?.refreshToken || '').trim();

    if (!refreshToken) {
      return error(
        res,
        400,
        'Refresh token is required.',
        'auth_refresh_missing'
      );
    }

    const {
      data,
      error: authError,
    } = await supabaseAdmin.auth.refreshSession({
      refresh_token: refreshToken,
    });

    if (
      authError ||
      !data?.session ||
      !data?.user
    ) {
      return error(
        res,
        401,
        authError?.message || 'Session refresh failed.',
        'auth_refresh_failed'
      );
    }

    if (!getAdminEmails().length) {
      return error(
        res,
        503,
        'Admin access is not configured on the server.',
        'admin_not_configured'
      );
    }

    if (!isAdminEmail(data.user.email)) {
      return error(
        res,
        403,
        'Admin access required.',
        'admin_forbidden'
      );
    }

    const profile = await getProfile(data.user.id);

    return response(res, {
      user: {
        id: data.user.id,
        email: data.user.email,
        name:
          profile?.name ||
          data.user.user_metadata?.name ||
          null,
        avatarUrl:
          profile?.avatar_url || null,
      },
      accessToken: data.session.access_token,
      refreshToken: data.session.refresh_token,
    });
  } catch (e) {
    console.error('Auth refresh error:', e);
    return error(
      res,
      401,
      e.message || 'Session refresh failed.',
      'auth_refresh_error'
    );
  }
});

/*
|--------------------------------------------------------------------------
| ADMIN APIs
|--------------------------------------------------------------------------
|
| All admin writes go through the Supabase service-role client after
| adminAuth has verified the Supabase access token + ADMIN_EMAILS.
|
| Contract:
| - Request fields use camelCase.
| - A small snake_case compatibility layer is accepted on writes.
| - Responses are normalized to the same camelCase contract used by
|   the public APIs.
| - Content counters are recalculated after content mutations so the
|   public fetch APIs do not depend on manually maintained counts.
|
*/

// =========================================================
// ADMIN - FORM OPTIONS
// =========================================================

app.get('/api/admin/form-options', adminAuth, async (req, res) => {
  try {
    const [examsResult, subjectsResult, taxonomyResult, setsResult, questionsResult] = await Promise.all([
      supabaseAdmin.from('exams').select('id,name,code').eq('is_active', true).order('display_order', { ascending: true }),
      supabaseAdmin.from('subjects').select('id,name,exam_id').order('display_order', { ascending: true }).order('name', { ascending: true }),
      supabaseAdmin.from('taxonomy_nodes').select('id,name,node_type,subject_id,exam_id,parent_id').order('display_order', { ascending: true }).order('name', { ascending: true }),
      supabaseAdmin.from('sets').select('id,name,exam_id,subject_id,year,set_type,is_published').order('created_at', { ascending: false }).limit(500),
      supabaseAdmin.from('questions').select('id,question_id,stem,exam_id,subject_id,topic_id').order('created_at', { ascending: false }).limit(1000),
    ]);
    for (const r of [examsResult, subjectsResult, taxonomyResult, setsResult, questionsResult]) if (r.error) throw r.error;
    return response(res, { exams: examsResult.data || [], subjects: subjectsResult.data || [], taxonomy: taxonomyResult.data || [], sets: setsResult.data || [], questions: questionsResult.data || [] });
  } catch (e) {
    return adminFail(res, e, 'admin_form_options_error', 500);
  }
});

// =========================================================
// ADMIN - SYSTEM CHECK
// =========================================================
// This endpoint is intentionally authenticated and never returns
// the actual Supabase key. It is useful on Render to distinguish
// authentication problems from a missing/non-privileged admin key.
app.get('/api/admin/system-check', adminAuth, async (req, res) => {
  try {
    const dbResult = await supabaseAdmin
      .from('exams')
      .select('id')
      .limit(1);

    if (dbResult.error) throw dbResult.error;

    const storageResult =
      await supabaseAdmin.storage.listBuckets();

    if (storageResult.error) throw storageResult.error;

    const bucket = (storageResult.data || []).find(
      (item) => item.name === MEDIA_BUCKET
    );

    return response(res, {
      database: {
        ok: true,
      },
      storage: {
        ok: true,
        bucket: MEDIA_BUCKET,
        exists: Boolean(bucket),
      },
      adminKey: {
        configured: true,
        type: SUPABASE_ADMIN_KEY.startsWith('sb_secret_')
          ? 'supabase_secret'
          : 'legacy_service_role',
      },
    });
  } catch (e) {
    console.error('[ADMIN SYSTEM CHECK ERROR]', e);
    return adminFail(res, e, 'admin_system_check_error', 503);
  }
});

// =========================================================
// ADMIN - MEDIA UPLOAD
// =========================================================

app.post('/api/admin/media/upload', adminAuth, uploadAdminImage);

// =========================================================
// ADMIN HELPERS
// =========================================================

function bodyValue(body, camelName, snakeName, fallback = undefined) {
  if (body && body[camelName] !== undefined) return body[camelName];
  if (body && snakeName && body[snakeName] !== undefined) {
    return body[snakeName];
  }
  return fallback;
}

function requiredText(value, field) {
  if (value === undefined || value === null || String(value).trim() === '') {
    const err = new Error(`${field} is required.`);
    err.status = 400;
    err.code = 'missing_field';
    throw err;
  }
  return String(value).trim();
}

function optionalText(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text === '' ? null : text;
}

function nullableNumber(value, fallback = null) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function positiveInt(value, fallback = 1) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 ? n : fallback;
}

function optionalPositiveInt(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 ? n : null;
}

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }
  return Boolean(value);
}

function requireUpdatedRow(data, label = 'Record') {
  if (!data) {
    const err = new Error(`${label} was not found after update.`);
    err.status = 404;
    err.code = 'record_not_found_after_update';
    throw err;
  }
  return data;
}

function adminDbError(e, fallbackCode) {
  const rawMessage = String(e?.message || 'Database operation failed.');
  const isRls =
    e?.code === '42501' ||
    /row-level security policy/i.test(rawMessage) ||
    /violates row-level security/i.test(rawMessage);

  const code = isRls ? 'admin_db_key_not_privileged' : (e?.code || e?.details || fallbackCode);
  const status =
    e?.status ||
    (isRls ? 503 : e?.code === '23505' ? 409 : e?.code === '23503' ? 400 : 500);

  return {
    status,
    message: isRls
      ? 'Admin database access is not using a privileged Supabase Secret/service_role key. Set SUPABASE_SECRET_KEY (sb_secret_...) or SUPABASE_SERVICE_ROLE_KEY to the Supabase service_role key on the Express server, then restart it.'
      : e?.code === '23503'
        ? 'Cannot complete this operation because related records exist. Remove or reassign the related records first.'
        : rawMessage,
    code,
  };
}

function adminFail(res, e, fallbackCode, fallbackStatus = 400) {
  const info = adminDbError(e, fallbackCode);
  return error(
    res,
    info.status || fallbackStatus,
    info.message,
    info.code || fallbackCode
  );
}

function ensureNonEmptyUpdate(update) {
  if (!Object.keys(update).length) {
    const err = new Error('No fields supplied for update.');
    err.status = 400;
    err.code = 'empty_update';
    throw err;
  }
}

function mapExam(row) {
  if (!row) {
    return null;
  }
  return {
    id: row.id ?? null,
    name: row.name ?? null,
    code: row.code ?? null,
    shortName: row.short_name ?? null,
    description: row.description ?? null,
    isActive: Boolean(row.is_active),
    isFeatured: Boolean(row.is_featured),
    displayOrder: Number(row.display_order || 0),
    totalSets: Number(row.total_sets || 0),
    totalQuestionsAvailable: Number(row.total_questions_available || 0),
    freeSets: Number(row.free_sets || 0),
    iconUrl: row.icon_url || null,
    bannerUrl: row.banner_url || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}

function mapSubject(row) {
  return {
    id: row.id,
    name: row.name,
    examId: row.exam_id,
    questionCount: Number(row.question_count || 0),
    nodeType: row.node_type,
    slug: row.slug,
    displayOrder: Number(row.display_order || 0),
    createdAt: row.created_at || null,
  };
}

function mapTaxonomyNode(row) {
  return {
    id: row.id,
    parentId: row.parent_id,
    subjectId: row.subject_id,
    examId: row.exam_id,
    name: row.name,
    nodeType: row.node_type,
    slug: row.slug,
    displayOrder: Number(row.display_order || 0),
    createdAt: row.created_at || null,
  };
}

function mapSet(row) {
  return {
    id: row.id,
    name: row.name,
    examId: row.exam_id,
    subjectId: row.subject_id,
    examName: row.exam_name,
    setType: row.set_type,
    year: row.year,
    totalQuestions: Number(row.total_questions || 0),
    isFree: Boolean(row.is_free),
    isPublished: Boolean(row.is_published),
    accessStatus: row.access_status,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}

function mapQuestionAdmin(row) {
  return {
    id: row.id,
    questionId: row.question_id,
    stem: row.stem,
    questionType: row.question_type,
    difficulty: row.difficulty,
    sourceYear: row.source_year,
    examName: row.exam_name,
    examId: row.exam_id,
    subjectId: row.subject_id,
    topicId: row.topic_id,
    options: row.options || {},
    correctOption: row.correct_option,
    explanation: row.explanation,
    imageUrl: row.image_url,
    hasImage: Boolean(row.has_image),
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}

function mapBanner(row) {
  return {
    id: row.id,
    title: row.title,
    subtitle: row.subtitle,
    imageUrl: row.image_url,
    isActive: Boolean(row.is_active),
    sortOrder: Number(row.sort_order || 0),
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}

function mapPlan(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    durationDays: Number(row.duration_days || 0),
    price: row.price === null ? null : String(row.price),
    mrp: row.mrp === null ? null : String(row.mrp),
    currency: row.currency,
    isActive: Boolean(row.is_active),
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}

function mapProduct(row) {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    category: row.category,
    type: row.type,
    price: row.price === null ? null : String(row.price),
    salePrice: row.sale_price === null ? null : String(row.sale_price),
    mrp: row.mrp === null ? null : String(row.mrp),
    currency: row.currency,
    stock: row.stock,
    isActive: Boolean(row.is_active),
    featured: Boolean(row.featured),
    isFeatured: Boolean(row.featured),
    inStock: row.stock === null || Number(row.stock || 0) > 0,
    requiresShipping: String(row.type || '').toUpperCase() !== 'DIGITAL',
    hasOffer: row.sale_price !== null && row.price !== null && Number(row.sale_price) < Number(row.price),
    discountPercent: row.sale_price !== null && row.mrp !== null && Number(row.mrp) > 0 ? Math.max(0, Math.round((1 - Number(row.sale_price) / Number(row.mrp)) * 100)) : null,
    offerLabel: row.sale_price !== null && row.mrp !== null && Number(row.mrp) > 0 ? `${Math.max(0, Math.round((1 - Number(row.sale_price) / Number(row.mrp)) * 100))}% OFF` : null,
    imageUrl: row.image_url || null,
    imageUrls: row.image_url ? [row.image_url] : [],
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}

function mapModeRule(row) {
  return {
    id: row.id,
    source: row.source,
    mode: row.mode,
    minQuestions: Number(row.min_questions || 1),
    maxQuestions: Number(row.max_questions || 30),
    timerType: row.timer_type,
    allowResume: Boolean(row.allow_resume),
    allowSkip: Boolean(row.allow_skip),
    allowInstantFeedback: Boolean(row.allow_instant_feedback),
    allowExplanation: Boolean(row.allow_explanation),
    createdAt: row.created_at || null,
  };
}

async function assertExists(table, column, value, label) {
  const { data, error: dbError } = await supabaseAdmin
    .from(table)
    .select('*')
    .eq(column, value)
    .limit(1)
    .maybeSingle();

  if (dbError) throw dbError;
  if (!data) {
    const err = new Error(`${label || table} not found.`);
    err.status = 404;
    err.code = `${table}_not_found`;
    throw err;
  }
  return data;
}

async function validateSubjectExamRelation(subjectId, examId) {
  if (!subjectId || !examId) return;
  const subject = await assertExists('subjects', 'id', subjectId, 'Subject');
  if (subject.exam_id !== examId) {
    const err = new Error('Subject does not belong to the selected exam.');
    err.status = 400;
    err.code = 'subject_exam_mismatch';
    throw err;
  }
}

async function validateTopicRelations(topicId, examId, subjectId) {
  if (!topicId) return;
  const topic = await assertExists('taxonomy_nodes', 'id', topicId, 'Topic');

  if (examId && topic.exam_id && topic.exam_id !== examId) {
    const err = new Error('Topic does not belong to the selected exam.');
    err.status = 400;
    err.code = 'topic_exam_mismatch';
    throw err;
  }

  if (subjectId && topic.subject_id && topic.subject_id !== subjectId) {
    const err = new Error('Topic does not belong to the selected subject.');
    err.status = 400;
    err.code = 'topic_subject_mismatch';
    throw err;
  }
}

async function validateQuestionPayloadRelations(payloads = []) {
  const examIds = [...new Set(payloads.map((p) => p.exam_id).filter(Boolean))];
  const subjectIds = [...new Set(payloads.map((p) => p.subject_id).filter(Boolean))];
  const topicIds = [...new Set(payloads.map((p) => p.topic_id).filter(Boolean))];

  const [subjectsResult, topicsResult] = await Promise.all([
    subjectIds.length
      ? supabaseAdmin.from('subjects').select('id,exam_id').in('id', subjectIds)
      : Promise.resolve({ data: [], error: null }),
    topicIds.length
      ? supabaseAdmin.from('taxonomy_nodes').select('id,exam_id,subject_id').in('id', topicIds)
      : Promise.resolve({ data: [], error: null }),
  ]);

  if (subjectsResult.error) throw subjectsResult.error;
  if (topicsResult.error) throw topicsResult.error;

  const subjects = new Map((subjectsResult.data || []).map((x) => [x.id, x]));
  const topics = new Map((topicsResult.data || []).map((x) => [x.id, x]));

  for (const payload of payloads) {
    if (payload.subject_id) {
      const subject = subjects.get(payload.subject_id);
      if (!subject) {
        const err = new Error(`Subject not found: ${payload.subject_id}`);
        err.status = 404;
        err.code = 'subjects_not_found';
        throw err;
      }
      if (payload.exam_id && subject.exam_id !== payload.exam_id) {
        const err = new Error('Subject does not belong to the selected exam.');
        err.status = 400;
        err.code = 'subject_exam_mismatch';
        throw err;
      }
    }

    if (payload.topic_id) {
      const topic = topics.get(payload.topic_id);
      if (!topic) {
        const err = new Error(`Topic not found: ${payload.topic_id}`);
        err.status = 404;
        err.code = 'taxonomy_nodes_not_found';
        throw err;
      }
      if (payload.exam_id && topic.exam_id && topic.exam_id !== payload.exam_id) {
        const err = new Error('Topic does not belong to the selected exam.');
        err.status = 400;
        err.code = 'topic_exam_mismatch';
        throw err;
      }
      if (payload.subject_id && topic.subject_id && topic.subject_id !== payload.subject_id) {
        const err = new Error('Topic does not belong to the selected subject.');
        err.status = 400;
        err.code = 'topic_subject_mismatch';
        throw err;
      }
    }
  }
}

async function refreshExamCounts(examIds = []) {
  const ids = [...new Set((examIds || []).filter(Boolean))];
  for (const examId of ids) {
    const [setsResult, questionsResult, freeSetsResult] = await Promise.all([
      supabaseAdmin
        .from('sets')
        .select('id', { count: 'exact', head: true })
        .eq('exam_id', examId),

      supabaseAdmin
        .from('questions')
        .select('id', { count: 'exact', head: true })
        .eq('exam_id', examId),

      supabaseAdmin
        .from('sets')
        .select('id', { count: 'exact', head: true })
        .eq('exam_id', examId)
        .eq('is_free', true),
    ]);

    if (setsResult.error) throw setsResult.error;
    if (questionsResult.error) throw questionsResult.error;
    if (freeSetsResult.error) throw freeSetsResult.error;

    const { error: updateError } = await supabaseAdmin
      .from('exams')
      .update({
        total_sets: setsResult.count || 0,
        total_questions_available: questionsResult.count || 0,
        free_sets: freeSetsResult.count || 0,
        updated_at: now(),
      })
      .eq('id', examId);

    if (updateError) throw updateError;
  }
}

async function refreshSubjectCounts(subjectIds = []) {
  const ids = [...new Set((subjectIds || []).filter(Boolean))];

  for (const subjectId of ids) {
    const { count, error: countError } = await supabaseAdmin
      .from('questions')
      .select('id', { count: 'exact', head: true })
      .eq('subject_id', subjectId);

    if (countError) throw countError;

    const { error: updateError } = await supabaseAdmin
      .from('subjects')
      .update({
        question_count: count || 0,
      })
      .eq('id', subjectId);

    if (updateError) throw updateError;
  }
}

async function refreshSetCount(setId) {
  const { count, error: countError } = await supabaseAdmin
    .from('set_questions')
    .select('id', { count: 'exact', head: true })
    .eq('set_id', setId);

  if (countError) throw countError;

  const { data: set, error: setError } = await supabaseAdmin
    .from('sets')
    .select('exam_id')
    .eq('id', setId)
    .maybeSingle();

  if (setError) throw setError;

  const { error: updateError } = await supabaseAdmin
    .from('sets')
    .update({
      total_questions: count || 0,
      updated_at: now(),
    })
    .eq('id', setId);

  if (updateError) throw updateError;

  if (set?.exam_id) {
    await refreshExamCounts([set.exam_id]);
  }

  return count || 0;
}

function slugify(value, fallback = 'item') {
  const text = String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return text || fallback;
}

async function generatedTextId(table, base, prefix = 'item') {
  const safeBase = slugify(base, prefix).slice(0, 60);
  const candidate = `${prefix}-${safeBase}`.slice(0, 120);
  const { data, error: lookupError } = await supabaseAdmin.from(table).select('id').eq('id', candidate).limit(1).maybeSingle();
  if (lookupError) throw lookupError;
  if (!data) return candidate;
  return `${candidate}-${crypto.randomBytes(3).toString('hex')}`.slice(0, 120);
}

function questionPayload(body = {}) {
  const questionId = bodyValue(body, 'questionId', 'question_id');
  const stem = bodyValue(body, 'stem');
  const questionType = bodyValue(
    body,
    'questionType',
    'question_type',
    'MCQ'
  );
  const difficulty = bodyValue(body, 'difficulty', 'difficulty', 1);
  const sourceYear = bodyValue(body, 'sourceYear', 'source_year');
  const examName = bodyValue(body, 'examName', 'exam_name');
  const examId = bodyValue(body, 'examId', 'exam_id');
  const subjectId = bodyValue(body, 'subjectId', 'subject_id');
  const topicId = bodyValue(body, 'topicId', 'topic_id');
  const options = bodyValue(body, 'options', 'options', {});
  const correctOption = bodyValue(
    body,
    'correctOption',
    'correct_option',
    null
  );
  const explanation = bodyValue(body, 'explanation');
  const imageUrl = bodyValue(body, 'imageUrl', 'image_url');
  const hasImage = bodyValue(
    body,
    'hasImage',
    'has_image',
    Boolean(imageUrl)
  );

  const cleanStem = requiredText(stem, 'stem');

  if (String(questionType).toUpperCase() === 'MCQ' &&
      (correctOption === undefined ||
       correctOption === null ||
       String(correctOption).trim() === '')) {
    const err = new Error('correctOption is required for MCQ questions.');
    err.status = 400;
    err.code = 'missing_correct_option';
    throw err;
  }

  if (String(questionType).toUpperCase() === 'MCQ') {
    const invalidOptions =
      options === null ||
      typeof options !== 'object' ||
      (Array.isArray(options) && options.length === 0) ||
      (!Array.isArray(options) &&
        Object.keys(options).length === 0);

    if (invalidOptions) {
      const err = new Error('options must be a non-empty JSON object/array for MCQ questions.');
      err.status = 400;
      err.code = 'invalid_options';
      throw err;
    }
  }

  return {
    question_id: optionalText(questionId) || `q-${crypto.randomUUID()}`,
    stem: cleanStem,
    question_type: String(questionType),
    difficulty: nullableNumber(difficulty, 1),
    source_year: nullableNumber(sourceYear),
    exam_name: optionalText(examName),
    exam_id: optionalText(examId),
    subject_id: optionalText(subjectId),
    topic_id: optionalText(topicId),
    options,
    correct_option: optionalText(correctOption),
    explanation: optionalText(explanation),
    image_url: optionalText(imageUrl),
    has_image: parseBoolean(hasImage, Boolean(imageUrl)),
  };
}

function setPayload(body = {}) {
  return {
    name: requiredText(
      bodyValue(body, 'name'),
      'name'
    ),
    exam_id: requiredText(
      bodyValue(body, 'examId', 'exam_id'),
      'examId'
    ),
    exam_name: optionalText(
      bodyValue(body, 'examName', 'exam_name')
    ),
    subject_id: optionalText(
      bodyValue(body, 'subjectId', 'subject_id')
    ),
    set_type: String(
      bodyValue(body, 'setType', 'set_type', 'PYQ')
    ),
    year: nullableNumber(
      bodyValue(body, 'year'),
      null
    ),
    total_questions: 0,
    is_free: Boolean(
      bodyValue(body, 'isFree', 'is_free', false)
    ),
    is_published: Boolean(
      bodyValue(body, 'isPublished', 'is_published', false)
    ),
    access_status: String(
      bodyValue(body, 'accessStatus', 'access_status', 'locked')
    ),
  };
}

async function replaceSetQuestions(setId, questionIds = []) {
  const uniqueIds = [...new Set(
    (questionIds || []).filter(Boolean).map(String)
  )];

  if (!uniqueIds.length) {
    const { error: deleteError } = await supabaseAdmin
      .from('set_questions')
      .delete()
      .eq('set_id', setId);

    if (deleteError) throw deleteError;
    return [];
  }

  const set = await assertExists('sets', 'id', setId, 'Set');

  const { data: questions, error: questionError } = await supabaseAdmin
    .from('questions')
    .select('id,exam_id')
    .in('id', uniqueIds);

  if (questionError) throw questionError;

  const found = new Set((questions || []).map((q) => q.id));
  const missing = uniqueIds.filter((qid) => !found.has(qid));

  if (missing.length) {
    const err = new Error(
      `Question(s) not found: ${missing.join(', ')}`
    );
    err.status = 404;
    err.code = 'questions_not_found';
    throw err;
  }

  const mismatched = (questions || [])
    .filter((q) => q.exam_id && q.exam_id !== set.exam_id)
    .map((q) => q.id);

  if (mismatched.length) {
    const err = new Error(
      `Question(s) belong to a different exam: ${mismatched.join(', ')}`
    );
    err.status = 400;
    err.code = 'question_exam_mismatch';
    throw err;
  }

  const rows = uniqueIds.map((questionId, index) => ({
    set_id: setId,
    question_id: questionId,
    position: index + 1,
  }));

  const { error: deleteError } = await supabaseAdmin
    .from('set_questions')
    .delete()
    .eq('set_id', setId);

  if (deleteError) throw deleteError;

  const { data, error: insertError } = await supabaseAdmin
    .from('set_questions')
    .insert(rows)
    .select('*')
    .order('position', { ascending: true });

  if (insertError) throw insertError;

  return data || [];
}

// =========================================================
// ADMIN - DATABASE DIAGNOSTICS
// =========================================================

app.get('/api/admin/diagnostics', adminAuth, async (req, res) => {
  try {
    // A tiny privileged read confirms the backend is using the admin client.
    const { error: dbError } = await supabaseAdmin
      .from('app_config')
      .select('key')
      .limit(1);

    if (dbError) throw dbError;

    return response(res, {
      ok: true,
      database: 'connected',
      adminClient: 'privileged',
      writes: 'server-side only',
    });
  } catch (e) {
    return adminFail(res, e, 'admin_database_diagnostics_error', 503);
  }
});

// =========================================================
// ADMIN - DASHBOARD
// =========================================================

app.get('/api/admin/dashboard', adminAuth, async (req, res) => {
  try {
    const [
      exams,
      subjects,
      taxonomy,
      sets,
      questions,
      users,
      sessions,
      products,
      plans,
      banners,
    ] = await Promise.all([
      supabaseAdmin.from('exams').select('id', { count: 'exact', head: true }),
      supabaseAdmin.from('subjects').select('id', { count: 'exact', head: true }),
      supabaseAdmin.from('taxonomy_nodes').select('id', { count: 'exact', head: true }),
      supabaseAdmin.from('sets').select('id', { count: 'exact', head: true }),
      supabaseAdmin.from('questions').select('id', { count: 'exact', head: true }),
      supabaseAdmin.from('profiles').select('id', { count: 'exact', head: true }),
      supabaseAdmin.from('sessions').select('id', { count: 'exact', head: true }),
      supabaseAdmin.from('market_products').select('id', { count: 'exact', head: true }),
      supabaseAdmin.from('subscription_plans').select('id', { count: 'exact', head: true }),
      supabaseAdmin.from('banners').select('id', { count: 'exact', head: true }),
    ]);

    for (const result of [
      exams, subjects, taxonomy, sets, questions,
      users, sessions, products, plans, banners,
    ]) {
      if (result.error) throw result.error;
    }

    return response(res, {
      stats: {
        exams: exams.count || 0,
        subjects: subjects.count || 0,
        taxonomyNodes: taxonomy.count || 0,
        sets: sets.count || 0,
        questions: questions.count || 0,
        users: users.count || 0,
        sessions: sessions.count || 0,
        products: products.count || 0,
        subscriptionPlans: plans.count || 0,
        banners: banners.count || 0,
      },
    });
  } catch (e) {
    return adminFail(res, e, 'admin_dashboard_error', 500);
  }
});

// =========================================================
// ADMIN - EXAMS
// =========================================================

app.get('/api/admin/exams', adminAuth, async (req, res) => {
  try {
    let query = supabaseAdmin
      .from('exams')
      .select('*')
      .order('display_order', { ascending: true })
      .order('name', { ascending: true });

    if (req.query.active !== undefined) {
      query = query.eq('is_active', String(req.query.active) === 'true');
    }

    const { data, error: dbError } = await query;
    if (dbError) throw dbError;

    return response(res, {
      exams: (data || []).map(mapExam),
    });
  } catch (e) {
    return adminFail(res, e, 'admin_exams_error', 500);
  }
});

app.post('/api/admin/exams', adminAuth, async (req, res) => {
  try {
    const body = req.body || {};
    const name = requiredText(bodyValue(body, 'name'), 'name');

    const payload = {
      id: await generatedTextId('exams', name, 'exam'),
      name,
      code: optionalText(bodyValue(body, 'code')),
      short_name: optionalText(bodyValue(body, 'shortName', 'short_name')),
      description: optionalText(bodyValue(body, 'description')),
      is_active: parseBoolean(bodyValue(body, 'isActive', 'is_active', true)),
      is_featured: parseBoolean(bodyValue(body, 'isFeatured', 'is_featured', false)),
      display_order: number(bodyValue(body, 'displayOrder', 'display_order', 0)),
      total_sets: 0,
      total_questions_available: 0,
      free_sets: 0,
      icon_url: optionalText(bodyValue(body, 'iconUrl', 'icon_url')),
      banner_url: optionalText(bodyValue(body, 'bannerUrl', 'banner_url')),
    };

    const { data, error: dbError } = await supabaseAdmin
      .from('exams')
      .insert(payload)
      .select('*')
      .limit(1)
      .maybeSingle();

    if (dbError) throw dbError;

    return response(res, { exam: mapExam(data) }, 201);
  } catch (e) {
    return adminFail(res, e, 'admin_exam_create_error');
  }
});

app.patch('/api/admin/exams/:id', adminAuth, async (req, res) => {
  try {
    const examId = String(req.params.id || '').trim();
    if (!examId) {
      return error(res, 400, 'Exam id is required.', 'exam_id_required');
    }

    // Resolve the incoming value before querying. The frontend may send either
    // the database id or the human-readable exam code.
    let resolvedExamId = examId;
    let existing = null;

    const { data: existingExam, error: existingError } = await supabaseAdmin
      .from('exams')
      .select('*')
      .eq('id', examId)
      .limit(1)
      .maybeSingle();

    if (existingError) throw existingError;
    existing = existingExam;

    // Accept either the database id or the human-readable exam code.
    // Id is always preferred when both happen to match.
    if (!existing) {
      const { data: examByCode, error: codeError } = await supabaseAdmin
        .from('exams')
        .select('*')
        .eq('code', examId)
        .limit(1)
        .maybeSingle();

      if (codeError) throw codeError;
      if (examByCode) {
        existing = examByCode;
        resolvedExamId = examByCode.id;
      }
    }

    if (!existing) {
      return error(res, 404, `Exam not found by id or code: ${examId}`, 'exam_not_found');
    }

    const body = req.body || {};
    const update = {};

    if (
      body.name !== undefined ||
      body.examName !== undefined ||
      body.exam_name !== undefined
    ) {
      const name = body.name ?? body.examName ?? body.exam_name;
      update.name = requiredText(name, 'name');
    }
    if (body.code !== undefined) update.code = optionalText(body.code);
    if (body.shortName !== undefined || body.short_name !== undefined) {
      update.short_name = optionalText(bodyValue(body, 'shortName', 'short_name'));
    }
    if (body.description !== undefined) {
      update.description = optionalText(body.description);
    }
    if (body.iconUrl !== undefined || body.icon_url !== undefined) {
      update.icon_url = optionalText(bodyValue(body, 'iconUrl', 'icon_url'));
    }
    if (body.bannerUrl !== undefined || body.banner_url !== undefined) {
      update.banner_url = optionalText(bodyValue(body, 'bannerUrl', 'banner_url'));
    }
    if (body.isActive !== undefined || body.is_active !== undefined) {
      update.is_active = parseBoolean(bodyValue(body, 'isActive', 'is_active'));
    }
    if (body.isFeatured !== undefined || body.is_featured !== undefined) {
      update.is_featured = parseBoolean(bodyValue(body, 'isFeatured', 'is_featured'));
    }
    if (body.displayOrder !== undefined || body.display_order !== undefined) {
      update.display_order = number(bodyValue(body, 'displayOrder', 'display_order', 0));
    }

    if (!Object.keys(update).length) {
      return error(res, 400, 'No fields supplied for update.', 'empty_update');
    }

    update.updated_at = now();

    // Ask Supabase to return the row actually affected by the UPDATE.
    // This prevents a silent 200 when the UPDATE matched zero rows and also
    // lets us verify that the database stored the requested name.
    const { data: updatedExam, error: updateError } = await supabaseAdmin
      .from('exams')
      .update(update)
      .eq('id', resolvedExamId)
      .select('*')
      .limit(1)
      .maybeSingle();

    if (updateError) throw updateError;

    if (!updatedExam) {
      console.error('[ADMIN EXAM UPDATE NO ROW]', {
        requestedExamId: examId,
        resolvedExamId,
        update,
      });
      return error(
        res,
        404,
        `Exam update matched no database row: ${resolvedExamId}`,
        'exam_update_no_row'
      );
    }

    if (
      update.name !== undefined &&
      String(updatedExam.name ?? '') !== String(update.name)
    ) {
      console.error('[ADMIN EXAM UPDATE VERIFY FAILED]', {
        requestedExamId: examId,
        resolvedExamId,
        requestedName: update.name,
        storedName: updatedExam.name,
      });
      return error(
        res,
        500,
        `Database did not retain the requested exam name. Requested: ${update.name}; stored: ${updatedExam.name ?? ''}`,
        'exam_update_verification_failed'
      );
    }

    if (process.env.ADMIN_DEBUG_LOGS === 'true') {
      console.log('[ADMIN EXAM UPDATED]', {
        requestedExamId: examId,
        resolvedExamId,
        update,
        updatedName: updatedExam?.name,
      });
    }

    return response(res, { exam: mapExam(updatedExam) });
  } catch (e) {
    console.error('[ADMIN EXAM UPDATE ERROR]', {
      message: e?.message,
      code: e?.code,
      details: e?.details,
      hint: e?.hint,
      examId: req.params.id,
    });
    return adminFail(res, e, 'admin_exam_update_error', 500);
  }
});

// Temporary admin diagnostic: confirms whether the supplied exam key is an id or code.
app.get('/api/admin/debug/exam/:id', adminAuth, async (req, res) => {
  try {
    const value = String(req.params.id || '').trim();

    const byId = await supabaseAdmin
      .from('exams')
      .select('*')
      .eq('id', value)
      .limit(1)
      .maybeSingle();

    const byCode = await supabaseAdmin
      .from('exams')
      .select('*')
      .eq('code', value)
      .limit(1)
      .maybeSingle();

    return response(res, {
      requested: value,
      byId: {
        found: Boolean(byId.data),
        error: byId.error?.message || null,
        row: byId.data || null,
      },
      byCode: {
        found: Boolean(byCode.data),
        error: byCode.error?.message || null,
        row: byCode.data || null,
      },
    });
  } catch (e) {
    return adminFail(res, e, 'debug_exam_error', 500);
  }
});


app.delete('/api/admin/exams/:id', adminAuth, async (req, res) => {
  try {
    await assertExists('exams', 'id', req.params.id, 'Exam');

    const { error: dbError } = await supabaseAdmin
      .from('exams')
      .delete()
      .eq('id', req.params.id);

    if (dbError) throw dbError;

    return response(res, { deleted: true, id: req.params.id });
  } catch (e) {
    return adminFail(res, e, 'admin_exam_delete_error');
  }
});

// =========================================================
// ADMIN - SUBJECTS
// =========================================================

app.get('/api/admin/subjects', adminAuth, async (req, res) => {
  try {
    let query = supabaseAdmin
      .from('subjects')
      .select('*')
      .order('display_order', { ascending: true })
      .order('name', { ascending: true });

    const examId = req.query.examId || req.query.exam_id;
    if (examId) query = query.eq('exam_id', examId);

    const { data, error: dbError } = await query;
    if (dbError) throw dbError;

    return response(res, {
      subjects: (data || []).map(mapSubject),
    });
  } catch (e) {
    return adminFail(res, e, 'admin_subjects_error', 500);
  }
});

app.post('/api/admin/subjects', adminAuth, async (req, res) => {
  try {
    const body = req.body || {};
    const name = requiredText(bodyValue(body, 'name'), 'name');
    const examId = requiredText(bodyValue(body, 'examId', 'exam_id'), 'examId');

    await assertExists('exams', 'id', examId, 'Exam');

    const payload = {
      id: await generatedTextId('subjects', `${examId}-${name}`, 'subject'),
      name,
      exam_id: examId,
      question_count: 0,
      node_type: String(bodyValue(body, 'nodeType', 'node_type', 'SUBJECT')),
      slug: optionalText(bodyValue(body, 'slug')),
      display_order: number(bodyValue(body, 'displayOrder', 'display_order', 0)),
    };

    const { data, error: dbError } = await supabaseAdmin
      .from('subjects')
      .insert(payload)
      .select('*')
      .single();

    if (dbError) throw dbError;

    return response(res, { subject: mapSubject(data) }, 201);
  } catch (e) {
    return adminFail(res, e, 'admin_subject_create_error');
  }
});

app.patch('/api/admin/subjects/:id', adminAuth, async (req, res) => {
  try {
    const current = await assertExists('subjects', 'id', req.params.id, 'Subject');
    const body = req.body || {};
    const update = {};

    if (
      body.name !== undefined ||
      body.examName !== undefined ||
      body.exam_name !== undefined
    ) {
      const name = body.name ?? body.examName ?? body.exam_name;
      update.name = requiredText(name, 'name');
    }

    if (body.examId !== undefined || body.exam_id !== undefined) {
      const examId = requiredText(bodyValue(body, 'examId', 'exam_id'), 'examId');
      await assertExists('exams', 'id', examId, 'Exam');
      update.exam_id = examId;
    }

    if (body.nodeType !== undefined || body.node_type !== undefined) {
      update.node_type = String(bodyValue(body, 'nodeType', 'node_type'));
    }
    if (body.slug !== undefined) update.slug = optionalText(body.slug);
    if (body.displayOrder !== undefined || body.display_order !== undefined) {
      update.display_order = number(bodyValue(body, 'displayOrder', 'display_order', 0));
    }

    ensureNonEmptyUpdate(update);

    const { data, error: dbError } = await supabaseAdmin
      .from('subjects')
      .update(update)
      .eq('id', req.params.id)
      .select('*')
      .limit(1)
      .maybeSingle();

    if (dbError) throw dbError;
    requireUpdatedRow(data, 'Subject');

    if (current.exam_id !== data.exam_id) {
      await refreshExamCounts([current.exam_id, data.exam_id]);
    }

    return response(res, { subject: mapSubject(data) });
  } catch (e) {
    return adminFail(res, e, 'admin_subject_update_error');
  }
});

app.delete('/api/admin/subjects/:id', adminAuth, async (req, res) => {
  try {
    const current = await assertExists('subjects', 'id', req.params.id, 'Subject');

    const { error: dbError } = await supabaseAdmin
      .from('subjects')
      .delete()
      .eq('id', req.params.id);

    if (dbError) throw dbError;

    if (current.exam_id) await refreshExamCounts([current.exam_id]);

    return response(res, { deleted: true, id: req.params.id });
  } catch (e) {
    return adminFail(res, e, 'admin_subject_delete_error');
  }
});

// =========================================================
// ADMIN - TAXONOMY NODES
// =========================================================

app.get('/api/admin/taxonomy', adminAuth, async (req, res) => {
  try {
    let query = supabaseAdmin
      .from('taxonomy_nodes')
      .select('*')
      .order('display_order', { ascending: true })
      .order('name', { ascending: true });

    const examId = req.query.examId || req.query.exam_id;
    const subjectId = req.query.subjectId || req.query.subject_id;
    const parentId = req.query.parentId || req.query.parent_id;

    if (examId) query = query.eq('exam_id', examId);
    if (subjectId) query = query.eq('subject_id', subjectId);
    if (parentId) query = query.eq('parent_id', parentId);

    const { data, error: dbError } = await query;
    if (dbError) throw dbError;

    return response(res, {
      nodes: (data || []).map(mapTaxonomyNode),
    });
  } catch (e) {
    return adminFail(res, e, 'admin_taxonomy_error', 500);
  }
});

app.get('/api/admin/taxonomy/:id', adminAuth, async (req, res) => {
  try {
    const { data, error: dbError } = await supabaseAdmin
      .from('taxonomy_nodes')
      .select('*')
      .eq('id', req.params.id)
      .maybeSingle();

    if (dbError) throw dbError;
    if (!data) return error(res, 404, 'Taxonomy node not found.', 'taxonomy_not_found');

    return response(res, { node: mapTaxonomyNode(data) });
  } catch (e) {
    return adminFail(res, e, 'admin_taxonomy_get_error');
  }
});

app.post('/api/admin/taxonomy', adminAuth, async (req, res) => {
  try {
    const body = req.body || {};
    const name = requiredText(bodyValue(body, 'name'), 'name');
    const nodeType = requiredText(
      bodyValue(body, 'nodeType', 'node_type'),
      'nodeType'
    );

    const parentId = optionalText(bodyValue(body, 'parentId', 'parent_id'));
    const subjectId = optionalText(bodyValue(body, 'subjectId', 'subject_id'));
    const examId = optionalText(bodyValue(body, 'examId', 'exam_id'));

    if (parentId) await assertExists('taxonomy_nodes', 'id', parentId, 'Parent taxonomy node');
    if (subjectId) await assertExists('subjects', 'id', subjectId, 'Subject');
    if (examId) await assertExists('exams', 'id', examId, 'Exam');

    const payload = {
      id: await generatedTextId('taxonomy_nodes', `${subjectId || examId || 'taxonomy'}-${name}`, 'node'),
      parent_id: parentId,
      subject_id: subjectId,
      exam_id: examId,
      name,
      node_type: nodeType,
      slug: optionalText(bodyValue(body, 'slug')),
      display_order: number(bodyValue(body, 'displayOrder', 'display_order', 0)),
    };

    const { data, error: dbError } = await supabaseAdmin
      .from('taxonomy_nodes')
      .insert(payload)
      .select('*')
      .single();

    if (dbError) throw dbError;

    return response(res, { node: mapTaxonomyNode(data) }, 201);
  } catch (e) {
    return adminFail(res, e, 'admin_taxonomy_create_error');
  }
});

app.patch('/api/admin/taxonomy/:id', adminAuth, async (req, res) => {
  try {
    const current = await assertExists('taxonomy_nodes', 'id', req.params.id, 'Taxonomy node');

    const body = req.body || {};
    const update = {};

    if (
      body.name !== undefined ||
      body.examName !== undefined ||
      body.exam_name !== undefined
    ) {
      const name = body.name ?? body.examName ?? body.exam_name;
      update.name = requiredText(name, 'name');
    }
    if (body.nodeType !== undefined || body.node_type !== undefined) {
      update.node_type = requiredText(
        bodyValue(body, 'nodeType', 'node_type'),
        'nodeType'
      );
    }
    if (body.parentId !== undefined || body.parent_id !== undefined) {
      const parentId = optionalText(bodyValue(body, 'parentId', 'parent_id'));
      if (parentId) {
        if (parentId === req.params.id) {
          const err = new Error('A taxonomy node cannot be its own parent.');
          err.status = 400;
          err.code = 'invalid_parent';
          throw err;
        }
        await assertExists('taxonomy_nodes', 'id', parentId, 'Parent taxonomy node');
      }
      update.parent_id = parentId;
    }
    if (body.subjectId !== undefined || body.subject_id !== undefined) {
      const subjectId = optionalText(bodyValue(body, 'subjectId', 'subject_id'));
      if (subjectId) await assertExists('subjects', 'id', subjectId, 'Subject');
      update.subject_id = subjectId;
    }
    if (body.examId !== undefined || body.exam_id !== undefined) {
      const examId = optionalText(bodyValue(body, 'examId', 'exam_id'));
      if (examId) await assertExists('exams', 'id', examId, 'Exam');
      update.exam_id = examId;
    }

    const effectiveTaxonomyExamId =
      update.exam_id !== undefined ? update.exam_id : current.exam_id;
    const effectiveTaxonomySubjectId =
      update.subject_id !== undefined ? update.subject_id : current.subject_id;

    await validateSubjectExamRelation(
      effectiveTaxonomySubjectId,
      effectiveTaxonomyExamId
    );
    await validateTopicRelations(
      req.params.id,
      effectiveTaxonomyExamId,
      effectiveTaxonomySubjectId
    );

    if (body.slug !== undefined) update.slug = optionalText(body.slug);
    if (body.displayOrder !== undefined || body.display_order !== undefined) {
      update.display_order = number(bodyValue(body, 'displayOrder', 'display_order', 0));
    }

    ensureNonEmptyUpdate(update);

    const { data, error: dbError } = await supabaseAdmin
      .from('taxonomy_nodes')
      .update(update)
      .eq('id', req.params.id)
      .select('*')
      .limit(1)
      .maybeSingle();

    if (dbError) throw dbError;
    requireUpdatedRow(data, 'Taxonomy node');

    return response(res, { node: mapTaxonomyNode(data) });
  } catch (e) {
    return adminFail(res, e, 'admin_taxonomy_update_error');
  }
});

app.delete('/api/admin/taxonomy/:id', adminAuth, async (req, res) => {
  try {
    await assertExists('taxonomy_nodes', 'id', req.params.id, 'Taxonomy node');

    const { error: dbError } = await supabaseAdmin
      .from('taxonomy_nodes')
      .delete()
      .eq('id', req.params.id);

    if (dbError) throw dbError;

    return response(res, { deleted: true, id: req.params.id });
  } catch (e) {
    return adminFail(res, e, 'admin_taxonomy_delete_error');
  }
});

// =========================================================
// ADMIN - SETS
// =========================================================

app.get('/api/admin/sets', adminAuth, async (req, res) => {
  try {
    let query = supabaseAdmin
      .from('sets')
      .select('*')
      .order('created_at', { ascending: false });

    const examId = req.query.examId || req.query.exam_id;
    const subjectId = req.query.subjectId || req.query.subject_id;
    const setType = req.query.setType || req.query.set_type;

    if (examId) query = query.eq('exam_id', examId);
    if (subjectId) query = query.eq('subject_id', subjectId);
    if (setType) query = query.eq('set_type', setType);
    if (req.query.published !== undefined) {
      query = query.eq('is_published', String(req.query.published) === 'true');
    }

    const { data, error: dbError } = await query;
    if (dbError) throw dbError;

    return response(res, {
      sets: (data || []).map(mapSet),
    });
  } catch (e) {
    return adminFail(res, e, 'admin_sets_error', 500);
  }
});

app.get('/api/admin/sets/:id', adminAuth, async (req, res) => {
  try {
    const { data: set, error: setError } = await supabaseAdmin
      .from('sets')
      .select('*')
      .eq('id', req.params.id)
      .maybeSingle();

    if (setError) throw setError;
    if (!set) return error(res, 404, 'Set not found.', 'set_not_found');

    const { data: rows, error: questionError } = await supabaseAdmin
      .from('set_questions')
      .select(`
        set_id,
        question_id,
        position,
        question:questions(*)
      `)
      .eq('set_id', req.params.id)
      .order('position', { ascending: true });

    if (questionError) throw questionError;

    return response(res, {
      set: mapSet(set),
      questions: (rows || []).map((row) => ({
        setId: row.set_id,
        questionId: row.question_id,
        position: row.position,
        question: row.question ? mapQuestionAdmin(row.question) : null,
      })),
    });
  } catch (e) {
    return adminFail(res, e, 'admin_set_get_error', 500);
  }
});

app.post('/api/admin/sets', adminAuth, async (req, res) => {
  try {
    const body = req.body || {};
    const payload = setPayload(body);
    const id = await generatedTextId('sets', `${payload.exam_id}-${payload.name}-${payload.year || ''}`, 'set');

    const exam = await assertExists('exams', 'id', payload.exam_id, 'Exam');
    if (!payload.exam_name) payload.exam_name = exam.name;
    await validateSubjectExamRelation(payload.subject_id, payload.exam_id);

    const { data, error: dbError } = await supabaseAdmin
      .from('sets')
      .insert({
        id,
        ...payload,
      })
      .select('*')
      .single();

    if (dbError) throw dbError;

    try {
      if (Array.isArray(body.questionIds)) {
        await replaceSetQuestions(id, body.questionIds);
        await refreshSetCount(id);
      } else {
        await refreshExamCounts([payload.exam_id]);
      }
    } catch (e) {
      await supabaseAdmin.from('set_questions').delete().eq('set_id', id);
      await supabaseAdmin.from('sets').delete().eq('id', id);
      throw e;
    }

    const { data: freshSet, error: freshError } = await supabaseAdmin
      .from('sets')
      .select('*')
      .eq('id', id)
      .single();

    if (freshError) throw freshError;

    return response(res, { set: mapSet(freshSet) }, 201);
  } catch (e) {
    return adminFail(res, e, 'admin_set_create_error');
  }
});

app.patch('/api/admin/sets/:id', adminAuth, async (req, res) => {
  try {
    const current = await assertExists('sets', 'id', req.params.id, 'Set');
    const body = req.body || {};
    const update = {};

    if (
      body.name !== undefined ||
      body.examName !== undefined ||
      body.exam_name !== undefined
    ) {
      const name = body.name ?? body.examName ?? body.exam_name;
      update.name = requiredText(name, 'name');
    }
    if (body.examId !== undefined || body.exam_id !== undefined) {
      const examId = requiredText(bodyValue(body, 'examId', 'exam_id'), 'examId');
      const exam = await assertExists('exams', 'id', examId, 'Exam');
      update.exam_id = examId;
      update.exam_name = exam.name;
    } else if (body.examName !== undefined || body.exam_name !== undefined) {
      update.exam_name = optionalText(bodyValue(body, 'examName', 'exam_name'));
    }
    if (body.subjectId !== undefined || body.subject_id !== undefined) {
      const subjectId = optionalText(bodyValue(body, 'subjectId', 'subject_id'));
      update.subject_id = subjectId;
    }

    const effectiveExamId = update.exam_id || current.exam_id;
    const effectiveSubjectId =
      update.subject_id !== undefined ? update.subject_id : current.subject_id;
    await validateSubjectExamRelation(effectiveSubjectId, effectiveExamId);

    if (body.setType !== undefined || body.set_type !== undefined) {
      update.set_type = String(bodyValue(body, 'setType', 'set_type'));
    }
    if (body.year !== undefined) update.year = nullableNumber(body.year);
    if (body.isFree !== undefined || body.is_free !== undefined) {
      update.is_free = parseBoolean(bodyValue(body, 'isFree', 'is_free'));
    }
    if (body.isPublished !== undefined || body.is_published !== undefined) {
      update.is_published = parseBoolean(bodyValue(body, 'isPublished', 'is_published'));
    }
    if (body.accessStatus !== undefined || body.access_status !== undefined) {
      update.access_status = String(bodyValue(body, 'accessStatus', 'access_status'));
    }

    const hasQuestionIds = Array.isArray(body.questionIds);

    if (Object.keys(update).length) {
      update.updated_at = now();
      const { error: dbError } = await supabaseAdmin
        .from('sets')
        .update(update)
        .eq('id', req.params.id);

      if (dbError) throw dbError;
    }

    if (hasQuestionIds) {
      await replaceSetQuestions(req.params.id, body.questionIds);
    }

    if (!Object.keys(update).length && !hasQuestionIds) {
      ensureNonEmptyUpdate(update);
    }

    const examIds = [current.exam_id];
    if (update.exam_id) examIds.push(update.exam_id);

    await refreshSetCount(req.params.id);
    await refreshExamCounts(examIds);

    const { data, error: dbError } = await supabaseAdmin
      .from('sets')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (dbError) throw dbError;

    return response(res, { set: mapSet(data) });
  } catch (e) {
    return adminFail(res, e, 'admin_set_update_error');
  }
});

app.delete('/api/admin/sets/:id', adminAuth, async (req, res) => {
  try {
    const current = await assertExists('sets', 'id', req.params.id, 'Set');

    const { error: dbError } = await supabaseAdmin
      .from('sets')
      .delete()
      .eq('id', req.params.id);

    if (dbError) throw dbError;

    await refreshExamCounts([current.exam_id]);

    return response(res, { deleted: true, id: req.params.id });
  } catch (e) {
    return adminFail(res, e, 'admin_set_delete_error');
  }
});

// =========================================================
// ADMIN - QUESTIONS
// =========================================================

app.get('/api/admin/questions', adminAuth, async (req, res) => {
  try {
    let query = supabaseAdmin
      .from('questions')
      .select('*')
      .order('created_at', { ascending: false });

    const examId = req.query.examId || req.query.exam_id;
    const subjectId = req.query.subjectId || req.query.subject_id;
    const topicId = req.query.topicId || req.query.topic_id;
    const difficulty = req.query.difficulty;
    const questionType = req.query.questionType || req.query.question_type;

    if (examId) query = query.eq('exam_id', examId);
    if (subjectId) query = query.eq('subject_id', subjectId);
    if (topicId) query = query.eq('topic_id', topicId);
    if (difficulty !== undefined) query = query.eq('difficulty', number(difficulty));
    if (questionType) query = query.eq('question_type', questionType);

    if (req.query.search) {
      query = query.ilike('stem', `%${String(req.query.search)}%`);
    }

    const limit = Math.min(
      Math.max(number(req.query.limit, 50), 1),
      200
    );
    query = query.limit(limit);

    const { data, error: dbError } = await query;
    if (dbError) throw dbError;

    return response(res, {
      questions: (data || []).map(mapQuestionAdmin),
    });
  } catch (e) {
    return adminFail(res, e, 'admin_questions_error', 500);
  }
});

app.get('/api/admin/questions/:id', adminAuth, async (req, res) => {
  try {
    const { data, error: dbError } = await supabaseAdmin
      .from('questions')
      .select('*')
      .eq('id', req.params.id)
      .maybeSingle();

    if (dbError) throw dbError;
    if (!data) return error(res, 404, 'Question not found.', 'question_not_found');

    return response(res, { question: mapQuestionAdmin(data) });
  } catch (e) {
    return adminFail(res, e, 'admin_question_get_error', 500);
  }
});

app.post('/api/admin/questions', adminAuth, async (req, res) => {
  try {
    const payload = questionPayload(req.body || {});

    if (payload.exam_id) {
      const exam = await assertExists('exams', 'id', payload.exam_id, 'Exam');
      if (!payload.exam_name) payload.exam_name = exam.name;
    }
    await validateSubjectExamRelation(payload.subject_id, payload.exam_id);
    await validateTopicRelations(payload.topic_id, payload.exam_id, payload.subject_id);

    const { data, error: dbError } = await supabaseAdmin
      .from('questions')
      .insert(payload)
      .select('*')
      .limit(1)
      .maybeSingle();

    if (dbError) throw dbError;
    requireUpdatedRow(data, 'Question');

    try {
      if (req.body?.sourceSetId) {
        const sourceSetId = String(req.body.sourceSetId);
        const sourceSet = await assertExists('sets', 'id', sourceSetId, 'Set');
        if (payload.exam_id && sourceSet.exam_id !== payload.exam_id) {
          const err = new Error('Question exam does not match the source set exam.');
          err.status = 400;
          err.code = 'question_set_exam_mismatch';
          throw err;
        }

        const { data: last, error: lastError } = await supabaseAdmin
          .from('set_questions')
          .select('position')
          .eq('set_id', sourceSetId)
          .order('position', { ascending: false })
          .limit(1)
          .maybeSingle();
        if (lastError) throw lastError;

        const { error: linkError } = await supabaseAdmin
          .from('set_questions')
          .upsert({
            set_id: sourceSetId,
            question_id: data.id,
            position: Number(last?.position || 0) + 1,
          }, { onConflict: 'set_id,question_id' });
        if (linkError) throw linkError;
        await refreshSetCount(sourceSetId);
      }

      await refreshSubjectCounts([payload.subject_id]);
      await refreshExamCounts([payload.exam_id]);
    } catch (e) {
      await supabaseAdmin
        .from('set_questions')
        .delete()
        .eq('question_id', data.id);
      await supabaseAdmin
        .from('questions')
        .delete()
        .eq('id', data.id);
      throw e;
    }

    return response(res, {
      question: mapQuestionAdmin(data),
    }, 201);
  } catch (e) {
    return adminFail(res, e, 'admin_question_create_error');
  }
});

app.post('/api/admin/questions/bulk', adminAuth, async (req, res) => {
  try {
    const items = Array.isArray(req.body)
      ? req.body
      : (Array.isArray(req.body?.questions) ? req.body.questions : []);

    if (!items.length) {
      return error(res, 400, 'questions array is required.', 'questions_required');
    }

    if (items.length > 500) {
      return error(res, 400, 'Maximum 500 questions per request.', 'bulk_limit');
    }

    const payloads = items.map(questionPayload);
    const examIds = [...new Set(payloads.map((x) => x.exam_id).filter(Boolean))];
    const subjectIds = [...new Set(payloads.map((x) => x.subject_id).filter(Boolean))];
    const topicIds = [...new Set(payloads.map((x) => x.topic_id).filter(Boolean))];

    for (const examId of examIds) await assertExists('exams', 'id', examId, 'Exam');
    await validateQuestionPayloadRelations(payloads);

    const { data, error: dbError } = await supabaseAdmin
      .from('questions')
      .insert(payloads)
      .select('*');

    if (dbError) throw dbError;

    if (!data || !data.length) {
      const err = new Error('Questions were inserted but no rows were returned.');
      err.status = 500;
      err.code = 'bulk_question_create_return_missing';
      throw err;
    }

    try {
      await refreshSubjectCounts(subjectIds);
      await refreshExamCounts(examIds);
    } catch (e) {
      const insertedIds = data.map((row) => row.id).filter(Boolean);
      if (insertedIds.length) {
        await supabaseAdmin
          .from('set_questions')
          .delete()
          .in('question_id', insertedIds);
        await supabaseAdmin
          .from('questions')
          .delete()
          .in('id', insertedIds);
      }
      throw e;
    }

    return response(res, {
      count: data.length,
      questions: data.map(mapQuestionAdmin),
    }, 201);
  } catch (e) {
    return adminFail(res, e, 'admin_questions_bulk_create_error');
  }
});

app.patch('/api/admin/questions/:id', adminAuth, async (req, res) => {
  try {
    const { data: current, error: currentError } = await supabaseAdmin
      .from('questions')
      .select('*')
      .eq('id', req.params.id)
      .maybeSingle();

    if (currentError) throw currentError;
    if (!current) return error(res, 404, 'Question not found.', 'question_not_found');

    const body = req.body || {};
    const update = {};

    if (body.questionId !== undefined || body.question_id !== undefined) {
      update.question_id = requiredText(
        bodyValue(body, 'questionId', 'question_id'),
        'questionId'
      );
    }
    if (body.stem !== undefined) update.stem = requiredText(body.stem, 'stem');
    if (body.questionType !== undefined || body.question_type !== undefined) {
      update.question_type = String(bodyValue(body, 'questionType', 'question_type'));
    }
    if (body.difficulty !== undefined) update.difficulty = nullableNumber(body.difficulty, 1);
    if (body.sourceYear !== undefined || body.source_year !== undefined) {
      update.source_year = nullableNumber(bodyValue(body, 'sourceYear', 'source_year'));
    }
    if (body.examId !== undefined || body.exam_id !== undefined) {
      const examId = optionalText(bodyValue(body, 'examId', 'exam_id'));
      if (examId) {
        const exam = await assertExists('exams', 'id', examId, 'Exam');
        update.exam_name = exam.name;
      } else {
        update.exam_name = null;
      }
      update.exam_id = examId;
    } else if (body.examName !== undefined || body.exam_name !== undefined) {
      update.exam_name = optionalText(bodyValue(body, 'examName', 'exam_name'));
    }
    if (body.subjectId !== undefined || body.subject_id !== undefined) {
      const subjectId = optionalText(bodyValue(body, 'subjectId', 'subject_id'));
      if (subjectId) await assertExists('subjects', 'id', subjectId, 'Subject');
      update.subject_id = subjectId;
    }
    if (body.topicId !== undefined || body.topic_id !== undefined) {
      const topicId = optionalText(bodyValue(body, 'topicId', 'topic_id'));
      if (topicId) await assertExists('taxonomy_nodes', 'id', topicId, 'Topic');
      update.topic_id = topicId;
    }
    if (body.options !== undefined) update.options = body.options;
    if (body.correctOption !== undefined || body.correct_option !== undefined) {
      update.correct_option = optionalText(
        bodyValue(body, 'correctOption', 'correct_option')
      );
    }
    if (body.explanation !== undefined) update.explanation = optionalText(body.explanation);
    if (body.imageUrl !== undefined || body.image_url !== undefined) {
      const imageUrl = optionalText(
        bodyValue(body, 'imageUrl', 'image_url')
      );
      update.image_url = imageUrl;
      if (
        body.hasImage === undefined &&
        body.has_image === undefined
      ) {
        update.has_image = Boolean(imageUrl);
      }
    }
    if (body.hasImage !== undefined || body.has_image !== undefined) {
      update.has_image = parseBoolean(
        bodyValue(body, 'hasImage', 'has_image')
      );
    }

    const effectiveExamId =
      update.exam_id !== undefined ? update.exam_id : current.exam_id;
    const effectiveSubjectId =
      update.subject_id !== undefined ? update.subject_id : current.subject_id;
    const effectiveTopicId =
      update.topic_id !== undefined ? update.topic_id : current.topic_id;

    await validateSubjectExamRelation(effectiveSubjectId, effectiveExamId);
    await validateTopicRelations(
      effectiveTopicId,
      effectiveExamId,
      effectiveSubjectId
    );

    ensureNonEmptyUpdate(update);

    const nextQuestionType = update.question_type || current.question_type;
    const nextCorrectOption =
      update.correct_option !== undefined
        ? update.correct_option
        : current.correct_option;

    if (
      String(nextQuestionType).toUpperCase() === 'MCQ' &&
      !nextCorrectOption
    ) {
      return error(
        res,
        400,
        'correctOption is required for MCQ questions.',
        'missing_correct_option'
      );
    }

    const nextOptions =
      update.options !== undefined ? update.options : current.options;

    if (String(nextQuestionType).toUpperCase() === 'MCQ') {
      const invalidOptions =
        nextOptions === null ||
        typeof nextOptions !== 'object' ||
        (Array.isArray(nextOptions) && nextOptions.length === 0) ||
        (!Array.isArray(nextOptions) &&
          Object.keys(nextOptions).length === 0);

      if (invalidOptions) {
        return error(
          res,
          400,
          'options must be a non-empty JSON object/array for MCQ questions.',
          'invalid_options'
        );
      }
    }

    update.updated_at = now();

    const { data, error: dbError } = await supabaseAdmin
      .from('questions')
      .update(update)
      .eq('id', req.params.id)
      .select('*')
      .limit(1)
      .maybeSingle();

    if (dbError) throw dbError;
    requireUpdatedRow(data, 'Question');

    await refreshSubjectCounts([current.subject_id, data.subject_id]);
    await refreshExamCounts([current.exam_id, data.exam_id]);

    return response(res, { question: mapQuestionAdmin(data) });
  } catch (e) {
    return adminFail(res, e, 'admin_question_update_error');
  }
});

app.delete('/api/admin/questions/:id', adminAuth, async (req, res) => {
  try {
    const { data: current, error: currentError } = await supabaseAdmin
      .from('questions')
      .select('id,exam_id,subject_id')
      .eq('id', req.params.id)
      .maybeSingle();

    if (currentError) throw currentError;
    if (!current) return error(res, 404, 'Question not found.', 'question_not_found');

    const { error: dbError } = await supabaseAdmin
      .from('questions')
      .delete()
      .eq('id', req.params.id);

    if (dbError) throw dbError;

    await refreshSubjectCounts([current.subject_id]);
    await refreshExamCounts([current.exam_id]);

    return response(res, { deleted: true, id: req.params.id });
  } catch (e) {
    return adminFail(res, e, 'admin_question_delete_error');
  }
});

// =========================================================
// ADMIN - SET QUESTIONS
// =========================================================

app.get('/api/admin/sets/:setId/questions', adminAuth, async (req, res) => {
  try {
    await assertExists('sets', 'id', req.params.setId, 'Set');

    const { data, error: dbError } = await supabaseAdmin
      .from('set_questions')
      .select(`
        set_id,
        question_id,
        position,
        question:questions(*)
      `)
      .eq('set_id', req.params.setId)
      .order('position', { ascending: true });

    if (dbError) throw dbError;

    return response(res, {
      questions: (data || []).map((row) => ({
        setId: row.set_id,
        questionId: row.question_id,
        position: row.position,
        question: row.question ? mapQuestionAdmin(row.question) : null,
      })),
    });
  } catch (e) {
    return adminFail(res, e, 'admin_set_questions_error', 500);
  }
});

app.post('/api/admin/sets/:setId/questions', adminAuth, async (req, res) => {
  try {
    const set = await assertExists('sets', 'id', req.params.setId, 'Set');

    const body = req.body || {};
    const questionId = requiredText(
      bodyValue(body, 'questionId', 'question_id'),
      'questionId'
    );

    const question = await assertExists('questions', 'id', questionId, 'Question');
    if (question.exam_id && question.exam_id !== set.exam_id) {
      return error(
        res,
        400,
        'Question does not belong to the set exam.',
        'question_exam_mismatch'
      );
    }

    let position = optionalPositiveInt(
      bodyValue(body, 'position')
    );

    if (!position) {
      const { data: last, error: lastError } = await supabaseAdmin
        .from('set_questions')
        .select('position')
        .eq('set_id', req.params.setId)
        .order('position', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (lastError) throw lastError;
      position = Number(last?.position || 0) + 1;
    }

    const { data, error: dbError } = await supabaseAdmin
      .from('set_questions')
      .upsert(
        {
          set_id: req.params.setId,
          question_id: questionId,
          position,
        },
        { onConflict: 'set_id,question_id' }
      )
      .select('*')
      .single();

    if (dbError) throw dbError;

    await refreshSetCount(req.params.setId);

    return response(res, { setQuestion: data });
  } catch (e) {
    return adminFail(res, e, 'admin_set_question_add_error');
  }
});

app.post('/api/admin/sets/:setId/questions/bulk', adminAuth, async (req, res) => {
  try {
    const set = await assertExists('sets', 'id', req.params.setId, 'Set');

    const items = Array.isArray(req.body)
      ? req.body
      : (Array.isArray(req.body?.questions) ? req.body.questions : []);

    if (!items.length) {
      return error(res, 400, 'questions array is required.', 'questions_required');
    }

    const questionIds = items.map((item) =>
      requiredText(
        bodyValue(item, 'questionId', 'question_id'),
        'questionId'
      )
    );

    const positions = items.map((item, index) =>
      positiveInt(bodyValue(item, 'position'), index + 1)
    );

    if (new Set(questionIds).size !== questionIds.length) {
      return error(res, 400, 'Duplicate questionId values are not allowed.', 'duplicate_questions');
    }

    if (new Set(positions).size !== positions.length) {
      return error(res, 400, 'Duplicate positions are not allowed.', 'duplicate_positions');
    }

    const { data: questions, error: questionError } = await supabaseAdmin
      .from('questions')
      .select('id,exam_id')
      .in('id', questionIds);

    if (questionError) throw questionError;

    const found = new Set((questions || []).map((q) => q.id));
    const missing = questionIds.filter((id) => !found.has(id));
    if (missing.length) {
      const err = new Error(`Question(s) not found: ${missing.join(', ')}`);
      err.status = 404;
      err.code = 'questions_not_found';
      throw err;
    }

    const mismatched = (questions || [])
      .filter((q) => q.exam_id && q.exam_id !== set.exam_id)
      .map((q) => q.id);

    if (mismatched.length) {
      return error(
        res,
        400,
        `Question(s) belong to a different exam: ${mismatched.join(', ')}`,
        'question_exam_mismatch'
      );
    }

    const rows = questionIds.map((questionId, index) => ({
      set_id: req.params.setId,
      question_id: questionId,
      position: positions[index],
    }));

    const { data, error: dbError } = await supabaseAdmin
      .from('set_questions')
      .upsert(
        rows,
        { onConflict: 'set_id,question_id' }
      )
      .select('*')
      .order('position', { ascending: true });

    if (dbError) throw dbError;

    await refreshSetCount(req.params.setId);

    return response(res, {
      count: data?.length || 0,
      setQuestions: data || [],
    }, 201);
  } catch (e) {
    return adminFail(res, e, 'admin_set_questions_bulk_error');
  }
});

app.put('/api/admin/sets/:setId/questions', adminAuth, async (req, res) => {
  try {
    await assertExists('sets', 'id', req.params.setId, 'Set');

    const body = req.body || {};
    const questionIds = Array.isArray(body)
      ? body
      : (Array.isArray(body.questionIds)
          ? body.questionIds
          : (Array.isArray(body.questions)
              ? body.questions.map((x) => bodyValue(x, 'questionId', 'question_id'))
              : []));

    const rows = await replaceSetQuestions(req.params.setId, questionIds);
    await refreshSetCount(req.params.setId);

    return response(res, {
      count: rows.length,
      setQuestions: rows,
    });
  } catch (e) {
    return adminFail(res, e, 'admin_set_questions_replace_error');
  }
});

app.delete('/api/admin/sets/:setId/questions/:questionId', adminAuth, async (req, res) => {
  try {
    await assertExists('sets', 'id', req.params.setId, 'Set');
    await assertExists('questions', 'id', req.params.questionId, 'Question');

    const { error: dbError } = await supabaseAdmin
      .from('set_questions')
      .delete()
      .eq('set_id', req.params.setId)
      .eq('question_id', req.params.questionId);

    if (dbError) throw dbError;

    await refreshSetCount(req.params.setId);

    return response(res, {
      deleted: true,
      setId: req.params.setId,
      questionId: req.params.questionId,
    });
  } catch (e) {
    return adminFail(res, e, 'admin_set_question_delete_error');
  }
});

// =========================================================
// ADMIN - APP CONFIG
// =========================================================

app.get('/api/admin/app-config', adminAuth, async (req, res) => {
  try {
    const { data, error: dbError } = await supabaseAdmin
      .from('app_config')
      .select('*')
      .order('key', { ascending: true });

    if (dbError) throw dbError;

    return response(res, {
      config: data || [],
      resolved: Object.fromEntries(
        (data || []).map((row) => [row.key, row.value])
      ),
    });
  } catch (e) {
    return adminFail(res, e, 'admin_config_error', 500);
  }
});

app.put('/api/admin/app-config/:key', adminAuth, async (req, res) => {
  try {
    const key = requiredText(req.params.key, 'key');
    const { value } = req.body || {};

    if (value === undefined) {
      return error(res, 400, 'value is required.', 'value_required');
    }

    const { data, error: dbError } = await supabaseAdmin
      .from('app_config')
      .upsert(
        {
          key,
          value,
          updated_at: now(),
        },
        { onConflict: 'key' }
      )
      .select('*')
      .single();

    if (dbError) throw dbError;

    return response(res, { config: data });
  } catch (e) {
    return adminFail(res, e, 'admin_config_update_error');
  }
});

app.delete('/api/admin/app-config/:key', adminAuth, async (req, res) => {
  try {
    const key = requiredText(req.params.key, 'key');

    const { error: dbError } = await supabaseAdmin
      .from('app_config')
      .delete()
      .eq('key', key);

    if (dbError) throw dbError;

    return response(res, { deleted: true, key });
  } catch (e) {
    return adminFail(res, e, 'admin_config_delete_error');
  }
});

// =========================================================
// ADMIN - BANNERS
// =========================================================

app.get('/api/admin/banners', adminAuth, async (req, res) => {
  try {
    const { data, error: dbError } = await supabaseAdmin
      .from('banners')
      .select('*')
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: false });

    if (dbError) throw dbError;

    return response(res, {
      banners: (data || []).map(mapBanner),
    });
  } catch (e) {
    return adminFail(res, e, 'admin_banners_error', 500);
  }
});

app.post('/api/admin/banners', adminAuth, async (req, res) => {
  try {
    const body = req.body || {};
    const title = requiredText(bodyValue(body, 'title'), 'title');
    const id = await generatedTextId('banners', title, 'banner');

    const { data, error: dbError } = await supabaseAdmin
      .from('banners')
      .insert({
        id,
        title,
        subtitle: optionalText(bodyValue(body, 'subtitle')),
        image_url: optionalText(bodyValue(body, 'imageUrl', 'image_url')),
        is_active: parseBoolean(bodyValue(body, 'isActive', 'is_active', true)),
        sort_order: number(bodyValue(body, 'sortOrder', 'sort_order', 0)),
      })
      .select('*')
      .single();

    if (dbError) throw dbError;

    return response(res, { banner: mapBanner(data) }, 201);
  } catch (e) {
    return adminFail(res, e, 'admin_banner_create_error');
  }
});

app.patch('/api/admin/banners/:id', adminAuth, async (req, res) => {
  try {
    await assertExists('banners', 'id', req.params.id, 'Banner');

    const body = req.body || {};
    const update = {};

    if (body.title !== undefined) update.title = requiredText(body.title, 'title');
    if (body.subtitle !== undefined) update.subtitle = optionalText(body.subtitle);
    if (body.imageUrl !== undefined || body.image_url !== undefined) {
      update.image_url = optionalText(bodyValue(body, 'imageUrl', 'image_url'));
    }
    if (body.isActive !== undefined || body.is_active !== undefined) {
      update.is_active = parseBoolean(bodyValue(body, 'isActive', 'is_active'));
    }
    if (body.sortOrder !== undefined || body.sort_order !== undefined) {
      update.sort_order = number(bodyValue(body, 'sortOrder', 'sort_order', 0));
    }

    ensureNonEmptyUpdate(update);
    update.updated_at = now();

    const { data, error: dbError } = await supabaseAdmin
      .from('banners')
      .update(update)
      .eq('id', req.params.id)
      .select('*')
      .limit(1)
      .maybeSingle();

    if (dbError) throw dbError;
    requireUpdatedRow(data, 'Banner');

    return response(res, { banner: mapBanner(data) });
  } catch (e) {
    return adminFail(res, e, 'admin_banner_update_error');
  }
});

app.delete('/api/admin/banners/:id', adminAuth, async (req, res) => {
  try {
    await assertExists('banners', 'id', req.params.id, 'Banner');

    const { error: dbError } = await supabaseAdmin
      .from('banners')
      .delete()
      .eq('id', req.params.id);

    if (dbError) throw dbError;

    return response(res, { deleted: true, id: req.params.id });
  } catch (e) {
    return adminFail(res, e, 'admin_banner_delete_error');
  }
});

// =========================================================
// ADMIN - SUBSCRIPTION PLANS
// =========================================================

app.get('/api/admin/subscription-plans', adminAuth, async (req, res) => {
  try {
    const { data, error: dbError } = await supabaseAdmin
      .from('subscription_plans')
      .select('*')
      .order('price', { ascending: true });

    if (dbError) throw dbError;

    return response(res, {
      plans: (data || []).map(mapPlan),
    });
  } catch (e) {
    return adminFail(res, e, 'admin_plans_error', 500);
  }
});

app.post('/api/admin/subscription-plans', adminAuth, async (req, res) => {
  try {
    const body = req.body || {};
    const name = requiredText(bodyValue(body, 'name'), 'name');
    const id = await generatedTextId('subscription_plans', name, 'plan');
    const price = nullableNumber(bodyValue(body, 'price'), 0);

    const { data, error: dbError } = await supabaseAdmin
      .from('subscription_plans')
      .insert({
        id,
        name,
        description: optionalText(bodyValue(body, 'description')),
        duration_days: positiveInt(
          bodyValue(body, 'durationDays', 'duration_days', 30),
          30
        ),
        price,
        mrp: nullableNumber(bodyValue(body, 'mrp')),
        currency: String(bodyValue(body, 'currency', 'currency', 'INR')),
        is_active: parseBoolean(bodyValue(body, 'isActive', 'is_active', true)),
      })
      .select('*')
      .single();

    if (dbError) throw dbError;

    return response(res, { plan: mapPlan(data) }, 201);
  } catch (e) {
    return adminFail(res, e, 'admin_plan_create_error');
  }
});

app.patch('/api/admin/subscription-plans/:id', adminAuth, async (req, res) => {
  try {
    await assertExists('subscription_plans', 'id', req.params.id, 'Subscription plan');

    const body = req.body || {};
    const update = {};

    if (
      body.name !== undefined ||
      body.examName !== undefined ||
      body.exam_name !== undefined
    ) {
      const name = body.name ?? body.examName ?? body.exam_name;
      update.name = requiredText(name, 'name');
    }
    if (body.description !== undefined) update.description = optionalText(body.description);
    if (body.durationDays !== undefined || body.duration_days !== undefined) {
      update.duration_days = positiveInt(
        bodyValue(body, 'durationDays', 'duration_days', 30),
        30
      );
    }
    if (body.price !== undefined) update.price = nullableNumber(body.price, 0);
    if (body.mrp !== undefined) update.mrp = nullableNumber(body.mrp);
    if (body.currency !== undefined) update.currency = String(body.currency);
    if (body.isActive !== undefined || body.is_active !== undefined) {
      update.is_active = parseBoolean(bodyValue(body, 'isActive', 'is_active'));
    }

    ensureNonEmptyUpdate(update);
    update.updated_at = now();

    const { data, error: dbError } = await supabaseAdmin
      .from('subscription_plans')
      .update(update)
      .eq('id', req.params.id)
      .select('*')
      .limit(1)
      .maybeSingle();

    if (dbError) throw dbError;
    requireUpdatedRow(data, 'Subscription plan');

    return response(res, { plan: mapPlan(data) });
  } catch (e) {
    return adminFail(res, e, 'admin_plan_update_error');
  }
});

app.delete('/api/admin/subscription-plans/:id', adminAuth, async (req, res) => {
  try {
    await assertExists('subscription_plans', 'id', req.params.id, 'Subscription plan');

    const { error: dbError } = await supabaseAdmin
      .from('subscription_plans')
      .delete()
      .eq('id', req.params.id);

    if (dbError) throw dbError;

    return response(res, { deleted: true, id: req.params.id });
  } catch (e) {
    return adminFail(res, e, 'admin_plan_delete_error');
  }
});

// =========================================================
// ADMIN - MARKET PRODUCTS
// =========================================================

app.get('/api/admin/market-products', adminAuth, async (req, res) => {
  try {
    const { data, error: dbError } = await supabaseAdmin
      .from('market_products')
      .select('*')
      .order('created_at', { ascending: false });

    if (dbError) throw dbError;

    return response(res, {
      products: (data || []).map(mapProduct),
    });
  } catch (e) {
    return adminFail(res, e, 'admin_products_error', 500);
  }
});

app.post('/api/admin/market-products', adminAuth, async (req, res) => {
  try {
    const body = req.body || {};
    const title = requiredText(bodyValue(body, 'title'), 'title');
    const id = await generatedTextId('market_products', title, 'product');

    const { data, error: dbError } = await supabaseAdmin
      .from('market_products')
      .insert({
        id,
        title,
        description: optionalText(bodyValue(body, 'description')),
        category: optionalText(bodyValue(body, 'category')),
        type: optionalText(bodyValue(body, 'type')),
        price: nullableNumber(bodyValue(body, 'price')),
        sale_price: nullableNumber(bodyValue(body, 'salePrice', 'sale_price')),
        mrp: nullableNumber(bodyValue(body, 'mrp')),
        currency: String(bodyValue(body, 'currency', 'currency', 'INR')),
        stock: nullableNumber(bodyValue(body, 'stock')),
        is_active: parseBoolean(bodyValue(body, 'isActive', 'is_active', true)),
        featured: parseBoolean(bodyValue(body, 'featured', 'featured', false)),
        image_url: optionalText(bodyValue(body, 'imageUrl', 'image_url')),
      })
      .select('*')
      .single();

    if (dbError) throw dbError;

    return response(res, { product: mapProduct(data) }, 201);
  } catch (e) {
    return adminFail(res, e, 'admin_product_create_error');
  }
});

app.patch('/api/admin/market-products/:id', adminAuth, async (req, res) => {
  try {
    await assertExists('market_products', 'id', req.params.id, 'Market product');

    const body = req.body || {};
    const update = {};

    if (body.title !== undefined) update.title = requiredText(body.title, 'title');
    if (body.description !== undefined) update.description = optionalText(body.description);
    if (body.category !== undefined) update.category = optionalText(body.category);
    if (body.type !== undefined) update.type = optionalText(body.type);
    if (body.price !== undefined) update.price = nullableNumber(body.price);
    if (body.salePrice !== undefined || body.sale_price !== undefined) {
      update.sale_price = nullableNumber(bodyValue(body, 'salePrice', 'sale_price'));
    }
    if (body.mrp !== undefined) update.mrp = nullableNumber(body.mrp);
    if (body.currency !== undefined) update.currency = String(body.currency);
    if (body.stock !== undefined) update.stock = nullableNumber(body.stock);
    if (body.isActive !== undefined || body.is_active !== undefined) {
      update.is_active = parseBoolean(bodyValue(body, 'isActive', 'is_active'));
    }
    if (body.featured !== undefined) update.featured = parseBoolean(body.featured);
    if (body.imageUrl !== undefined || body.image_url !== undefined) {
      update.image_url = optionalText(bodyValue(body, 'imageUrl', 'image_url'));
    }

    ensureNonEmptyUpdate(update);
    update.updated_at = now();

    const { data, error: dbError } = await supabaseAdmin
      .from('market_products')
      .update(update)
      .eq('id', req.params.id)
      .select('*')
      .limit(1)
      .maybeSingle();

    if (dbError) throw dbError;
    requireUpdatedRow(data, 'Market product');

    return response(res, { product: mapProduct(data) });
  } catch (e) {
    return adminFail(res, e, 'admin_product_update_error');
  }
});

app.delete('/api/admin/market-products/:id', adminAuth, async (req, res) => {
  try {
    await assertExists('market_products', 'id', req.params.id, 'Market product');

    const { error: dbError } = await supabaseAdmin
      .from('market_products')
      .delete()
      .eq('id', req.params.id);

    if (dbError) throw dbError;

    return response(res, { deleted: true, id: req.params.id });
  } catch (e) {
    return adminFail(res, e, 'admin_product_delete_error');
  }
});

// =========================================================
// ADMIN - MODE RULES
// =========================================================

app.get('/api/admin/mode-rules', adminAuth, async (req, res) => {
  try {
    const { data, error: dbError } = await supabaseAdmin
      .from('mode_rules')
      .select('*')
      .order('mode', { ascending: true });

    if (dbError) throw dbError;

    return response(res, {
      rules: (data || []).map(mapModeRule),
    });
  } catch (e) {
    return adminFail(res, e, 'admin_mode_rules_error', 500);
  }
});

app.post('/api/admin/mode-rules', adminAuth, async (req, res) => {
  try {
    const body = req.body || {};
    const mode = requiredText(bodyValue(body, 'mode'), 'mode');
    const id = await generatedTextId('mode_rules', mode, 'rule');
    const source = String(bodyValue(body, 'source', 'source', 'supabase'));

    const minQuestions = positiveInt(
      bodyValue(body, 'minQuestions', 'min_questions', 1),
      1
    );
    const maxQuestions = positiveInt(
      bodyValue(body, 'maxQuestions', 'max_questions', 30),
      30
    );

    if (maxQuestions < minQuestions) {
      return error(res, 400, 'maxQuestions must be >= minQuestions.', 'invalid_question_range');
    }

    const { data, error: dbError } = await supabaseAdmin
      .from('mode_rules')
      .insert({
        id,
        source,
        mode,
        min_questions: minQuestions,
        max_questions: maxQuestions,
        timer_type: String(bodyValue(body, 'timerType', 'timer_type', 'none')),
        allow_resume: parseBoolean(bodyValue(body, 'allowResume', 'allow_resume', true)),
        allow_skip: parseBoolean(bodyValue(body, 'allowSkip', 'allow_skip', true)),
        allow_instant_feedback: Boolean(
          bodyValue(body, 'allowInstantFeedback', 'allow_instant_feedback', true)
        ),
        allow_explanation: Boolean(
          bodyValue(body, 'allowExplanation', 'allow_explanation', true)
        ),
      })
      .select('*')
      .single();

    if (dbError) throw dbError;

    return response(res, { rule: mapModeRule(data) }, 201);
  } catch (e) {
    return adminFail(res, e, 'admin_mode_rule_create_error');
  }
});

app.patch('/api/admin/mode-rules/:id', adminAuth, async (req, res) => {
  try {
    await assertExists('mode_rules', 'id', req.params.id, 'Mode rule');

    const body = req.body || {};
    const update = {};

    if (body.source !== undefined) update.source = String(body.source);
    if (body.mode !== undefined) update.mode = requiredText(body.mode, 'mode');

    if (body.minQuestions !== undefined || body.min_questions !== undefined) {
      update.min_questions = positiveInt(
        bodyValue(body, 'minQuestions', 'min_questions', 1),
        1
      );
    }

    if (body.maxQuestions !== undefined || body.max_questions !== undefined) {
      update.max_questions = positiveInt(
        bodyValue(body, 'maxQuestions', 'max_questions', 30),
        30
      );
    }

    if (update.max_questions !== undefined &&
        update.min_questions !== undefined &&
        update.max_questions < update.min_questions) {
      return error(res, 400, 'maxQuestions must be >= minQuestions.', 'invalid_question_range');
    }

    if (body.timerType !== undefined || body.timer_type !== undefined) {
      update.timer_type = String(bodyValue(body, 'timerType', 'timer_type'));
    }
    if (body.allowResume !== undefined || body.allow_resume !== undefined) {
      update.allow_resume = parseBoolean(bodyValue(body, 'allowResume', 'allow_resume'));
    }
    if (body.allowSkip !== undefined || body.allow_skip !== undefined) {
      update.allow_skip = parseBoolean(bodyValue(body, 'allowSkip', 'allow_skip'));
    }
    if (body.allowInstantFeedback !== undefined || body.allow_instant_feedback !== undefined) {
      update.allow_instant_feedback = Boolean(
        bodyValue(body, 'allowInstantFeedback', 'allow_instant_feedback')
      );
    }
    if (body.allowExplanation !== undefined || body.allow_explanation !== undefined) {
      update.allow_explanation = Boolean(
        bodyValue(body, 'allowExplanation', 'allow_explanation')
      );
    }

    ensureNonEmptyUpdate(update);

    const { data, error: dbError } = await supabaseAdmin
      .from('mode_rules')
      .update(update)
      .eq('id', req.params.id)
      .select('*')
      .limit(1)
      .maybeSingle();

    if (dbError) throw dbError;
    requireUpdatedRow(data, 'Mode rule');

    return response(res, { rule: mapModeRule(data) });
  } catch (e) {
    return adminFail(res, e, 'admin_mode_rule_update_error');
  }
});

app.delete('/api/admin/mode-rules/:id', adminAuth, async (req, res) => {
  try {
    await assertExists('mode_rules', 'id', req.params.id, 'Mode rule');

    const { error: dbError } = await supabaseAdmin
      .from('mode_rules')
      .delete()
      .eq('id', req.params.id);

    if (dbError) throw dbError;

    return response(res, { deleted: true, id: req.params.id });
  } catch (e) {
    return adminFail(res, e, 'admin_mode_rule_delete_error');
  }
});

// =========================================================
// ADMIN - ORDERS (READ ONLY)
// =========================================================

app.get('/api/admin/orders', adminAuth, async (req, res) => {
  try {
    let query = supabaseAdmin
      .from('order_intents')
      .select('*')
      .order('created_at', { ascending: false });

    if (req.query.status) query = query.eq('status', String(req.query.status));
    if (req.query.userId || req.query.user_id) {
      query = query.eq('user_id', String(req.query.userId || req.query.user_id));
    }

    const limit = Math.min(Math.max(number(req.query.limit, 100), 1), 200);
    const { data, error: dbError } = await query.limit(limit);
    if (dbError) throw dbError;

    return response(res, {
      orders: (data || []).map((row) => ({
        id: row.id,
        userId: row.user_id,
        status: row.status,
        items: row.items || [],
        paymentUrl: row.payment_url,
        createdAt: row.created_at,
      })),
    });
  } catch (e) {
    return adminFail(res, e, 'admin_orders_error', 500);
  }
});

app.get('/api/admin/orders/:id', adminAuth, async (req, res) => {
  try {
    const { data: row, error: dbError } = await supabaseAdmin
      .from('order_intents')
      .select('*')
      .eq('id', req.params.id)
      .maybeSingle();

    if (dbError) throw dbError;
    if (!row) return error(res, 404, 'Order not found.', 'order_not_found');

    return response(res, {
      order: {
        id: row.id,
        userId: row.user_id,
        status: row.status,
        items: row.items || [],
        paymentUrl: row.payment_url,
        createdAt: row.created_at,
      },
    });
  } catch (e) {
    return adminFail(res, e, 'admin_order_get_error', 500);
  }
});

// =========================================================
// ADMIN - USERS / SUBSCRIPTIONS (READ ONLY)
// =========================================================

app.get('/api/admin/users', adminAuth, async (req, res) => {
  try {
    let query = supabaseAdmin
      .from('profiles')
      .select('*')
      .order('created_at', { ascending: false });

    if (req.query.search) {
      const search = String(req.query.search);
      query = query.or(`name.ilike.%${search}%,email.ilike.%${search}%`);
    }

    const limit = Math.min(
      Math.max(number(req.query.limit, 50), 1),
      200
    );

    const { data, error: dbError } = await query.limit(limit);
    if (dbError) throw dbError;

    return response(res, {
      users: (data || []).map((row) => ({
        id: row.id,
        name: row.name,
        email: row.email,
        avatarUrl: row.avatar_url,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })),
    });
  } catch (e) {
    return adminFail(res, e, 'admin_users_error', 500);
  }
});

app.get('/api/admin/users/:id', adminAuth, async (req, res) => {
  try {
    const { data: profile, error: profileError } = await supabaseAdmin
      .from('profiles')
      .select('*')
      .eq('id', req.params.id)
      .maybeSingle();

    if (profileError) throw profileError;
    if (!profile) return error(res, 404, 'User not found.', 'user_not_found');

    const { data: subscriptions, error: subError } = await supabaseAdmin
      .from('user_subscriptions')
      .select(`
        *,
        plan:subscription_plans(*)
      `)
      .eq('user_id', req.params.id)
      .order('created_at', { ascending: false });

    if (subError) throw subError;

    return response(res, {
      user: {
        id: profile.id,
        name: profile.name,
        email: profile.email,
        avatarUrl: profile.avatar_url,
        createdAt: profile.created_at,
        updatedAt: profile.updated_at,
      },
      subscriptions: (subscriptions || []).map((row) => ({
        id: row.id,
        planId: row.plan_id,
        planName: row.plan?.name || null,
        status: row.status,
        startedAt: row.started_at,
        expiresAt: row.expires_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })),
    });
  } catch (e) {
    return adminFail(res, e, 'admin_user_get_error', 500);
  }
});

// =========================================================
// ADMIN - HEALTH
// =========================================================

app.get('/api/admin/health', adminAuth, async (req, res) => {
  try {
    const { data, error: dbError } = await supabaseAdmin
      .from('app_config')
      .select('key')
      .limit(1);

    if (dbError) throw dbError;

    return response(res, {
      ok: true,
      database: 'supabase',
      checkedAt: now(),
      configRowsReadable: Array.isArray(data),
    });
  } catch (e) {
    return adminFail(res, e, 'admin_health_error', 500);
  }
});

/*
|--------------------------------------------------------------------------
| Error Handler
|--------------------------------------------------------------------------
*/

app.use(
  (err, req, res, next) => {
    console.error(err);

    return error(
      res,
      500,
      process.env.NODE_ENV === 'production'
        ? 'Internal server error.'
        : err.message,
      'internal_error'
    );
  }
);

/*
|--------------------------------------------------------------------------
| Production Safety
|--------------------------------------------------------------------------
*/

if (process.env.NODE_ENV === 'production' && !getAdminEmails().length) {
  throw new Error('ADMIN_EMAILS must be configured in production.');
}

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  if (process.env.NODE_ENV === 'production') {
    process.exit(1);
  }
});

/*
|--------------------------------------------------------------------------
| Server
|--------------------------------------------------------------------------
*/

const server = app.listen(
  PORT,
  HOST,
  () => {
    console.log(
      `Updated PYQ Pulse Express API running on http://${HOST}:${PORT}`
    );

    console.log(
      `Health: http://localhost:${PORT}/health`
    );

    console.log(
      'Storage: Supabase PostgreSQL'
    );

    console.log(
      'Authentication: Supabase Auth'
    );
  }
);

/*
|--------------------------------------------------------------------------
| Graceful Shutdown
|--------------------------------------------------------------------------
*/

function shutdown(signal) {
  console.log(
    `${signal}: shutting down...`
  );

  server.close(() => {
    process.exit(0);
  });

  setTimeout(
    () => process.exit(1),
    5000
  ).unref();
}

process.on(
  'SIGINT',
  () => shutdown('SIGINT')
);

process.on(
  'SIGTERM',
  () => shutdown('SIGTERM')
);