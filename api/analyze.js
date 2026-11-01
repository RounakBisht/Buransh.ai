/**
 * Buransh.ai — Vercel Serverless Function
 * =========================================
 * Scores one support ticket with Groq. The GROQ_API_KEY lives in Vercel
 * environment variables — never in the code, never in GitHub.
 *
 * Endpoint: POST /api/analyze
 * Body: { messages: [{ role: "user", content: "<ticket prompt>" }] }
 *
 * The route only does what the dashboard needs, so the key can't be used
 * as a general-purpose AI proxy: fixed model, capped prompt and reply size,
 * and only this site (and local development) may call it from a browser.
 */

// Groq retired llama-3.1-8b-instant on 16 Aug 2026; GPT-OSS 20B is its recommended replacement.
const MODEL = 'openai/gpt-oss-20b';
const MAX_PROMPT_CHARS = 8000;
const MAX_TOKENS = 2048; // includes the model's (low-effort) reasoning

// This site, its Vercel preview deployments, and local development.
const ALLOWED_ORIGIN = /^https:\/\/buransh-ai(-[a-z0-9-]+)?\.vercel\.app$|^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

function originOf(req) {
  const origin = req.headers.origin;
  if (origin) return origin;
  try {
    return new URL(req.headers.referer || '').origin;
  } catch {
    return '';
  }
}

export default async function handler(req, res) {
  const origin = originOf(req);
  const allowed = ALLOWED_ORIGIN.test(origin);
  if (allowed) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }

  if (req.method === 'OPTIONS') {
    return res.status(allowed ? 204 : 403).end();
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!allowed) {
    return res.status(403).json({ error: 'This endpoint only serves the Buransh.ai dashboard.' });
  }

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'API key not configured' });
  }

  // Accept exactly one user message with a plain-text prompt of reasonable size.
  const messages = req.body && req.body.messages;
  const prompt = Array.isArray(messages) && messages.length === 1 && messages[0] && messages[0].content;
  if (typeof prompt !== 'string' || !prompt.trim()) {
    return res.status(400).json({ error: 'Send one ticket prompt as { messages: [{ role: "user", content }] }.' });
  }
  if (prompt.length > MAX_PROMPT_CHARS) {
    return res.status(413).json({ error: 'That ticket is too long to analyse. Please shorten it.' });
  }

  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.2,
        max_completion_tokens: MAX_TOKENS,
        reasoning_effort: 'low',
        include_reasoning: false,
        response_format: { type: 'json_object' },
      }),
    });

    const data = await response.json();
    return res.status(response.status).json(data);
  } catch (err) {
    return res.status(502).json({ error: 'Could not reach the AI service. Please try again.' });
  }
}
