import bodyParser from "body-parser";
import cors from "cors";
import "dotenv/config";
import express from "express";
import { Configuration, PlaidApi, PlaidEnvironments } from "plaid";
import {
  getCursor,
  getUserById,
  getUserIdByItemId,
  setUserCursor,
  upsertUserItem,
} from "./firebase.mjs";

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: "1mb" }));

const PORT = process.env.PORT || 3000;

/* ============================================================================
 * Helpers
 * ==========================================================================*/
function withTimeout(promise, ms = 25000, label = "operation") {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(`${label} timed out after ${ms}ms`), ms);
  return Promise.race([
    promise(ctrl.signal),
    new Promise((_, rej) => {
      const err = new Error(`${label} timed out`);
      err.code = "ETIMEOUT";
      setTimeout(() => rej(err), ms);
    }),
  ]).finally(() => clearTimeout(t));
}

function toText(v) {
  if (typeof v === "string") return v;
  try { return JSON.stringify(v); } catch { return String(v ?? ""); }
}

function sendError(res, e, status = 500) {
  const msg = e?.response?.data || e?.message || String(e);
  console.error("API error →", msg);
  res.status(e?.response?.status || status).json({ error: toText(msg) });
}

function sendPlaidError(res, err, fallbackStatus = 500) {
  const details = err?.response?.data || { message: String(err?.message || err) };
  console.error("Plaid error →", details);
  res.status(err?.response?.status || fallbackStatus).json(details);
}

/* ============================================================================
 * Plaid setup
 * ==========================================================================*/
const PLAID_ENV = (process.env.PLAID_ENV || "sandbox").trim(); // 'sandbox' | 'development' | 'production'
const PRODUCTS = (process.env.PLAID_PRODUCTS || "transactions")
  .split(",").map(s => s.trim()).filter(Boolean);

const PLAID_REDIRECT_URI = (process.env.PLAID_REDIRECT_URI || "").trim();
const ANDROID_PACKAGE_NAME = (process.env.ANDROID_PACKAGE_NAME || "").trim();

const plaidConfig = new Configuration({
  basePath: PlaidEnvironments[PLAID_ENV],
  baseOptions: {
    headers: {
      "PLAID-CLIENT-ID": process.env.PLAID_CLIENT_ID || "",
      "PLAID-SECRET": process.env.PLAID_SECRET || "",
      "Plaid-Version": "2020-09-14",
    },
    timeout: 20000,
  },
});
const plaid = new PlaidApi(plaidConfig);

/* ============================================================================
 * Diagnostics
 * ==========================================================================*/
app.get("/api/health", (_req, res) => res.json({ ok: true, ts: Date.now() }));

app.get("/api/env-check", (_req, res) =>
  res.json({
    env: PLAID_ENV,
    products: PRODUCTS,
    hasClientId: !!process.env.PLAID_CLIENT_ID,
    hasSecret: !!process.env.PLAID_SECRET,
    redirectUri: PLAID_REDIRECT_URI || null,
    androidPackageName: ANDROID_PACKAGE_NAME || null,
    using:
      ANDROID_PACKAGE_NAME
        ? `android_package_name=${ANDROID_PACKAGE_NAME}`
        : (PLAID_REDIRECT_URI ? `redirect_uri=${PLAID_REDIRECT_URI}` : "(none)"),
    hasOpenAI: !!(process.env.OPENAI_API_KEY || process.env.EXPO_PUBLIC_OPENAI_API_KEY),
  })
);

/* ============================================================================
 * (Optional) Chat endpoints
 * ==========================================================================*/
app.post("/api/ai/chat-echo", (req, res) => {
  const { text } = req.body || {};
  return res.json({ text: `ECHO: ${text ?? ""}`, usedScopes: {} });
});

app.post("/api/ai/chat", async (req, res) => {
  const { text, scopes } = req.body || {};
  if (!text) return res.status(400).json({ error: "Missing 'text'." });

  const apiKey = process.env.OPENAI_API_KEY || process.env.EXPO_PUBLIC_OPENAI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "Missing OPENAI_API_KEY" });

  try {
    const result = await withTimeout(async (signal) => {
      const r = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: "gpt-5",
          messages: [
            { role: "system", content: "You are Flowly AI. Be concise and helpful." },
            { role: "user", content: text },
          ],
          temperature: 0.4,
        }),
        signal,
      });
      if (!r.ok) {
        const body = await r.text().catch(() => "");
        const err = new Error(`Upstream ${r.status} ${r.statusText} ${body}`);
        err.status = r.status;
        throw err;
      }
      return r.json();
    }, 23000, "OpenAI request");

    const out = result?.choices?.[0]?.message?.content ?? "";
    return res.json({ text: out, usedScopes: scopes || {} });
  } catch (e) {
    return sendError(res, e);
  }
});

/* ============================================================================
 * Plaid routes
 * ==========================================================================*/

