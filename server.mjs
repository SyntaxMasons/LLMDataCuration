import 'dotenv/config';
import express from 'express';
import session from 'express-session';
import path from 'path';
import net from 'net';
import dns from 'dns/promises';
import sanitizeHtml from 'sanitize-html';
import { fileURLToPath } from 'url';

import { sequelize, User, Document, QAPair, initDatabase, hashPassword, verifyPassword } from './db.mjs';
import { generateQAPair, regenerateAnswer, regenerateQuestion, regenerateSystemPrompt, rewriteAnswer, rewriteQuestion, exportToJSONL } from './ai.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── Core Middleware ──────────────────────────────────────────────────────────
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Session Middleware ───────────────────────────────────────────────────────
app.use(session({
  secret:            process.env.SESSION_SECRET || 'nexus-curate-fallback-secret',
  resave:            false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    maxAge:   8 * 60 * 60 * 1000   // 8 hours
  }
}));

// ─── EJS Template Engine ─────────────────────────────────────────────────────
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// ─── Auth Middleware Helpers ──────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (!req.session.user) {
    // For HTMX requests, return 401 fragment; otherwise redirect
    if (req.headers['hx-request']) {
      return res.status(401).render('partials/toast', {
        type:    'error',
        title:   'Session Expired',
        message: 'Please sign in again.'
      });
    }
    return res.redirect('/');
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.user || req.session.user.role !== 'admin') {
    if (req.headers['hx-request']) {
      return res.status(403).render('partials/toast', {
        type:    'error',
        title:   'Access Denied',
        message: 'Administrator privileges required.'
      });
    }
    return res.redirect('/');
  }
  next();
}

// ─── Common Dashboard Data Loader ─────────────────────────────────────────────
async function loadDashboardData(docId) {
  const documents   = await Document.findAll({ order: [['id', 'ASC']] });

  let activeDoc = docId
    ? (documents.find(d => d.id === parseInt(docId, 10)) || documents[0])
    : documents[0] || null;

  let activeQA = null;
  if (activeDoc) {
    activeQA = await QAPair.findOne({
      where: { documentId: activeDoc.id },
      order: [['id', 'DESC']]
    });
    if (!activeQA) {
      const gen = await generateQAPair({ rawHtml: activeDoc.rawHtml });
      activeQA = await QAPair.create({
        documentId:   activeDoc.id,
        systemPrompt: gen.systemPrompt,
        prompt:       gen.prompt,
        answer:       gen.answer,
        turns:        [{ role: 'user', content: gen.prompt }, { role: 'assistant', content: gen.answer }],
        status:       'draft'
      });
    }
  }

  const users = await User.findAll({ order: [['id', 'ASC']] });

  const pendingQAs = await QAPair.findAll({
    where: { status: 'pending_approval' },
    include: [
      { model: Document, as: 'document' },
      { model: User,     as: 'reviewer' }
    ],
    order: [['updatedAt', 'DESC']]
  });

  const approvedQAs = await QAPair.findAll({
    where: { status: 'approved' },
    include: [{ model: Document, as: 'document' }],
    order: [['updatedAt', 'DESC']]
  });

  const jsonlPreview = exportToJSONL(approvedQAs);

  return { documents, document: activeDoc, activeQA, users, pendingQAs, approvedQAs, jsonlPreview };
}

// ─── Knowledge Base Listing Helpers ───────────────────────────────────────────
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Latest QAPair status per document, used for the listing's Status column.
async function loadStatusByDocument() {
  const qaPairs = await QAPair.findAll({
    attributes: ['documentId', 'status'],
    order: [['id', 'ASC']]
  });
  const statusByDocument = new Map();
  for (const qa of qaPairs) statusByDocument.set(qa.documentId, qa.status);
  return statusByDocument;
}

