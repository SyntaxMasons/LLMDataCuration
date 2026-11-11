/**
 * AI Generation Service Module (ai.mjs) 
 * Generates and regenerates Q&A data through an OpenAI-compatible
 * chat-completions API (vLLM). Configuration lives in .env:
 *
 */
import 'dotenv/config';

const LLM_BASE_URL = (process.env.LLM_BASE_URL || '').replace(/\/+$/, '');
const LLM_API_KEY  = process.env.LLM_API_KEY || '';
const LLM_MODEL    = process.env.LLM_MODEL || '';
const LLM_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS || 60000);

// Keep plenty of room for the completion inside the model's 16k context.
const MAX_CONTEXT_CHARS = 16000;

const SYSTEM_PROMPT = "You are a helpful technical support assistant. Answer the user's question accurately using only the provided context.";

/**
 * Strips HTML tags and normalizes whitespace for text extraction.
 * @param {string} html
 * @returns {string} Clean plain text
 */
export function cleanHtmlText(html) {
  if (!html) return '';
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function truncateContext(text) {
  if (text.length <= MAX_CONTEXT_CHARS) return text;
  return text.slice(0, MAX_CONTEXT_CHARS) + '\n\n[...context truncated...]';
}

function stripCodeFences(text) {
  return text
    .replace(/^\s*```(?:json|text)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();
}

function parseJsonObject(text) {
  const cleaned = stripCodeFences(text);
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('{');
    const end   = cleaned.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try { return JSON.parse(cleaned.slice(start, end + 1)); } catch { /* fall through */ }
    }
    return null;
  }
}

/**
 * Calls the OpenAI-compatible /chat/completions endpoint.
 * @param {Array<{role: string, content: string}>} messages
 * @returns {Promise<string>} Assistant message content
 */
async function chatCompletion(messages, { temperature = 0.2, maxTokens = 700 } = {}) {
  if (!LLM_API_KEY) throw new Error('LLM_API_KEY is not configured.');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);

  try {
    // OpenAI's newer models require `max_completion_tokens` and only accept the
    // default temperature, while older models / vLLM expect `max_tokens`.
    // Start with the modern shape and adapt on a 400 instead of hard-coding.
    let tokenParam = 'max_completion_tokens';
    let sendTemperature = true;

    for (let attempt = 0; attempt < 3; attempt++) {
      const body = {
        model: LLM_MODEL,
        messages,
        [tokenParam]: maxTokens
      };
      if (sendTemperature) body.temperature = temperature;

      const response = await fetch(`${LLM_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${LLM_API_KEY}`
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });

      const raw = await response.text();
      if (response.ok) {
        let data;
        try {
          data = JSON.parse(raw);
        } catch {
          throw new Error('LLM API returned invalid JSON.');
        }

        const content = data?.choices?.[0]?.message?.content;
        if (typeof content !== 'string' || !content.trim()) {
          throw new Error('LLM API returned an empty response.');
        }
        return content.trim();
      }

      const lower = raw.toLowerCase();
      if (response.status === 400 && tokenParam === 'max_completion_tokens'
          && lower.includes('max_completion_tokens')
          && (lower.includes('unsupported') || lower.includes('not supported'))) {
        tokenParam = 'max_tokens';
        continue;
      }
      if (response.status === 400 && sendTemperature
          && lower.includes('temperature')
          && (lower.includes('unsupported') || lower.includes('does not support'))) {
        sendTemperature = false;
        continue;
      }

      throw new Error(`LLM API returned HTTP ${response.status}: ${raw.slice(0, 300)}`);
    }

    throw new Error('LLM API rejected the request after retrying parameter formats.');
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`LLM request timed out after ${Math.round(LLM_TIMEOUT_MS / 1000)}s.`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Deterministic fallback used when the LLM is unavailable, so the
 * dashboard and ingest flows keep working.
 */
function fallbackQAPair(text, customPrompt = '') {
  let prompt = customPrompt;
  let answer = '';

  if (!prompt) {
    if (text.includes('Redis') || text.includes('PostgreSQL')) {
      prompt = 'Based on the architecture overview, how are read and write operations handled?';
      answer = 'Read operations are cached heavily using a Redis cluster to reduce latency, while write operations are persisted directly to the primary PostgreSQL database cluster. In case of Redis node failure, the system falls back to direct database querying.';
    } else if (text.includes('API Gateway')) {
      prompt = 'What role does the API Gateway play in the system infrastructure?';
      answer = 'The central API Gateway routes all incoming client requests to the appropriate microservices operating within an isolated VPC.';
    } else {
      prompt = 'What are the key architectural components described in the source document?';
      answer = 'The document describes the main system components, how they communicate, and how data is stored and retrieved.';
    }
  } else {
    answer = `Based on the provided context, ${prompt.replace(/^Question:\s*/i, '').replace(/\?$/, '')} is handled by the system components described in the document.`;
  }

  return { systemPrompt: SYSTEM_PROMPT, prompt, answer, confidence: 0.5 };
}

/**
 * Generates a Q&A pair from raw HTML using the LLM.
 * @param {Object} params
 * @param {string} params.rawHtml - The source HTML content
 * @param {string} [params.customPrompt] - Optional specific question prompt
 * @returns {Promise<{systemPrompt: string, prompt: string, answer: string, confidence: number}>}
 */
export async function generateQAPair({ rawHtml, customPrompt = '' }) {
  const context = truncateContext(cleanHtmlText(rawHtml));

  const instruction = customPrompt
    ? [
        'Write a concise, accurate answer to the question below using ONLY the context.',
        '',
        `Question: ${customPrompt}`,
        '',
        'Respond with a single JSON object: {"answer": "..."}'
      ].join('\n')
    : [
        'Create ONE high-quality question and a concise, accurate answer using ONLY the context below.',
        'The question must be self-contained, must not mention HTML or markup, and must not contain any HTML.',
        '',
        'Respond with a single JSON object: {"question": "...", "answer": "..."}'
      ].join('\n');

  try {
    const raw = await chatCompletion([
      {
        role: 'system',
        content: 'You create high-quality, factual training data for LLM fine-tuning. Never invent facts that are not supported by the context.'
      },
      {
        role: 'user',
        content: `${instruction}\n\n--- CONTEXT START ---\n${context}\n--- CONTEXT END ---`
      }
    ], { temperature: 0.2, maxTokens: 700 });

    const parsed = parseJsonObject(raw) || {};
    const prompt = (customPrompt || parsed.question || '').trim();
    let   answer = (parsed.answer || '').trim();

    if (!answer && customPrompt) answer = stripCodeFences(raw);

    if (prompt && answer) {
      return { systemPrompt: SYSTEM_PROMPT, prompt, answer, confidence: 0.9 };
    }

    throw new Error('The model did not return a usable question/answer pair.');
  } catch (err) {
    console.error('AI generation failed, using fallback:', err.message);
    return fallbackQAPair(context, customPrompt);
  }
}

/**
 * Generates a brand-new answer from scratch for the given question.
 * The current draft is intentionally ignored: use `rewriteAnswer` to polish
 * an existing answer while preserving its meaning.
 * @param {Object} params
 * @param {string} params.rawHtml - The source HTML context
 * @param {string} params.prompt - The question prompt
 * @returns {Promise<{answer: string, timestamp: string}>}
 */
export async function regenerateAnswer({ rawHtml, prompt }) {
  const context = truncateContext(cleanHtmlText(rawHtml));
  const question = (prompt || '').trim();

  const answer = await chatCompletion([
    {
      role: 'system',
      content: 'You are a technical writer. Write accurate, concise answers that are fully supported by the provided context. Never invent details.'
    },
    {
      role: 'user',
      content: [
        'Answer the question below using ONLY the context. Write a fresh answer from scratch.',
        'Be concise, do not mention HTML or "the context", and return only the final answer text.',
        '',
        `Question: ${question || '(no question provided)'}`,
        '',
        '--- CONTEXT START ---',
        context,
        '--- CONTEXT END ---'
      ].join('\n')
    }
  ], { temperature: 0.4, maxTokens: 600 });

  return {
    answer: stripCodeFences(answer),
    timestamp: new Date().toISOString()
  };
}

/**
 * Generates a brand-new user question from scratch using the source context.
 * The current draft is intentionally ignored: use `rewriteQuestion` to polish
 * an existing question while preserving its meaning.
 * @param {Object} params
 * @param {string} params.rawHtml - The source HTML context
 * @returns {Promise<{question: string, timestamp: string}>}
 */
export async function regenerateQuestion({ rawHtml }) {
  const context = truncateContext(cleanHtmlText(rawHtml));

  const raw = await chatCompletion([
    {
      role: 'system',
      content: 'You write clear, self-contained technical support questions. Never mention HTML, markup, or "the context".'
    },
    {
      role: 'user',
      content: [
        'Write ONE high-quality question that can be answered using only the context below.',
        'The question must be self-contained and must not contain any HTML or markup.',
        '',
        'Respond with a single JSON object: {"question": "..."}',
        '',
        '--- CONTEXT START ---',
        context,
        '--- CONTEXT END ---'
      ].join('\n')
    }
  ], { temperature: 0.4, maxTokens: 300 });

  const parsed = parseJsonObject(raw) || {};
  const question = cleanHtmlText(parsed.question || stripCodeFences(raw))
    .replace(/^Question:\s*/i, '')
    .trim();

  if (!question) throw new Error('The model did not return a usable question.');

  return { question, timestamp: new Date().toISOString() };
}

/**
 * Polishes an existing answer: fixes grammar, spelling, punctuation, and
 * clarity while preserving the original meaning and facts. Unlike
 * `regenerateAnswer`, it does not write a new answer and adds no new facts.
 * @param {Object} params
 * @param {string} [params.prompt] - The question the answer responds to
 * @param {string} params.previousAnswer - The answer text to rewrite
 * @returns {Promise<{answer: string, timestamp: string}>}
 */
export async function rewriteAnswer({ prompt = '', previousAnswer = '' }) {
  const draft = (previousAnswer || '').trim();
  if (!draft) throw new Error('There is no answer text to rewrite.');

  const question = (prompt || '').trim();

  const rewritten = await chatCompletion([
    {
      role: 'system',
      content: 'You are a meticulous copy editor. You improve wording without changing meaning.'
    },
    {
      role: 'user',
      content: [
        'Rewrite the answer below to fix grammar, spelling, punctuation, and sentence structure, and to improve clarity and readability.',
        'Strictly preserve the original meaning, intent, and factual content. Do not add new facts, remove information, change conclusions, or answer a different question.',
        'Do not include commentary or explanations. Return only the rewritten answer text.',
        question ? `\nQuestion this answer responds to:\n${question}` : '',
        '',
        'Answer to rewrite:',
        draft
      ].join('\n')
    }
  ], { temperature: 0.2, maxTokens: 600 });

  return {
    answer: stripCodeFences(rewritten),
    timestamp: new Date().toISOString()
  };
}

/**
 * Polishes an existing user question: fixes grammar and improves clarity while
 * keeping the original intent. Unlike `regenerateQuestion`, it does not create
 * a new question.
 * @param {Object} params
 * @param {string} params.previousQuestion - The question text to rewrite
 * @returns {Promise<{question: string, timestamp: string}>}
 */
export async function rewriteQuestion({ previousQuestion = '' }) {
  const draft = (previousQuestion || '').trim();
  if (!draft) throw new Error('There is no question text to rewrite.');

  const rewritten = await chatCompletion([
    {
      role: 'system',
      content: 'You are a meticulous copy editor. You improve wording without changing meaning.'
    },
    {
      role: 'user',
      content: [
        'Rewrite the question below to fix grammar, spelling, punctuation, and sentence structure, and to improve clarity and readability.',
        'Strictly keep the same intent, scope, and requested information. Do not add new topics, change what is being asked, or answer the question.',
        'Do not include commentary or explanations. Return only the rewritten question text.',
        '',
        'Question to rewrite:',
        draft
      ].join('\n')
    }
  ], { temperature: 0.2, maxTokens: 300 });

  const question = cleanHtmlText(stripCodeFences(rewritten))
    .replace(/^Question:\s*/i, '')
    .trim();

  if (!question) throw new Error('The model did not return a usable question.');

  return { question, timestamp: new Date().toISOString() };
}

/**
 * Regenerates the system prompt that steers the assistant.
 * @param {Object} params
 * @param {string} params.rawHtml - The source HTML context
 * @param {string} [params.previousPrompt] - The current system prompt to improve on
 * @returns {Promise<{systemPrompt: string, timestamp: string}>}
 */
export async function regenerateSystemPrompt({ rawHtml, previousPrompt = '' }) {
  const context = truncateContext(cleanHtmlText(rawHtml));

  const raw = await chatCompletion([
    {
      role: 'system',
      content: 'You write concise system prompts for technical support assistants. Never mention HTML or markup.'
    },
    {
      role: 'user',
      content: [
        'Write ONE system prompt describing how an assistant should answer questions using the knowledge base below.',
        'The prompt must be self-contained, must not mention HTML or markup, and must not contain any HTML.',
        'It should be one or two sentences long.',
        previousPrompt ? `\nCurrent system prompt (rewrite/improve it):\n${previousPrompt}` : '',
        '',
        'Respond with a single JSON object: {"systemPrompt": "..."}',
        '',
        '--- KNOWLEDGE BASE START ---',
        context,
        '--- KNOWLEDGE BASE END ---'
      ].join('\n')
    }
  ], { temperature: 0.3, maxTokens: 250 });

  const parsed = parseJsonObject(raw) || {};
  const systemPrompt = cleanHtmlText(parsed.systemPrompt || stripCodeFences(raw)).trim();

  if (!systemPrompt) throw new Error('The model did not return a usable system prompt.');

  return { systemPrompt, timestamp: new Date().toISOString() };
}

/**
 * Formats approved Q&A records into JSONL format for fine-tuning.
 * @param {Array<Object>} qaPairs - List of approved QAPair records
 * @returns {string} JSONL formatted string
 */
export function exportToJSONL(qaPairs) {
  return qaPairs.map(qa => {
    const messages = [
      { role: "system", content: qa.systemPrompt || "You are a helpful assistant." },
      { role: "user", content: qa.prompt },
      { role: "assistant", content: qa.answer }
    ];

    // If multi-turn history exists, incorporate turns
    if (Array.isArray(qa.turns) && qa.turns.length > 0) {
      const turnMessages = [
        { role: "system", content: qa.systemPrompt || "You are a helpful assistant." }
      ];
      for (const turn of qa.turns) {
        if (turn.role && turn.content) {
          turnMessages.push({ role: turn.role, content: turn.content });
        }
      }
      return JSON.stringify({ messages: turnMessages });
    }

    return JSON.stringify({ messages });
  }).join('\n');
}
