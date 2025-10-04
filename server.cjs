// server.cjs — minimal secure AI proxy for Flowly with context support
// Requires Node 18+ (global fetch available)
const express = require('express');
const cors = require('cors');

const PORT = process.env.PORT || 3333;
const OPENAI_KEY = process.env.OPENAI_API_KEY; // keep secret on server
const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

const app = express();

// Increase body limit a bit to comfortably carry snapshot context
app.use(express.json({ limit: '512kb' }));

// During dev allow all; for prod, set your domain/origin list
app.use(cors({ origin: true, credentials: false }));

app.get('/health', (_req, res) => res.type('text/plain').send('ok'));

app.post('/ai/chat', async (req, res) => {
  try {
    const prompt = (req.body?.prompt || '').toString();
    const context = req.body?.context ?? null;

    if (!prompt) {
      return res.status(400).json({ text: "Missing 'prompt'." });
    }

    if (!OPENAI_KEY) {
      // Still return something so the app is usable in dev
      return res.json({
        text: `Echo (no OPENAI_API_KEY set): ${prompt}`
      });
    }

    // Build the chat messages with explicit context
    const messages = [
      {
        role: 'system',
        content:
          'You are Flowly AI. Be concise, encouraging, and actionable. ' +
          'You are given JSON context about budget, fitness, nutrition, and planning. ' +
          'Always use this JSON to tailor answers. If something is missing, say so briefly.'
      },
      context
        ? {
            role: 'system',
            content: `Here is the context JSON:\n${JSON.stringify(context).slice(0, 12000)}`
          }
        : null,
      { role: 'user', content: prompt }
    ].filter(Boolean);

    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENAI_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.4,
        messages
      })
    });

    if (!r.ok) {
      const errText = await r.text().catch(() => '');
      return res.json({ text: `AI error (HTTP ${r.status}): ${errText.slice(0, 200)}` });
    }

    const data = await r.json();
    const text =
      (data?.choices?.[0]?.message?.content || '').toString().trim() ||
      'Sorry, I could not generate a reply.';
    return res.json({ text });
  } catch (e) {
    return res.json({ text: `Server error: ${e?.message || 'unknown'}` });
  }
});

app.listen(PORT, () => {
  console.log(`Flowly AI server on http://0.0.0.0:${PORT}`);
  console.log(`Health: http://localhost:${PORT}/health`);
});