async function loadDocumentList() {
  const [documents, statusByDocument] = await Promise.all([
    Document.findAll({
      include: [{ model: User, as: 'creator', attributes: ['id', 'username'] }],
      order: [['id', 'ASC']]
    }),
    loadStatusByDocument()
  ]);

  return documents.map(doc => {
    const plain = doc.toJSON();
    return {
      ...plain,
      latestQAStatus: statusByDocument.get(doc.id) || null
    };
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// AUTH ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

// POST /auth/login  — validates credentials, sets session, triggers HTMX redirect
app.post('/auth/login', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).send(
      `<div class="flex items-center gap-2 text-red-400 text-sm bg-red-500/10 border border-red-500/20 rounded-lg px-4 py-2.5">
         <i class="ph ph-warning-circle text-lg flex-shrink-0"></i>
         <span>Username and password are required.</span>
       </div>`
    );
  }

  const user = await User.findOne({ where: { username: username.trim() } });

  if (!user || user.status !== 'active') {
    return res.status(401).send(
      `<div class="flex items-center gap-2 text-red-400 text-sm bg-red-500/10 border border-red-500/20 rounded-lg px-4 py-2.5">
         <i class="ph ph-lock-key text-lg flex-shrink-0"></i>
         <span>Invalid username or password.</span>
       </div>`
    );
  }

  const passwordValid = await verifyPassword(password, user.password);
  if (!passwordValid) {
    return res.status(401).send(
      `<div class="flex items-center gap-2 text-red-400 text-sm bg-red-500/10 border border-red-500/20 rounded-lg px-4 py-2.5">
         <i class="ph ph-lock-key text-lg flex-shrink-0"></i>
         <span>Invalid username or password.</span>
       </div>`
    );
  }

  // Set session
  req.session.user = {
    id:       user.id,
    username: user.username,
    role:     user.role
  };

  // HTMX redirect to reload dashboard with session
  res.setHeader('HX-Redirect', '/');
  res.status(200).send('');
});

