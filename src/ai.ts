import express from "express";
import cors from "cors";
import admin from "./firebaseAdmin";
import { z } from "zod";
import OpenAI from "openai";

const router = express.Router();
router.use(cors());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const bodySchema = z.object({
  message: z.string().min(1),
  // Optional per-request scope narrowing (server will still AND with stored user settings)
  scopes: z.object({
    budget: z.boolean().optional(),
    nutrition: z.boolean().optional(),
    planning: z.boolean().optional(),
    fitness: z.boolean().optional(),
  }).optional(),
});

async function buildUserContext(uid: string, scopes: {
  budget?: boolean; nutrition?: boolean; planning?: boolean; fitness?: boolean;
}) {
  const db = admin.firestore();
  const ctx: Record<string, any> = {};

  // Budget
  if (scopes.budget) {
    const s = await db.collection("budgets").doc(uid).get();
    if (s.exists) {
      const b = s.data() || {};
      ctx.budget = {
        monthlyLimit: b?.summary?.monthlyLimit ?? null,
        currency: b?.summary?.currency ?? "USD",
        topBills: (b?.bills ?? []).slice(0, 10),
        recentActivity: (b?.activity ?? [])
          .sort((a:any,b:any)=> (b.date||"").localeCompare(a.date||""))
          .slice(0, 10)
          .map((t:any)=>({ date: t.date, amount: t.amount, category: t.category })),
      };
    }
  }

  // Nutrition
  if (scopes.nutrition) {
    const s = await db.collection("nutrition").doc(uid).get();
    if (s.exists) {
      const n = s.data() || {};
      ctx.nutrition = {
        goals: n?.goals ?? null,
        pantrySample: (n?.pantry ?? []).slice(0, 15),
        recentMeals: (n?.meals ?? []).slice(-7),
      };
    }
  }

  // Planning
  if (scopes.planning) {
    const s = await db.collection("planning").doc(uid).get();
    if (s.exists) {
      const p = s.data() || {};
      ctx.planning = {
        upcoming: (p?.reminders ?? [])
          .filter((r:any)=> !!r.due)
          .sort((a:any,b:any)=> (a.due||"").localeCompare(b.due||""))
          .slice(0,10),
        habits: (p?.habits ?? []).slice(0,10),
        openTasks: (p?.tasks ?? []).filter((t:any)=> t.status !== "done").slice(0,10),
      };
    }
  }

  // Fitness
  if (scopes.fitness) {
    const s = await db.collection("fitness").doc(uid).get();
    if (s.exists) {
      const f = s.data() || {};
      ctx.fitness = {
        metrics: f?.metrics ?? null,
        weeklyPlan: f?.weeklyPlan ?? [],
      };
    }
  }

  return ctx;
}

router.post("/ai/respond", async (req, res) => {
  try {
    const authHeader = req.headers.authorization || "";
    const idToken = authHeader.replace("Bearer ", "");
    if (!idToken) return res.status(401).json({ error: "Missing ID token" });

    const decoded = await admin.auth().verifyIdToken(idToken);
    const uid = decoded.uid;

    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Bad request", issues: parsed.error.issues });
    }

    // Enforce stored consent (server-side)
    const userDoc = await admin.firestore().collection("users").doc(uid).get();
    const settings = userDoc.data()?.settings || {};
    const allowed = settings.aiScopes || { budget:false, nutrition:false, planning:false, fitness:false };

    const requested = parsed.data.scopes || {};
    const effectiveScopes = {
      budget: !!allowed.budget && !!(requested.budget ?? true),
      nutrition: !!allowed.nutrition && !!(requested.nutrition ?? true),
      planning: !!allowed.planning && !!(requested.planning ?? true),
      fitness: !!allowed.fitness && !!(requested.fitness ?? true),
    };

    const context = await buildUserContext(uid, effectiveScopes);

    const system = [
      "You are Flowly AI inside a lifestyle app.",
      "Use USER_CONTEXT when relevant. If numbers are missing, say so plainly and propose next steps.",
      "Be concise, practical, and never invent data.",
      `USER_CONTEXT (trimmed): ${JSON.stringify(context).slice(0,6000)}`
    ].join(" ");

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.4,
      messages: [
        { role: "system", content: system },
        { role: "user", content: parsed.data.message }
      ],
    });

    const text = completion.choices?.[0]?.message?.content ?? "Sorry — I couldn’t generate a response.";
    res.json({
      text,
      usedScopes: effectiveScopes,
      contextSizes: Object.fromEntries(Object.entries(context).map(([k,v])=>[k, JSON.stringify(v).length])),
    });
  } catch (e:any) {
    console.error(e);
    res.status(500).json({ error: "AI error", detail: e?.message || String(e) });
  }
});

export default router;
