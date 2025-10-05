// server.cjs — Flowly AI with optional live web + app context (CommonJS)
const express = require('express');
const cors = require('cors');

const PORT = process.env.PORT || 3333;
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const PPLX_KEY = process.env.PERPLEXITY_API_KEY;                 // optional
const PPLX_MODEL = process.env.PERPLEXITY_MODEL || 'sonar';      // optional

const app = express();
app.use(express.json({ limit: '512kb' }));
app.use(cors({ origin: true, credentials: false }));

const trimJSON = (x, n = 12000) => { try { return JSON.stringify(x).slice(0, n); } catch { return ''; } };
const systemPrompt = [
  'You are Flowly AI. Be concise, encouraging, and actionable.',
  'You receive optional JSON context from the app across Budget, Fitness, Nutrition, Grocery, and Planning.',
  'Always use the JSON when relevant. If data is missing, say so briefly and propose next steps.',
  'If web context is provided, prefer those facts for “now” questions (weather, news, prices).',
].join(' ');
const shouldUseWebAuto = (q='') => {
  const p = q.toLowerCase();
  return p.includes('weather')||p.includes('today')||p.includes('right now')||
         p.includes('latest') ||p.includes('news') ||p.includes('stock')||p.includes('price');
};

async function webAnswer(query) {
  if (!PPLX_KEY) return null;
  try {
    const r = await fetch('https://api.perplexity.ai/chat/completions', {
      method:'POST',
      headers:{ Authorization:`Bearer ${PPLX_KEY}`,'Content-Type':'application/json' },
      body: JSON.stringify({
        model: PPLX_MODEL, search: true,
        messages: [
          { role:'system', content:'Answer with up-to-date info, be brief; cite inline if possible.' },
          { role:'user', content: query }
        ],
      }),
    });
    if (!r.ok) throw new Error(`PPLX HTTP ${r.status}`);
    const j = await r.json();
    return (j?.choices?.[0]?.message?.content||'').toString().trim() || null;
  } catch { return null; }
}

/* ---------------- diagnostics ---------------- */
app.get('/health', (_req,res)=>res.type('text/plain').send('ok'));
app.get('/debug/env', (_req,res)=>{
  res.json({ aiServer:true, hasOPENAI:!!OPENAI_KEY, hasPPLX:!!PPLX_KEY, model:OPENAI_MODEL });
});
app.post('/ai/chat-echo',(req,res)=>{
  const {prompt,context,web,useWeb}=req.body||{};
  res.json({
    ok:true,
    summary:{
      promptPreview:String(prompt||'').slice(0,80),
      receivedWebFlag:!!(useWeb??web),
      contextKeys: context&&typeof context==='object' ? Object.keys(context) : [],
      budgetCounts:{ bills:context?.budget?.bills?.length??0, subscriptions:context?.budget?.subscriptions?.length??0 },
      fitnessToday:context?.fitness?.todayWorkouts?.length??0,
      mealsToday:context?.nutrition?.todayMeals?.length??0,
      planningToday:context?.planning?.today?.length??0,
      groceryCount:context?.grocery?.items?.length??0,
    }
  });
});

/* ---------------- main chat ---------------- */
app.post('/ai/chat', async (req,res)=>{
  try{
    const prompt = (req.body?.prompt||'').toString();
    const context = req.body?.context ?? null;
    const useWeb = !!(req.body?.useWeb ?? req.body?.web);
    const location = (req.body?.location||'').toString().trim();
    if(!prompt) return res.status(400).json({ text:"Missing 'prompt'." });

    let webText = null;
    if (PPLX_KEY && (useWeb || shouldUseWebAuto(prompt))) {
      if (/weather/i.test(prompt) && location) {
        webText = await webAnswer(`Weather right now in ${location}. Include temperature and conditions.`);
      } else {
        webText = await webAnswer(prompt);
      }
    }

    if(!OPENAI_KEY){
      const parts=[]; if(webText) parts.push(`Web: ${webText}`); parts.push(`Echo (no OPENAI_API_KEY set): ${prompt}`);
      return res.json({ text: parts.join('\n\n') });
    }

    const messages = [
      { role:'system', content: systemPrompt },
      context ? { role:'system', content:`Here is the Flowly context JSON:\n${trimJSON(context)}` } : null,
      webText ? { role:'system', content:`Recent web context:\n${webText.slice(0,6000)}` } : null,
      { role:'user', content: prompt },
    ].filter(Boolean);

    const r = await fetch('https://api.openai.com/v1/chat/completions',{
      method:'POST',
      headers:{ Authorization:`Bearer ${OPENAI_KEY}`,'Content-Type':'application/json' },
      body: JSON.stringify({ model:OPENAI_MODEL, temperature:0.4, messages }),
    });
    if(!r.ok){ const t=await r.text().catch(()=> ''); return res.json({ text:`AI error (HTTP ${r.status}): ${t.slice(0,200)}` }); }
    const j = await r.json();
    const text = (j?.choices?.[0]?.message?.content||'').toString().trim() || 'Sorry, I could not generate a reply.';
    res.json({ text });
  }catch(e){ res.json({ text:`Server error: ${e?.message||'unknown'}` }); }
});

app.listen(PORT, ()=> {
  console.log(`Flowly AI server on http://0.0.0.0:${PORT}`);
  console.log(`Health: http://localhost:${PORT}/health`);
});