// GET /auth/logout  — destroys session and redirects to login
app.get('/auth/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// KNOWLEDGE BASE LISTING  +  REVIEW QUEUE
// ═══════════════════════════════════════════════════════════════════════════════

// GET / — knowledge base listing (or the login screen when signed out)
app.get('/', async (req, res) => {
  try {
    const currentUser = req.session.user || null;

    if (!currentUser) {
      return res.render('index', {
        currentUser: null,
        activePage:  'login',
        activeTab:   '',
        pendingCount: 0
      });
    }

    const [documents, pendingCount] = await Promise.all([
      loadDocumentList(),
      QAPair.count({ where: { status: 'pending_approval' } })
    ]);

    res.render('index', {
      currentUser,
      activePage:  'list',
      activeTab:   '',
      pendingCount,
      documents
    });
  } catch (err) {
    console.error('Listing error:', err);
    res.status(500).send('Internal Server Error: ' + err.message);
  }
});

// GET /review — side-by-side curation workspace
app.get('/review', async (req, res) => {
  try {
    const currentUser = req.session.user || null;
    if (!currentUser) return res.redirect('/');

    // Admins review on the same side-by-side page as reviewers; their save
    // action finalizes the Q&A directly (no separate approval step). The
    // consolidated approval queue stays available at `?tab=admin`.
    const activeTab = currentUser.role === 'admin' && req.query.tab === 'admin'
      ? 'admin'
      : 'reviewer';

    const data = await loadDashboardData(req.query.docId);

    res.render('index', {
      ...data,
      currentUser,
      activePage:  'review',
      activeTab,
      pendingCount: data.pendingQAs.length
    });
  } catch (err) {
    console.error('Review dashboard error:', err);
    res.status(500).send('Internal Server Error: ' + err.message);
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// ADMIN — USER MANAGEMENT ROUTES  (admin only)
// ═══════════════════════════════════════════════════════════════════════════════

// Create user — returns rendered row partial for HTMX append
app.post('/api/admin/users', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { username, password, role } = req.body;

    if (!username || !password) {
      return res.status(400).render('partials/toast', {
        type:    'error',
        title:   'Validation Error',
        message: 'Username and temporary password are required.'
      });
    }

    const hashed  = await hashPassword(password.trim());
    const newUser = await User.create({
      username: username.trim(),
      password: hashed,
      role:     role || 'reviewer',
      status:   'active'
    });

    res.render('partials/user-row', { user: newUser });
  } catch (err) {
    console.error('Create user error:', err);
    const msg = err.name === 'SequelizeUniqueConstraintError'
      ? `Username "${req.body.username}" is already taken.`
      : err.message;
    res.status(500).render('partials/toast', { type: 'error', title: 'Failed to create user', message: msg });
  }
});

// Update user role
app.put('/api/admin/users/:id/role', requireAuth, requireAdmin, async (req, res) => {
  try {
    const user = await User.findByPk(req.params.id);
    if (!user) return res.status(404).send('User not found');
    user.role = req.body.role;
    await user.save();
    res.status(200).send('OK');
  } catch (err) {
    console.error('Update role error:', err);
    res.status(500).send(err.message);
  }
});

// Delete user — returns empty string so HTMX removes the row
app.delete('/api/admin/users/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    // Prevent self-deletion
    if (parseInt(req.params.id, 10) === req.session.user.id) {
      return res.status(400).send('<td colspan="4" class="px-6 py-3 text-xs text-red-400 text-center">Cannot delete your own account.</td>');
    }
    const user = await User.findByPk(req.params.id);
    if (user) await user.destroy();
    res.status(200).send('');
  } catch (err) {
    console.error('Delete user error:', err);
    res.status(500).send(err.message);
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// REVIEWER — Q&A WORKFLOW ROUTES  (any authenticated user)
// ═══════════════════════════════════════════════════════════════════════════════

// Generate a brand-new AI answer from scratch (current draft is ignored)
app.post('/api/qa/regenerate', requireAuth, async (req, res) => {
  try {
    const documentId  = req.body.documentId;
    // `regenPrompt` is sent by the per-turn Regenerate button so multi-turn
    // forms always regenerate the prompt belonging to the clicked block.
    let   turnPrompts = req.body.regenPrompt;
    if (turnPrompts === undefined || turnPrompts === '') {
      const rawPrompts  = req.body['turnPrompts[]'] || req.body.turnPrompts || '';
      turnPrompts       = Array.isArray(rawPrompts) ? (rawPrompts.find(Boolean) || '') : rawPrompts;
    }

    let rawHtml = '';
    if (documentId) {
      const doc = await Document.findByPk(documentId);
      if (doc) rawHtml = doc.rawHtml;
    }

    const { answer } = await regenerateAnswer({ rawHtml, prompt: turnPrompts });
    res.send(`<textarea name="turnAnswers[]" required rows="3" class="w-full bg-gray-900 border border-purple-900/30 text-gray-100 text-sm rounded-md focus:ring-purple-500 focus:border-purple-500 block p-2.5 outline-none resize-none transition-colors">${escapeHtml(answer)}</textarea>`);
  } catch (err) {
    console.error('Regenerate answer error:', err);
    res.status(500).send('<div class="text-red-400 text-xs">Failed to regenerate. Try again.</div>');
  }
});

// Rewrite the current answer in place: grammar/clarity only, meaning preserved
app.post('/api/qa/rewrite', requireAuth, async (req, res) => {
  try {
    const { prompt, previousAnswer } = req.body;

    const { answer } = await rewriteAnswer({
      prompt:         prompt         || '',
      previousAnswer: previousAnswer || ''
    });

    res.send(`<textarea name="turnAnswers[]" required rows="3" class="w-full bg-gray-900 border border-purple-900/30 text-gray-100 text-sm rounded-md focus:ring-purple-500 focus:border-purple-500 block p-2.5 outline-none resize-none transition-colors">${escapeHtml(answer)}</textarea>`);
  } catch (err) {
    console.error('Rewrite answer error:', err);
    res.status(500).send('<div class="text-red-400 text-xs">Failed to rewrite. Try again.</div>');
  }
});

// Generate a brand-new user question from scratch (current draft is ignored)
app.post('/api/qa/regenerate-question', requireAuth, async (req, res) => {
  try {
    const { documentId } = req.body;

    let rawHtml = '';
    if (documentId) {
      const doc = await Document.findByPk(documentId);
      if (doc) rawHtml = doc.rawHtml;
    }

    const { question } = await regenerateQuestion({ rawHtml });

    res.send(`<textarea name="turnPrompts[]" required rows="3" class="turn-prompt-input w-full bg-gray-900 border border-gray-700 text-gray-200 text-sm rounded-md focus:ring-brand-500 focus:border-brand-500 block p-2.5 outline-none resize-none transition-colors">${escapeHtml(question)}</textarea>`);
  } catch (err) {
    console.error('Regenerate question error:', err);
    res.status(500).send('<div class="text-red-400 text-xs">Failed to regenerate question. Try again.</div>');
  }
});

// Rewrite the current question in place: grammar/clarity only, meaning preserved
app.post('/api/qa/rewrite-question', requireAuth, async (req, res) => {
  try {
    const { previousQuestion } = req.body;

    const { question } = await rewriteQuestion({ previousQuestion: previousQuestion || '' });

    res.send(`<textarea name="turnPrompts[]" required rows="3" class="turn-prompt-input w-full bg-gray-900 border border-gray-700 text-gray-200 text-sm rounded-md focus:ring-brand-500 focus:border-brand-500 block p-2.5 outline-none resize-none transition-colors">${escapeHtml(question)}</textarea>`);
  } catch (err) {
    console.error('Rewrite question error:', err);
    res.status(500).send('<div class="text-red-400 text-xs">Failed to rewrite question. Try again.</div>');
  }
});

// Regenerate the shared system prompt
app.post('/api/qa/regenerate-system-prompt', requireAuth, async (req, res) => {
  try {
    const { documentId, previousPrompt } = req.body;

    let rawHtml = '';
    if (documentId) {
      const doc = await Document.findByPk(documentId);
      if (doc) rawHtml = doc.rawHtml;
    }

    const { systemPrompt } = await regenerateSystemPrompt({
      rawHtml,
      previousPrompt: previousPrompt || ''
    });

    res.send(`<textarea name="systemPrompt" required rows="2" class="w-full bg-gray-900 border border-gray-700 text-gray-300 text-sm rounded-md focus:ring-brand-500 focus:border-brand-500 block p-2.5 outline-none resize-none transition-colors">${escapeHtml(systemPrompt)}</textarea>`);
  } catch (err) {
    console.error('Regenerate system prompt error:', err);
    res.status(500).send('<div class="text-red-400 text-xs">Failed to regenerate system prompt. Try again.</div>');
  }
});

// Add follow-up question turn block
app.get('/api/qa/add-turn', requireAuth, (req, res) => {
  const requested = parseInt(req.query.index, 10);
  const turnIndex = Number.isInteger(requested) && requested > 0
    ? requested
    : Date.now().toString().slice(-4);
  res.render('partials/qa-turn', { turnIndex, prompt: '', answer: '' });
});

// Save Q&A. Reviewers submit it for approval; admins finalize it directly.
app.post('/api/qa/submit', requireAuth, async (req, res) => {
  try {
    const { documentId, qaPairId, systemPrompt } = req.body;
    const isAdmin = req.session.user.role === 'admin';
    let prompts = req.body['turnPrompts[]'] || req.body.turnPrompts || [];
    let answers = req.body['turnAnswers[]'] || req.body.turnAnswers || [];
    if (!Array.isArray(prompts)) prompts = [prompts];
    if (!Array.isArray(answers)) answers = [answers];

    const turns = [];
    for (let i = 0; i < prompts.length; i++) {
      if (prompts[i]) turns.push({ role: 'user',      content: prompts[i] });
      if (answers[i]) turns.push({ role: 'assistant', content: answers[i] });
    }

    const mainPrompt = prompts[0] || '';
    const mainAnswer = answers[0] || '';
    const nextStatus = isAdmin ? 'approved' : 'pending_approval';

    let qa = qaPairId ? await QAPair.findByPk(qaPairId) : null;
    if (qa) {
      qa.systemPrompt = systemPrompt;
      qa.prompt       = mainPrompt;
      qa.answer       = mainAnswer;
      qa.turns        = turns;
      qa.status       = nextStatus;
      qa.reviewedById = req.session.user.id;
      if (isAdmin) qa.approvedById = req.session.user.id;
      await qa.save();
    } else if (documentId) {
      qa = await QAPair.create({
        documentId:   parseInt(documentId, 10),
        systemPrompt,
        prompt:       mainPrompt,
        answer:       mainAnswer,
        turns,
        status:       nextStatus,
        reviewedById: req.session.user.id,
        approvedById: isAdmin ? req.session.user.id : null
      });
    }

    if (documentId) {
      const doc = await Document.findByPk(documentId);
      if (doc) { doc.status = isAdmin ? 'reviewed' : 'extracted'; await doc.save(); }
    }

    res.render('partials/toast', {
      type:    'success',
      title:   isAdmin ? 'Approved & Finalized' : 'Submitted for Approval',
      message: isAdmin
        ? 'Q&A pair approved and added to the curated dataset.'
        : 'Q&A pair forwarded to the Admin approval queue!'
    });
  } catch (err) {
    console.error('Submit QA error:', err);
    res.status(500).render('partials/toast', { type: 'error', title: 'Submission Failed', message: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// ADMIN — APPROVAL QUEUE ROUTES
// ═══════════════════════════════════════════════════════════════════════════════
async function loadQAForCard(id) {
  return QAPair.findByPk(id, {
    include: [{ model: Document, as: 'document' }, { model: User, as: 'reviewer' }]
  });
}

// Persist editable fields posted from the approval card, keeping any existing
// follow-up turns intact.
function applyQAEdits(qa, body) {
  const systemPrompt = typeof body.systemPrompt === 'string' ? body.systemPrompt.trim() : '';
  if (systemPrompt) qa.systemPrompt = systemPrompt;

  let prompts = body['turnPrompts[]'] ?? body.turnPrompts ?? [];
  let answers = body['turnAnswers[]'] ?? body.turnAnswers ?? [];
  if (!Array.isArray(prompts)) prompts = [prompts];
  if (!Array.isArray(answers)) answers = [answers];

  const hasTurnInput = prompts.some(p => typeof p === 'string' && p.trim()) ||
                       answers.some(a => typeof a === 'string' && a.trim());

  if (hasTurnInput) {
    const turns = [];
    const count = Math.max(prompts.length, answers.length);
    for (let i = 0; i < count; i++) {
      const promptText = typeof prompts[i] === 'string' ? prompts[i].trim() : '';
      const answerText = typeof answers[i] === 'string' ? answers[i].trim() : '';
      if (promptText) turns.push({ role: 'user',      content: promptText });
      if (answerText) turns.push({ role: 'assistant', content: answerText });
    }

    if (turns.length) {
      qa.turns = turns;
      const firstQuestion = turns.find(turn => turn.role === 'user');
      const firstAnswer   = turns.find(turn => turn.role === 'assistant');
      if (firstQuestion) qa.prompt = firstQuestion.content;
      if (firstAnswer)   qa.answer = firstAnswer.content;
    }
    return;
  }

  // Fallback for simple forms that post `prompt` / `answer` directly.
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  const answer = typeof body.answer === 'string' ? body.answer.trim() : '';
  if (prompt) qa.prompt = prompt;
  if (answer) qa.answer = answer;

  if (prompt || answer) {
    const turns = Array.isArray(qa.turns) ? qa.turns.map(turn => ({ ...turn })) : [];
    if (turns.length >= 2) {
      turns[0] = { role: 'user',      content: qa.prompt };
      turns[1] = { role: 'assistant', content: qa.answer };
      qa.turns = turns;
    } else {
      qa.turns = [
        { role: 'user',      content: qa.prompt },
        { role: 'assistant', content: qa.answer }
      ];
    }
  }
}

// Save edits without changing status
app.put('/api/admin/qa/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const qa = await loadQAForCard(req.params.id);
    if (!qa) return res.status(404).send('Not found');

    applyQAEdits(qa, req.body);
    qa.adminFeedback = (req.body.adminFeedback || '').trim();
    await qa.save();

    res.render('partials/approval-card', { qa, saved: true });
  } catch (err) {
    console.error('Save QA error:', err);
    res.status(500).send(err.message);
  }
});

// Delete a Q&A pair from the approval workspace
app.delete('/api/admin/qa/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const qa = await QAPair.findByPk(req.params.id);
    if (qa) await qa.destroy();
    res.status(200).send('');
  } catch (err) {
    console.error('Delete QA error:', err);
    res.status(500).send(err.message);
  }
});

app.post('/api/admin/qa/:id/approve', requireAuth, requireAdmin, async (req, res) => {
  try {
    const qa = await loadQAForCard(req.params.id);
    if (!qa) return res.status(404).send('Not found');
    applyQAEdits(qa, req.body);
    qa.status        = 'approved';
    qa.adminFeedback = (req.body.adminFeedback || '').trim();
    qa.approvedById  = req.session.user.id;
    await qa.save();
    res.render('partials/approval-card', { qa });
  } catch (err) {
    console.error('Approve error:', err);
    res.status(500).send(err.message);
  }
});

app.post('/api/admin/qa/:id/reject', requireAuth, requireAdmin, async (req, res) => {
  try {
    const qa = await loadQAForCard(req.params.id);
    if (!qa) return res.status(404).send('Not found');
    applyQAEdits(qa, req.body);
    qa.status        = 'rejected';
    qa.adminFeedback = (req.body.adminFeedback || '').trim();
    await qa.save();
    res.render('partials/approval-card', { qa });
  } catch (err) {
    console.error('Reject error:', err);
    res.status(500).send(err.message);
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// REMOTE PAGE FETCHING  (reviewer pastes a URL → crawl → Document)
// ═══════════════════════════════════════════════════════════════════════════════

const MAX_FETCH_BYTES = 2 * 1024 * 1024;   // 2 MB
const FETCH_TIMEOUT_MS = 15000;
const MAX_REDIRECTS = 5;

// Block loopback, private, link-local and reserved ranges (SSRF protection).
const blockedAddresses = new net.BlockList();
[
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4]
].forEach(([address, prefix]) => blockedAddresses.addSubnet(address, prefix, 'ipv4'));
[
  ['::', 128], ['::1', 128], ['fe80::', 10], ['fc00::', 7]
].forEach(([address, prefix]) => blockedAddresses.addSubnet(address, prefix, 'ipv6'));

function isBlockedAddress(address) {
  try {
    if (address.toLowerCase().startsWith('::ffff:')) {
      const mapped = address.slice(7);
      return net.isIP(mapped) === 4 ? blockedAddresses.check(mapped, 'ipv4') : true;
    }
    const family = net.isIP(address);
    if (family === 4) return blockedAddresses.check(address, 'ipv4');
    if (family === 6) return blockedAddresses.check(address, 'ipv6');
    return true;
  } catch {
    return true;
  }
}

async function assertFetchableUrl(input) {
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new Error('Enter a valid URL, including http:// or https://.');
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Only http:// and https:// URLs are supported.');
  }
  if (url.username || url.password) {
    throw new Error('URLs containing credentials are not allowed.');
  }

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) throw new Error('The URL has no hostname.');
  if (host === 'localhost' || host.endsWith('.localhost') ||
      host.endsWith('.local') || host.endsWith('.internal')) {
    throw new Error('Local or private network URLs are not allowed.');
  }

  let addresses;
  if (net.isIP(host)) {
    addresses = [host];
  } else {
    try {
      addresses = (await dns.lookup(host, { all: true, verbatim: true })).map(r => r.address);
    } catch {
      throw new Error('Could not resolve the hostname.');
    }
  }
  if (!addresses.length) throw new Error('Could not resolve the hostname.');
  if (addresses.some(isBlockedAddress)) {
    throw new Error('Local or private network URLs are not allowed.');
  }

  return url;
}

function decodeBasicEntities(text) {
  return text
    .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/&nbsp;/gi, ' ');
}

function extractTitle(html) {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? decodeBasicEntities(match[1]).replace(/\s+/g, ' ').trim().slice(0, 200) : '';
}

function filenameFromUrl(finalUrl) {
  const url = new URL(finalUrl);
  const segment = url.pathname.split('/').filter(Boolean).pop() || '';
  let name = segment;
  try { name = decodeURIComponent(segment); } catch { /* keep raw segment */ }
  name = name.replace(/[^\w.\- ]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 100);
  if (!name) {
    name = url.hostname + '.html';
  } else if (!/\.[a-z0-9]{2,8}$/i.test(name)) {
    name += '.html';
  }
  return name;
}

async function fetchRemotePage(input) {
  let current = input;

  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    const url       = await assertFetchableUrl(current);
    const controller = new AbortController();
    const timer      = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      let response;
      try {
        response = await fetch(url.href, {
          redirect: 'manual',
          signal: controller.signal,
          headers: {
            'user-agent': 'LLMDataCuration/1.0 (knowledge-base import)',
            accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1'
          }
        });
      } catch (err) {
        if (err.name === 'AbortError') throw new Error('The request timed out.');
        throw new Error('Could not reach the URL: ' + err.message);
      }

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        if (!location) throw new Error('The page redirected without a destination.');
        current = new URL(location, url).href;
        continue;
      }
      if (!response.ok) throw new Error(`The page returned HTTP ${response.status}.`);

      const contentType = (response.headers.get('content-type') || '').toLowerCase();
      if (contentType && !contentType.includes('text/html') &&
          !contentType.includes('application/xhtml+xml') && !contentType.includes('text/plain')) {
        throw new Error('The URL did not return an HTML page.');
      }
      if (!response.body) throw new Error('The page returned no content.');

      const reader = response.body.getReader();
      const chunks = [];
      let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_FETCH_BYTES) {
          await reader.cancel().catch(() => {});
          throw new Error('The page is too large (limit: 2 MB).');
        }
        chunks.push(Buffer.from(value));
      }

      return { html: Buffer.concat(chunks).toString('utf8'), finalUrl: url.href };
    } finally {
      clearTimeout(timer);
    }
  }

  throw new Error('Too many redirects.');
}