// Create Link Token — decide per request based on platform
app.post("/api/create_link_token", async (req, res) => {
  try {
    const client_user_id = String(req.body?.userId || "demo-user");
    const platform = String(req.body?.platform || "").toLowerCase(); // 'ios' | 'android'

    const base = {
      user: { client_user_id },
      client_name: "Flowly",
      products: PRODUCTS,
      country_codes: ["US"],
      language: "en",
    };

    let extras = {};
    if (platform === "ios") {
      if (!PLAID_REDIRECT_URI) {
        return res.status(400).json({
          error: "missing_redirect_uri",
          hint: "Set PLAID_REDIRECT_URI to https://<your-domain>/plaid-oauth",
        });
      }
      extras = { redirect_uri: PLAID_REDIRECT_URI };
    } else if (platform === "android") {
      if (!ANDROID_PACKAGE_NAME) {
        return res.status(400).json({
          error: "missing_android_package_name",
          hint: "Set ANDROID_PACKAGE_NAME (e.g. com.seanjones.flowlyapp)",
        });
      }
      extras = { android_package_name: ANDROID_PACKAGE_NAME };
    } else {
      return res.status(400).json({
        error: "invalid_platform",
        hint: "Pass platform as 'ios' or 'android'.",
      });
    }

    const resp = await plaid.linkTokenCreate({ ...base, ...extras });
    res.json({ link_token: resp.data.link_token, platform });
  } catch (e) {
    const code = e?.response?.data?.error_code;

    if (code === "INVALID_FIELD") {
      try {
        const client_user_id = String(req.body?.userId || "demo-user");
        const fallback = await plaid.linkTokenCreate({
          user: { client_user_id },
          client_name: "Flowly",
          products: PRODUCTS,
          country_codes: ["US"],
          language: "en",
        });
        return res.json({ link_token: fallback.data.link_token, fallback: true });
      } catch (e2) { return sendPlaidError(res, e2); }
    }

    if (code === "PRODUCTS_NOT_ENABLED") {
      try {
        const client_user_id = String(req.body?.userId || "demo-user");
        const retry = await plaid.linkTokenCreate({
          user: { client_user_id },
          client_name: "Flowly",
          products: ["balance"],
          country_codes: ["US"],
          language: "en",
        });
        return res.json({ link_token: retry.data.link_token, downgraded_to: "balance" });
      } catch (e3) { return sendPlaidError(res, e3); }
    }

    return sendPlaidError(res, e);
  }
});

// Exchange public_token -> access_token
app.post("/api/exchange_public_token", async (req, res) => {
  try {
    const userId = String(req.body?.userId || "demo-user");
    const { public_token } = req.body || {};
    if (!public_token) return res.status(400).json({ error: "missing_public_token" });

    const r = await plaid.itemPublicTokenExchange({ public_token });
    const { access_token, item_id } = r.data;

    await upsertUserItem({ userId, access_token, item_id });
    res.json({ ok: true, item_id });
  } catch (e) {
    return sendPlaidError(res, e);
  }
});

// Transactions via /transactions/sync
app.get("/api/transactions", async (req, res) => {
  try {
    const userId = String(req.query.userId || "demo-user");
    const user = await getUserById(userId);
    if (!user?.access_token) return res.status(400).json({ error: "no_linked_item" });

    let cursor = await getCursor(userId);
    let added = [];
    let hasMore = true;

    while (hasMore) {
      const sync = await plaid.transactionsSync({
        access_token: user.access_token,
        cursor: cursor || undefined,
        count: 500,
      });
      added = added.concat(sync.data.added || []);
      cursor = sync.data.next_cursor;
      hasMore = sync.data.has_more;
    }
    await setUserCursor(userId, cursor);

    const txns = added.map((t) => {
      const expense = t.amount > 0;
      const primary = t.personal_finance_category?.primary?.toLowerCase() || "uncategorized";
      return {
        id: t.transaction_id,
        date: t.date,
        amount: expense ? -Math.abs(t.amount) : Math.abs(t.amount),
        categoryId: primary,
        merchant: t.merchant_name || t.name || "Transaction",
        type: expense ? "expense" : "income",
        website: t.website,
        counterparties: t.counterparties,
      };
    });

    res.json({ txns });
  } catch (e) {
    return sendPlaidError(res, e);
  }
});

// Accounts (balances)
app.get("/api/accounts", async (req, res) => {
  try {
    const userId = String(req.query.userId || "demo-user");
    const user = await getUserById(userId);
    if (!user?.access_token) return res.status(400).json({ error: "no_linked_item" });

    const resp = await plaid.accountsBalanceGet({ access_token: user.access_token });

    const accounts = (resp.data.accounts || []).map((a) => ({
      id: a.account_id,
      name: a.name || a.official_name || "Account",
      type: a.subtype || a.type || undefined,
      balance: Number(
        a.balances?.current ??
        a.balances?.available ??
        a.balances?.limit ??
        0
      ),
      mask: a.mask,
      institution: a.official_name || undefined,
    }));

    res.json({ accounts });
  } catch (e) {
    return sendPlaidError(res, e);
  }
});

// Webhook (optional)
app.post("/api/plaid/webhook", async (req, res) => {
  try {
    const { webhook_type, webhook_code, item_id } = req.body || {};
    if (webhook_type === "TRANSACTIONS" && webhook_code === "SYNC_UPDATES_AVAILABLE") {
      const userId = await getUserIdByItemId(item_id);
      console.log("SYNC_UPDATES_AVAILABLE for item", item_id, "user", userId);
    }
    res.json({ ok: true });
  } catch (e) {
    console.error("webhook error", e);
    res.status(200).json({ ok: true });
  }
});

/* ============================================================================
 * Start
 * ==========================================================================*/
app.listen(PORT, () => {
  console.log(`Flowly server running on http://localhost:${PORT}`);
});
