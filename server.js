// Minimal secure AI proxy for Flowly
// Node 18+ required (has global fetch)
const express = require('express');
const cors = require('cors');

const PORT = process.env.PORT || 3333;
const OPENAI_KEY = process.env.OPENAI_API_KEY; // DO NOT expose to client
const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

const app = express();
app.use(express.json());

// CORS: during dev, allow all; for prod, set your domain
app.use(cors({ origin: true, credentials: false }));

app.get('/health', (_req, res) => res.type('text/plain').send('ok'));

app.post('/ai/chat', async (req, res) => {
  try {
    const prompt = (req.body?.prompt || '').toString();

    if (!OPENAI_KEY) {
      // Still return something so the app is usable in dev
      return res.json({
        text: prompt ? `Echo (no OPENAI_API_KEY set): ${prompt}` : 'Send { "prompt": "..." }'
      });
    }

    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: 'You are Flowly AI. Be concise and helpful.' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.4
      })
    });

    if (!r.ok) {
      const errText = await r.text().catch(() => '');
      return res.json({ text: `AI error (HTTP ${r.status}): ${errText.slice(0,200)}` });
    }

    const data = await r.json();
    const text = (data?.choices?.[0]?.message?.content || '').toString().trim()
      || 'Sorry, I could not generate a reply.';
    return res.json({ text });
  } catch (e) {
    return res.json({ text: `Server error: ${e?.message || 'unknown'}` });
  }
});

app.listen(PORT, () => {
  console.log(`Flowly AI server on http://0.0.0.0:${PORT}`);
  console.log(`Health: http://localhost:${PORT}/health`);
});