const SANITIZE_OPTIONS = {
  allowedTags: [
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'div', 'span', 'br', 'hr',
    'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'blockquote', 'pre', 'code',
    'a', 'img', 'figure', 'figcaption', 'strong', 'em', 'b', 'i', 'u', 's',
    'small', 'sup', 'sub', 'mark', 'table', 'thead', 'tbody', 'tfoot', 'tr',
    'th', 'td', 'caption', 'section', 'article', 'header', 'footer', 'main', 'nav'
  ],
  allowedAttributes: {
    '*':   ['class', 'id', 'title'],
    a:     ['href', 'name', 'target', 'rel'],
    img:   ['src', 'alt', 'width', 'height', 'title'],
    table: ['border', 'cellpadding', 'cellspacing'],
    th:    ['colspan', 'rowspan', 'scope'],
    td:    ['colspan', 'rowspan']
  },
  allowedSchemes: ['http', 'https', 'mailto'],
  allowProtocolRelative: false,
  transformTags: {
    a: (tagName, attribs) => ({
      tagName,
      attribs: { ...attribs, target: '_blank', rel: 'noopener noreferrer' }
    })
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORT  &  INGEST ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

app.post('/api/documents/fetch-url', requireAuth, async (req, res) => {
  try {
    const rawUrl = (req.body.url || '').trim();
    const providedTitle = (Array.isArray(req.body.title) ? req.body.title[0] : req.body.title || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 200);

    if (!rawUrl) {
      return res.status(400).render('partials/toast', {
        type: 'error', title: 'URL Required', message: 'Paste a URL to load.'
      });
    }

    const page     = await fetchRemotePage(rawUrl);
    const title    = providedTitle || extractTitle(page.html) || filenameFromUrl(page.finalUrl).replace(/\.[^.]+$/, '');
    const filename = filenameFromUrl(page.finalUrl);
    const rawHtml  = sanitizeHtml(page.html, SANITIZE_OPTIONS);

    if (!rawHtml.replace(/<[^>]*>/g, '').trim()) {
      throw new Error('The page did not contain any readable HTML content.');
    }

    const doc = await Document.create({
      filename,
      title,
      rawHtml,
      status: 'needs_extraction',
      createdById: req.session.user.id
    });

    const gen = await generateQAPair({ rawHtml: doc.rawHtml });
    await QAPair.create({
      documentId:   doc.id,
      systemPrompt: gen.systemPrompt,
      prompt:       gen.prompt,
      answer:       gen.answer,
      turns:        [{ role: 'user', content: gen.prompt }, { role: 'assistant', content: gen.answer }],
      status:       'draft'
    });

    res.setHeader('HX-Redirect', '/review?docId=' + doc.id);
    res.status(200).send('');
  } catch (err) {
    console.error('Fetch URL error:', err.message);
    res.status(400).render('partials/toast', {
      type: 'error',
      title: 'Could Not Load URL',
      message: err.message
    });
  }
});

app.get('/api/export/jsonl', requireAuth, requireAdmin, async (req, res) => {
  try {
    const approvedQAs = await QAPair.findAll({ where: { status: 'approved' }, order: [['id', 'ASC']] });
    res.setHeader('Content-Type', 'application/x-jsonlines; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="curated-qa-dataset.jsonl"');
    res.send(exportToJSONL(approvedQAs));
  } catch (err) {
    console.error('Export error:', err);
    res.status(500).send('Export failed: ' + err.message);
  }
});

app.post('/api/documents/ingest', requireAuth, async (req, res) => {
  try {
    const { filename, rawHtml } = req.body;
    if (!filename || !rawHtml) return res.status(400).send('Filename and HTML are required.');

    const doc = await Document.create({
      filename: filename.trim(),
      title:    filename.replace(/\.[^/.]+$/, ''),
      rawHtml:  rawHtml.trim(),
      status:   'needs_extraction',
      createdById: req.session.user.id
    });

    const gen = await generateQAPair({ rawHtml: doc.rawHtml });
    await QAPair.create({
      documentId:   doc.id,
      systemPrompt: gen.systemPrompt,
      prompt:       gen.prompt,
      answer:       gen.answer,
      turns:        [{ role: 'user', content: gen.prompt }, { role: 'assistant', content: gen.answer }],
      status:       'draft'
    });

    res.redirect('/review?docId=' + doc.id);
  } catch (err) {
    console.error('Ingest error:', err);
    res.status(500).send('Ingest failed: ' + err.message);
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// KNOWLEDGE BASE MANAGEMENT  (editable title, delete single/bulk)
// ═══════════════════════════════════════════════════════════════════════════════

// Update the human-friendly title of a knowledge base
app.put('/api/documents/:id/title', requireAuth, async (req, res) => {
  try {
    const doc = await Document.findByPk(req.params.id);
    if (!doc) return res.status(404).send('Knowledge base not found.');

    const title = (req.body.title || '').trim().slice(0, 200);
    if (!title) {
      return res.status(400).render('partials/toast', {
        type: 'error', title: 'Title Required', message: 'Enter a title before saving.'
      });
    }

    doc.title = title;
    await doc.save();

    res.render('partials/kb-title', { doc });
  } catch (err) {
    console.error('Update title error:', err);
    res.status(500).render('partials/toast', { type: 'error', title: 'Could Not Save Title', message: err.message });
  }
});

// Delete a single knowledge base (and its Q&A pairs)
app.delete('/api/documents/:id', requireAuth, async (req, res) => {
  try {
    const doc = await Document.findByPk(req.params.id);
    if (!doc) return res.status(404).send('Knowledge base not found.');

    await QAPair.destroy({ where: { documentId: doc.id } });
    await doc.destroy();

    const documents = await loadDocumentList();
    res.render('partials/kb-rows', { documents });
  } catch (err) {
    console.error('Delete document error:', err);
    res.status(500).render('partials/toast', { type: 'error', title: 'Could Not Delete', message: err.message });
  }
});

// Delete one or more selected knowledge bases; returns the refreshed table rows
app.post('/api/documents/delete-selected', requireAuth, async (req, res) => {
  try {
    let ids = req.body.ids ?? req.body['ids[]'] ?? [];
    if (!Array.isArray(ids)) ids = [ids];
    ids = ids.map(id => parseInt(id, 10)).filter(Number.isInteger);

    if (!ids.length) {
      return res.status(400).render('partials/toast', {
        type: 'error', title: 'Nothing Selected', message: 'Select at least one knowledge base to delete.'
      });
    }

    await QAPair.destroy({ where: { documentId: ids } });
    await Document.destroy({ where: { id: ids } });

    const documents = await loadDocumentList();
    res.render('partials/kb-rows', { documents });
  } catch (err) {
    console.error('Bulk delete error:', err);
    res.status(500).render('partials/toast', { type: 'error', title: 'Could Not Delete', message: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// SERVER BOOT
// ═══════════════════════════════════════════════════════════════════════════════
async function startServer() {
  try {
    await sequelize.authenticate();
    console.log('✓ SQLite connected.');
    await initDatabase({ force: false });
    app.listen(PORT, () => {
      console.log(`\n===============================================`);
      console.log(`🚀  LLMDataCuration running on port ${PORT}`);
      console.log(`📍  URL:      http://localhost:${PORT}`);
      console.log(`💾  Database: SQLite (database.sqlite)`);
      console.log(`🔐  Auth:     bcrypt + express-session`);
      console.log(`===============================================\n`);
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

startServer();
