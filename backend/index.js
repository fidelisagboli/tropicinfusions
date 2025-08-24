// backend/index.js
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { v4 as uuidv4 } from 'uuid';
import OpenAI from 'openai';
import { createClient } from 'redis';
import path from 'path';
import { fileURLToPath } from 'url';

// --- Paths / constants ---
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SITE_DIR = path.join(__dirname, '../website');
const PORT = process.env.PORT || 3001;
const COOKIE_NAME = 'tj_session';
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days
const GLOBAL_PROMPT_KEY = 'global:system_prompt';

// --- Default prompt (fallback) ---
const DEFAULT_SYSTEM_PROMPT = `
You are the Juice Genius, a friendly, fast, and knowledgeable assistant and representative of Tropic Infusions, a Fairfield, CA - based cold-pressed juice company.

Your sole purpose is to encourage prospective customers to make a purchase by helping them choose juice flavors according to their taste preferences and/or health goals. 

Keep answers upbeat, concise, and practical. 

Discussing adjacent topics such as health and fitness is permissible, but conversation should always be steered politely back to the topic at hand, which is a Tropical Infusions juice purchase. 

Juice is currently sold in 12 oz bottles and are around the $8 mark for singles. Pricing varies, but bulk orders bring the cost per bottle down. Arrangements can also be made to sell in larger or smaller botles.

For now, users can place an order by calling (707) 660-0726. Soon, you will be able to place orders for them.

There are currently 11 flavors: 

- Mango Pine (Mango, Pineapple, Ginger, Turmeric)  
- Charismatic Carrot Ginger (Carrot, Pineapple, Lemon, Ginger, Turmeric)  
- Celery Melon Booster (Celery, Watermelon, Lemon, Ginger)  
- Kiwi Berry Frenzy (Kiwi, Strawberry, Pineapple)  
- Cucumber Lime Burst (Cucumber, Water, Lemon, Ginger)  
- Mesmerizing Melon Berry (Watermelon, Strawberry, Raspberry, Lime, Mint)  
- Apple Berry Bliss (Apple, Raspberry, Blueberry, Honey, Cinnamon)  
- Grape-a-licious (Grape, Kiwi, Ginger)  
- Papaya Dream Fusion (Papaya, Strawberry, Pineapple, Mango, Cinnamon)  
- Citrus Berry Beatdown (Beet, Orange, Raspberry, Ginger)  
- Soulfruit Symphony (Blueberry, Plum, Blackberry, Ginger, Cinnamon)  
`.trim();

// --- Redis client ---
const redisClient = createClient({
  url: process.env.REDIS_URL || undefined, // defaults to localhost:6379
});
redisClient.on('error', (err) => console.error('Redis Client Error', err));

// --- OpenAI ---
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// --- Express app ---
const app = express();

// --- Static files (serve your site) ---
app.use(express.static(SITE_DIR)); // index.html, about.html, flavors.html, styles.css, app.js, etc.

// --- CORS (dev-friendly) ---
app.use(cors({ origin: true, credentials: true }));

// --- Middleware ---
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
app.set('trust proxy', 1);

// --- Helpers ---
function upsertSystemPrompt(history = [], newPrompt) {
  const messages = Array.isArray(history) ? history.slice() : [];
  let sysIdx = messages.findIndex((m) => m && m.role === 'system');

  if (sysIdx === -1) {
    messages.unshift({ role: 'system', content: newPrompt });
    sysIdx = 0;
  } else {
    messages[sysIdx] = { ...messages[sysIdx], content: newPrompt };
  }

  // remove any additional system messages
  for (let i = messages.length - 1; i >= 0; i--) {
    if (i !== sysIdx && messages[i]?.role === 'system') messages.splice(i, 1);
  }

  // ensure system message is first
  if (sysIdx !== 0) {
    const [sys] = messages.splice(sysIdx, 1);
    messages.unshift(sys);
  }

  return messages;
}

async function getGlobalPrompt() {
  const v = await redisClient.get(GLOBAL_PROMPT_KEY);
  return (v && v.trim()) ? v : DEFAULT_SYSTEM_PROMPT;
}

async function setGlobalPrompt(p) {
  await redisClient.set(GLOBAL_PROMPT_KEY, p.trim());
}

async function ensureGlobalPrompt() {
  const exists = await redisClient.exists(GLOBAL_PROMPT_KEY);
  if (!exists) {
    await redisClient.set(GLOBAL_PROMPT_KEY, DEFAULT_SYSTEM_PROMPT);
    console.log('Seeded global system prompt from DEFAULT_SYSTEM_PROMPT');
  } else {
    const cur = await redisClient.get(GLOBAL_PROMPT_KEY);
    if (cur && cur.trim() !== DEFAULT_SYSTEM_PROMPT.trim()) {
      console.log('Global system prompt present in Redis (overrides DEFAULT_SYSTEM_PROMPT).');
    } else {
      console.log('Global system prompt matches DEFAULT_SYSTEM_PROMPT.');
    }
  }
}

async function getOrCreateSession(req, res) {
  let sid = req.cookies?.[COOKIE_NAME];
  if (!sid) {
    sid = uuidv4();
    res.cookie(COOKIE_NAME, sid, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: SESSION_TTL_MS,
      path: '/',
    });
  }

  const sessionKey = `session:${sid}`;
  let data = await redisClient.get(sessionKey);

  if (data) {
    data = JSON.parse(data);
    if (!Array.isArray(data.history)) data.history = [];
  } else {
    data = { createdAt: Date.now(), history: [] };
  }

  return { sid, data };
}

// --- Routes ---
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

app.get('/api/prompt', async (_req, res) => {
  try {
    const p = await getGlobalPrompt();
    res.json({ prompt: p });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'prompt_read_failed', details: String(err.message || err) });
  }
});

app.post('/api/prompt', async (req, res) => {
  try {
    const { prompt } = req.body;
    if (typeof prompt !== 'string' || !prompt.trim()) {
      return res.status(400).json({ error: 'prompt (string) is required' });
    }
    if (prompt.length > 8000) {
      return res.status(400).json({ error: 'prompt too long' });
    }

    // Write global
    await setGlobalPrompt(prompt);

    // Also sync current session so it takes effect immediately for this browser
    const { sid, data } = await getOrCreateSession(req, res);
    data.history = upsertSystemPrompt(data.history, prompt.trim());
    await redisClient.set(`session:${sid}`, JSON.stringify(data), {
      EX: SESSION_TTL_MS / 1000,
    });

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'prompt_update_failed', details: String(err.message || err) });
  }
});

app.post('/api/chat', async (req, res) => {
  try {
    const { message } = req.body;
    if (typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ error: 'message (string) is required' });
    }

    const { sid, data } = await getOrCreateSession(req, res);

    // Always enforce latest global prompt at the top
    const globalPrompt = await getGlobalPrompt();
    data.history = upsertSystemPrompt(data.history, globalPrompt);

    // Append user message
    data.history.push({ role: 'user', content: message });

    // Save before calling OpenAI
    await redisClient.set(`session:${sid}`, JSON.stringify(data), {
      EX: SESSION_TTL_MS / 1000,
    });

    // OpenAI call
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: data.history,
      temperature: 0.7,
    });

    const reply = completion.choices?.[0]?.message?.content?.trim() || '…';

    // Append assistant reply
    data.history.push({ role: 'assistant', content: reply });
    data.createdAt = Date.now();

    // Save updated session
    await redisClient.set(`session:${sid}`, JSON.stringify(data), {
      EX: SESSION_TTL_MS / 1000,
    });

    res.json({ sessionId: sid, reply });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'chat_failed', details: String(err.message || err) });
  }
});

// --- Error handler ---
app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'server_error' });
});

// --- Start ---
(async () => {
  try {
    await redisClient.connect();
    await ensureGlobalPrompt(); // seed/verify on boot
    app.listen(PORT, () => {
      console.log(`Juice Genius server listening on http://localhost:${PORT}`);
      console.log(`Serving website from: ${SITE_DIR}`);
    });
  } catch (err) {
    console.error('Failed to start server:', err);
  }
})();
