// index.mjs
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
  const timer = setTimeout(() => ctrl.abort(`${label} timed out after ${ms}ms`), ms);
  return Promise.race([
    promise(ctrl.signal),
    new Promise((_, rej) => {
      const err = new Error(`${label} timed out`);
      // @ts-ignore
      err.code = "ETIMEOUT";
      setTimeout(() => rej(err), ms);
    }),
  ]).finally(() => clearTimeout(timer));
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

/* Small date helpers */
const toISO = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

const daysBetween = (a, b) => {
  const da = typeof a === "string" ? new Date(a) : a;
  const db = typeof b === "string" ? new Date(b) : b;
  return Math.round((db - da) / 86400000);
};

const addDays = (d, n) => {
  const dt = new Date(typeof d === "string" ? d : d.getTime());
  dt.setDate(dt.getDate() + n);
  return toISO(dt);
};

/* ============================================================================
 * Plaid setup
 * ==========================================================================*/
const PLAID_ENV = (process.env.PLAID_ENV || "sandbox").trim(); // 'sandbox' | 'development' | 'production'

// Core products via PLAID_PRODUCTS (e.g. "transactions")
const PRODUCTS = (process.env.PLAID_PRODUCTS || "transactions")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// (We no longer send additional_consented_products to avoid INVALID_FIELD)
const ADDITIONAL_PRODUCTS = (process.env.PLAID_ADDITIONAL_PRODUCTS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// iOS OAuth redirect page hosted on this server
const PLAID_REDIRECT_URI = (process.env.PLAID_REDIRECT_URI || "").trim();

// Optional Link customization
const LINK_CUSTOMIZATION = (process.env.PLAID_LINK_CUSTOMIZATION || "").trim();
console.log("Using Plaid Link customization =", LINK_CUSTOMIZATION || "(none)");

const plaidConfig = new Configuration({
  basePath: PlaidEnvironments[PLAID_ENV],
  baseOptions: {
    headers: {
      "PLAID-CLIENT-ID": process.env.PLAID_CLIENT_ID || "",
      "PLAID-SECRET": process.env.PLAID_SECRET || "",
    },
    timeout: 20000,
  },
});
const plaid = new PlaidApi(plaidConfig);

/* ============================================================================
 * Diagnostics
 * ==========================================================================*/
app.get("/", (_req, res) => res.send("Flowly server is running"));
app.get("/api/health", (_req, res) => res.json({ ok: true, ts: Date.now() }));

app.get("/api/env-check", (_req, res) =>
  res.json({
    env: PLAID_ENV,
    products: PRODUCTS,
    additional_products: ADDITIONAL_PRODUCTS, // informational only
    hasClientId: !!process.env.PLAID_CLIENT_ID,
    hasSecret: !!process.env.PLAID_SECRET,
    redirectUri: PLAID_REDIRECT_URI || null,
    androidPackageName: null,
    linkCustomization: LINK_CUSTOMIZATION || null,
    using: PLAID_REDIRECT_URI ? `redirect_uri=${PLAID_REDIRECT_URI}` : "(none)",
    hasOpenAI: !!(process.env.OPENAI_API_KEY || process.env.EXPO_PUBLIC_OPENAI_API_KEY),
  })
);

/* ============================================================================
 * OAuth return page → deeplink back to the native app (flowlyapp://)
 * ==========================================================================*/
app.get("/plaid-oauth", (req, res) => {
  const scheme = "flowlyapp";
  const qs =
    Object.keys(req.query || {}).length
      ? `?${new URLSearchParams(req.query).toString()}`
      : "";
  const appDeeplink = `${scheme}://plaid-oauth${qs}`;

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<!doctype html>
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Returning to Flowly…</title>
<p>Returning to Flowly…</p>
<script>location.replace(${JSON.stringify(appDeeplink)});</script>
<meta http-equiv="refresh" content="0;url='${appDeeplink}'">`);
});

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
        // @ts-ignore
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
 * 12-month transactions (cached)
 * ==========================================================================*/

// 60s in-memory cache
const TXN_CACHE = new Map(); // key: userId -> { ts: number, txns: NormalizedTxn[] }
const CACHE_TTL_MS = 60_000;

function normalizeTxn(t) {
  const expense = t.amount > 0;
  const pfcPrimary = t.personal_finance_category?.primary?.toLowerCase?.() || null;
  return {
    id: t.transaction_id,
    date: t.date,
    amount: expense ? -Math.abs(t.amount) : Math.abs(t.amount),
    categoryId: pfcPrimary || "uncategorized",
    pfcPrimary,
    merchant: t.merchant_name || t.name || "Transaction",
    type: expense ? "expense" : "income",
    website: t.website,
    counterparties: t.counterparties,
  };
}

// Pull full 12 months with pagination every time cache expires
async function fetchTransactions12m(access_token) {
  const end = new Date();
  const start = new Date(end.getTime() - 365 * 24 * 60 * 60 * 1000);

  const all = [];
  let offset = 0;
  const count = 500;

  while (true) {
    const resp = await plaid.transactionsGet({
      access_token,
      start_date: toISO(start),
      end_date: toISO(end),
      options: {
        include_personal_finance_category: true,
        count,
        offset,
      },
    });

    const tx = resp.data.transactions || [];
    all.push(...tx);

    const total = resp.data.total_transactions ?? all.length;
    if (all.length >= total || tx.length === 0) break;

    offset += tx.length;
    if (offset > 10000) break; // ultra-safety guard
  }

  return all.map(normalizeTxn);
}

async function getAllTransactionsOnce({ userId, access_token }) {
  const hit = TXN_CACHE.get(userId);
  if (hit && Date.now() - hit.ts < CACHE_TTL_MS) return hit.txns;

  // Try to advance cursor quietly (not required for 12mo backfill)
  try {
    let cursor = await getCursor(userId);
    let hasMore = true;
    while (hasMore) {
      const sync = await plaid.transactionsSync({
        access_token,
        cursor: cursor || undefined,
        count: 500,
      });
      cursor = sync.data.next_cursor;
      hasMore = !!sync.data.has_more;
    }
    await setUserCursor(userId, cursor);
  } catch (e) {
    console.log("transactionsSync warm-up failed (non-fatal):", toText(e?.response?.data || e?.message || e));
  }

  const txns = await fetchTransactions12m(access_token);
  TXN_CACHE.set(userId, { ts: Date.now(), txns });
  return txns;
}

/* ============================================================================
 * Recurring detection (fallback heuristics)
 * ==========================================================================*/

// Whitelists (known good)
const SUB_BRANDS = [
  "netflix","spotify","hulu","disney","hbomax","max","youtube","youtube premium","apple.com/bill",
  "adobe","microsoft","onedrive","dropbox","icloud","prime","audible","google","openai",
  "canva","notion","github","xbox","playstation","nintendo","crunchyroll","pandora","paramount",
  "peacock","showtime","headspace","calm","duolingo","uber one","lyft pink","hbo","paramount+","paramount plus"
];

const BILL_BRANDS = [
  "xfinity","comcast","verizon","at&t","att","t-mobile","tmobile","spectrum","wow internet",
  "geico","state farm","progressive","allstate","liberty mutual","usaa",
  "edison","pg&e","pge","con edison","coned","duke energy","fpl","water","utilities","utility",
  "mortgage","rent","loan","navient","nelnet"
];

// Obvious one-offs to exclude unless whitelisted
const EXCLUDE_HINTS = [
  "mcdonald","burger king","wendy's","taco bell","chipotle","starbucks","dunkin","subway",
  "chick-fil-a","panda express","little caesars","domino","pizza hut","kfc","arby's","sonic",
  "wawa","raceway","race trac","racetrac","shell","bp","chevron","marathon","exxon","valero","circle k","7-eleven","7 eleven",
  "walmart","target","costco","safeway","kroger","heb","meijer","whole foods","aldi","publix","tom thumb","winco","food lion"
];

// PFC categories to exclude unless on whitelist
const EXCLUDE_PFC = [
  "restaurants","fast food","food and drink","gas","fuel","grocery","general merchandise","shopping"
];

function monthlyGaps(dates) {
  let count = 0;
  if (dates.length < 2) return 0;
  const sorted = [...dates].sort((a, b) => new Date(a) - new Date(b));
  for (let i = 1; i < sorted.length; i++) {
    const gap = daysBetween(sorted[i - 1], sorted[i]);
    if (gap >= 25 && gap <= 35) count += 1;
  }
  return count;
}
function looksMonthly(dates) { return monthlyGaps(dates) >= 1; }
function dateSpanDays(dates) {
  if (!dates.length) return 0;
  const sorted = [...dates].sort((a, b) => new Date(a) - new Date(b));
  return daysBetween(sorted[0], sorted[sorted.length - 1]);
}
function nextMonthlyFrom(lastISO) { return addDays(lastISO, 30); }

function pickWebsiteFromNormalized(t) {
  if (t.website) return t.website;
  const cp = Array.isArray(t.counterparties) ? t.counterparties[0] : null;
  return cp?.website || null;
}
function buildItem({ id, name, amount, date, cycle, website, counterparties }) {
  return {
    id,
    name,
    amount: Math.abs(Number(amount || 0)),
    cycle, // 'monthly' | 'annual'
    nextCharge: cycle === "monthly" ? nextMonthlyFrom(date) : addDays(date, 365),
    website: website || null,
    counterparties: counterparties || undefined,
    alerts: false,
  };
}
function groupByMerchantNormalized(txns) {
  const map = new Map();
  for (const t of txns) {
    const merch = (t.merchant || "Unknown").trim();
    const key = merch.toLowerCase();
    if (!map.has(key)) map.set(key, { name: merch, rows: [] });
    map.get(key).rows.push(t);
  }
  return map;
}
function merchantMatches(key, list) { return list.some((brand) => key.includes(brand)); }
function topCategoryPrimary(rows) {
  const counts = new Map();
  for (const r of rows) {
    const c = (r.pfcPrimary || r.categoryId || "").toLowerCase();
    if (!c) continue;
    counts.set(c, (counts.get(c) || 0) + 1);
  }
  let top = null, max = 0;
  for (const [k, v] of counts) { if (v > max) { max = v; top = k; } }
  return top;
}
function coefVar(nums) {
  if (!nums.length) return Infinity;
  const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
  if (mean === 0) return Infinity;
  const variance = nums.reduce((s, x) => s + Math.pow(x - mean, 2), 0) / nums.length;
  const std = Math.sqrt(variance);
  return std / Math.abs(mean);
}

function deriveSubscriptionsFromTxns(txns) {
  const expenses = txns
    .filter((t) => t.type === "expense")
    .map((t) => ({ ...t, amount: Math.abs(t.amount) }));

  const byMerchant = groupByMerchantNormalized(expenses);
  const out = [];

  for (const [key, group] of byMerchant.entries()) {
    const amounts = group.rows.map((r) => r.amount).sort((a, b) => a - b);
    const median = amounts[Math.floor(amounts.length / 2)] || 0;
    const dates = group.rows.map((r) => r.date);
    const span = dateSpanDays(dates);
    const gapsMonthly = monthlyGaps(dates);
    const name = group.name;

    const topPFC = topCategoryPrimary(group.rows) || "";
    const isKnownSub = merchantMatches(key, SUB_BRANDS);
    const isKnownBill = merchantMatches(key, BILL_BRANDS);
    const excludedByName = merchantMatches(key, EXCLUDE_HINTS);
    const excludedByPFC = EXCLUDE_PFC.some((c) => topPFC.includes(c));
    if ((excludedByName || excludedByPFC) && !isKnownSub) continue;

    const occ = group.rows.length;
    const cv = coefVar(amounts);

    const passesKnown = isKnownSub && occ >= 2 && (gapsMonthly >= 1 || span >= 45);
    const passesUnknown = !isKnownSub && !isKnownBill && occ >= 3 && span >= 60 && gapsMonthly >= 1;
    const stable = (isKnownSub ? cv <= 0.40 : cv <= 0.30);

    if ((passesKnown || passesUnknown) && stable) {
      const latest = group.rows.sort((a, b) => new Date(b.date) - new Date(a.date))[0];
      out.push(
        buildItem({
          id: `sub:${key}:${Math.round(median * 100)}`,
          name,
          amount: median,
          date: latest.date,
          cycle: "monthly",
          website: pickWebsiteFromNormalized(latest),
          counterparties: latest.counterparties,
        })
      );
    }
  }

  const uniq = new Map();
  for (const s of out) if (!uniq.has(s.id)) uniq.set(s.id, s);
  return Array.from(uniq.values()).slice(0, 50);
}

function deriveBillsFromTxns(txns) {
  const expenses = txns
    .filter((t) => t.type === "expense")
    .map((t) => ({ ...t, amount: Math.abs(t.amount) }));

  const byMerchant = groupByMerchantNormalized(expenses);
  const out = [];

  for (const [key, group] of byMerchant.entries()) {
    const name = group.name;
    const dates = group.rows.map((r) => r.date);
    const span = dateSpanDays(dates);
    const gapsMonthly = monthlyGaps(dates);
    const amounts = group.rows.map((r) => r.amount).sort((a, b) => a - b);
    const median = amounts[Math.floor(amounts.length / 2)] || 0;

    const topPFC = topCategoryPrimary(group.rows) || "";
    const isKnownBill = merchantMatches(key, BILL_BRANDS);
    const isKnownSub = merchantMatches(key, SUB_BRANDS);
    const excludedByName = merchantMatches(key, EXCLUDE_HINTS);
    const excludedByPFC = EXCLUDE_PFC.some((c) => topPFC.includes(c));
    if ((excludedByName || excludedByPFC) && !isKnownBill) continue;

    const occ = group.rows.length;
    const cv = coefVar(amounts);

    const passesKnown = isKnownBill && occ >= 2 && (gapsMonthly >= 1 || span >= 45);
    const passesUnknown = !isKnownBill && !isKnownSub && occ >= 3 && span >= 60 && gapsMonthly >= 1;
    const stable = cv <= 0.60;

    if ((passesKnown || passesUnknown) && stable) {
      const latest = group.rows.sort((a, b) => new Date(b.date) - new Date(a.date))[0];
      out.push(
        buildItem({
          id: `bill:${key}:${Math.round(median * 100)}`,
          name,
          amount: median,
          date: latest.date,
          cycle: "monthly",
          website: pickWebsiteFromNormalized(latest),
          counterparties: latest.counterparties,
        })
      );
    }
  }

  const uniq = new Map();
  for (const b of out) if (!uniq.has(b.id)) uniq.set(b.id, b);
  return Array.from(uniq.values()).slice(0, 50);
}

/* ============================================================================
 * Recurring streams (Plaid product)
 * ==========================================================================*/
const STREAMS_CACHE_TTL = 10 * 60 * 1000; // 10 minutes
const STREAMS_CACHE = new Map(); // key: userId -> { ts, streams }

function freqToInfo(freq) {
  const f = String(freq || "").toUpperCase();
  if (f === "WEEKLY") return { days: 7, cycle: "monthly" };
  if (f === "BIWEEKLY") return { days: 14, cycle: "monthly" };
  if (f === "SEMI_MONTHLY") return { days: 15, cycle: "monthly" };
  if (f === "MONTHLY") return { days: 30, cycle: "monthly" };
  if (f === "QUARTERLY") return { days: 90, cycle: "monthly" };
  if (f === "ANNUALLY" || f === "YEARLY") return { days: 365, cycle: "annual" };
  return { days: 30, cycle: "monthly" };
}

function classifyStream(s) {
  const name = (s.merchant_name || s.description || "").toLowerCase();
  const pfcPrimary = s.personal_finance_category?.primary?.toLowerCase?.() || "";
  const categories = (Array.isArray(s.category) ? s.category : []).map((c) => String(c).toLowerCase());
  const freq = String(s.frequency || "").toUpperCase();

  const subscriptionHints = [
    "netflix","hulu","disney","spotify","youtube","openai","adobe",
    "dropbox","onedrive","icloud","prime","audible","canva","notion",
    "xbox","playstation","paramount","peacock","pandora","crunchyroll",
  ];
  const billHints = [
    "xfinity","comcast","verizon","t-mobile","tmobile","at&t","att",
    "spectrum","geico","state farm","progressive","usaa","allstate",
    "mortgage","rent","loan","utilities","utility","power","electric",
    "water","gas","energy","duke energy","fpl","edison","pge","coned",
  ];

  const nameHas = (arr) => arr.some((kw) => name.includes(kw));
  const catHas = (kw) => categories.some((c) => c.includes(kw));
  const monthlyish = ["WEEKLY","BIWEEKLY","SEMI_MONTHLY","MONTHLY","QUARTERLY","ANNUALLY","YEARLY"].includes(freq);

  const pfcLooksSubscription =
    pfcPrimary.includes("subscription") || pfcPrimary.includes("entertainment");
  const pfcLooksBill =
    pfcPrimary.includes("services") ||
    pfcPrimary.includes("telecommunication") ||
    pfcPrimary.includes("insurance") ||
    pfcPrimary.includes("rent") ||
    pfcPrimary.includes("loan") ||
    pfcPrimary.includes("utilities");

  const looksBill =
    pfcLooksBill || nameHas(billHints) || catHas("utilities") || catHas("telecommunication") ||
    catHas("insurance") || catHas("service") || catHas("mortgage") || catHas("rent") || catHas("loan");

  const looksSubscription =
    pfcLooksSubscription || (monthlyish && (nameHas(subscriptionHints) || catHas("subscription") || catHas("entertainment")));

  if (looksBill && !looksSubscription) return "bill";
  if (looksSubscription && !looksBill) return "subscription";
  if (nameHas(subscriptionHints)) return "subscription";
  if (nameHas(billHints)) return "bill";
  return "subscription";
}

const toDollars = (n) => Math.round(Number(n || 0) * 100) / 100;

async function getRecurringStreamsOnce({ userId, access_token }) {
  const hit = STREAMS_CACHE.get(userId);
  if (hit && Date.now() - hit.ts < STREAMS_CACHE_TTL) return hit.streams;

  const r = await plaid.transactionsRecurringGet({ access_token });
  const streams = r.data?.streams || [];
  STREAMS_CACHE.set(userId, { ts: Date.now(), streams });
  return streams;
}

/* ============================================================================
 * Plaid routes
 * ==========================================================================*/

// Create Link Token — iOS-only; **no additional_consented_products** to avoid INVALID_FIELD
app.post("/api/create_link_token", async (req, res) => {
  try {
    const client_user_id = String(req.body?.userId || "demo-user");

    if (!PLAID_REDIRECT_URI) {
      return res.status(400).json({
        error: "missing_redirect_uri",
        hint: "Set PLAID_REDIRECT_URI to your HTTPS page, e.g. https://<your-domain>/plaid-oauth",
      });
    }

    const payload = {
      user: { client_user_id },
      client_name: "Flowly",
      products: PRODUCTS,
      country_codes: ["US"],
      language: "en",
      redirect_uri: PLAID_REDIRECT_URI,
      ...(LINK_CUSTOMIZATION ? { link_customization_name: LINK_CUSTOMIZATION } : {}),
    };

    console.log("linkTokenCreate (iOS-only) keys:", Object.keys(payload).sort());
    const resp = await plaid.linkTokenCreate(payload);
    return res.json({ link_token: resp.data.link_token, platform: "ios" });
  } catch (e) {
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

// Transactions (returns full 12 months, cached 60s)
app.get("/api/transactions", async (req, res) => {
  try {
    const userId = String(req.query.userId || "demo-user");
    const user = await getUserById(userId);
    if (!user?.access_token) return res.status(400).json({ error: "no_linked_item" });

    const txns = await getAllTransactionsOnce({ userId, access_token: user.access_token });
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
    const code = e?.response?.data?.error_code || e?.error_code;
    if (code === "PRODUCT_NOT_READY") {
      return res.status(202).json({ pending: true });
    }
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
      if (userId) STREAMS_CACHE.delete(userId); // bust streams cache on sync updates too
    }
    if (webhook_type === "TRANSACTIONS" && webhook_code === "RECURRING_TRANSACTIONS_UPDATE") {
      const userId = await getUserIdByItemId(item_id);
      if (userId) STREAMS_CACHE.delete(userId);
    }
    res.json({ ok: true });
  } catch (e) {
    console.error("webhook error", e);
    res.status(200).json({ ok: true });
  }
});

/* ===== One-shot snapshot (txns + derived subs + derived bills) ===== */
app.get("/api/budget_snapshot", async (req, res) => {
  try {
    const userId = String(req.query.userId || "demo-user");
    const user = await getUserById(userId);
    if (!user?.access_token) return res.status(400).json({ error: "no_linked_item" });

    const txns = await getAllTransactionsOnce({ userId, access_token: user.access_token });
    const [subs, bills] = await Promise.all([
      deriveSubscriptionsFromTxns(txns),
      deriveBillsFromTxns(txns),
    ]);

    res.json({
      txns,
      subscriptions: subs.map((s) => ({
        id: s.id,
        name: s.name,
        amount: s.amount,
        cycle: s.cycle,
        nextCharge: s.nextCharge,
        isPaused: false,
        alerts: false,
        website: s.website || null,
        counterparties: s.counterparties || undefined,
      })),
      bills: bills.map((b) => ({
        id: b.id,
        name: b.name,
        amount: b.amount,
        dueDate: b.nextCharge,
        autopay: false,
        alerts: false,
        website: b.website || null,
        counterparties: b.counterparties || undefined,
      })),
    });
  } catch (e) {
    return sendPlaidError(res, e);
  }
});

/* ===== Subscriptions & Bills via Plaid Recurring Streams ===== */
app.get("/api/subscriptions", async (req, res) => {
  try {
    const userId = String(req.query.userId || "demo-user");
    const user = await getUserById(userId);
    if (!user?.access_token) return res.status(400).json({ error: "no_linked_item" });

    const streams = await getRecurringStreamsOnce({ userId, access_token: user.access_token });

    const subs = [];
    for (const s of streams) {
      if (classifyStream(s) !== "subscription") continue;

      const { days, cycle } = freqToInfo(s.frequency);
      const next =
        s.next_date ||
        (s.last_date ? addDays(s.last_date, days) : (s.first_date ? addDays(s.first_date, days) : toISO(new Date())));

      subs.push({
        id: s.stream_id,
        name: s.merchant_name || s.description || "Subscription",
        amount: toDollars(s.last_amount ?? s.average_amount ?? 0),
        cycle: cycle === "annual" ? "annual" : "monthly",
        nextCharge: next,
        isPaused: s.is_active === false,
        alerts: false,
        website: s.website || null,
        logo_url: s.logo_url || undefined,
        counterparties: s.counterparties || undefined,
      });
    }

    res.json({ subscriptions: subs });
  } catch (e) {
    const code = e?.response?.data?.error_code || e?.error_code;
    if (code === "PRODUCT_NOT_READY") return res.status(202).json({ error: "PRODUCT_NOT_READY" });
    return sendPlaidError(res, e);
  }
});

app.get("/api/bills", async (req, res) => {
  try {
    const userId = String(req.query.userId || "demo-user");
    const user = await getUserById(userId);
    if (!user?.access_token) return res.status(400).json({ error: "no_linked_item" });

    const streams = await getRecurringStreamsOnce({ userId, access_token: user.access_token });

    const bills = [];
    for (const s of streams) {
      if (classifyStream(s) !== "bill") continue;

      const { days } = freqToInfo(s.frequency);
      const next =
        s.next_date ||
        (s.last_date ? addDays(s.last_date, days) : (s.first_date ? addDays(s.first_date, days) : toISO(new Date())));

      bills.push({
        id: s.stream_id,
        name: s.merchant_name || s.description || "Bill",
        amount: toDollars(s.last_amount ?? s.average_amount ?? 0),
        dueDate: next,
        autopay: false,
        variable: false,
        alerts: false,
        website: s.website || null,
        logo_url: s.logo_url || undefined,
        counterparties: s.counterparties || undefined,
      });
    }

    res.json({ bills });
  } catch (e) {
    const code = e?.response?.data?.error_code || e?.error_code;
    if (code === "PRODUCT_NOT_READY") return res.status(202).json({ error: "PRODUCT_NOT_READY" });
    return sendPlaidError(res, e);
  }
});

/* ===== Debug endpoint (streams + fallback comparison) ===== */
app.get("/api/debug/recurring", async (req, res) => {
  try {
    const userId = String(req.query.userId || "demo-user");
    const user = await getUserById(userId);
    if (!user?.access_token) return res.status(400).json({ error: "no_linked_item" });

    const [streams, txns] = await Promise.all([
      getRecurringStreamsOnce({ userId, access_token: user.access_token }),
      getAllTransactionsOnce({ userId, access_token: user.access_token }),
    ]);

    const subsFallback = deriveSubscriptionsFromTxns(txns);
    const billsFallback = deriveBillsFromTxns(txns);

    const subsStreams = [];
    const billsStreams = [];
    for (const s of streams) {
      const kind = classifyStream(s);
      const { days, cycle } = freqToInfo(s.frequency);
      const next =
        s.next_date ||
        (s.last_date ? addDays(s.last_date, days) : (s.first_date ? addDays(s.first_date, days) : toISO(new Date())));
      const base = {
        id: s.stream_id,
        name: s.merchant_name || s.description || "Recurring",
        amount: toDollars(s.last_amount ?? s.average_amount ?? 0),
        cycle: cycle === "annual" ? "annual" : "monthly",
        next,
      };
      if (kind === "subscription") subsStreams.push(base);
      else if (kind === "bill") billsStreams.push(base);
    }

    res.json({
      streams: {
        subscriptions: subsStreams,
        bills: billsStreams,
        totalStreams: streams.length,
      },
      fallback: {
        subscriptions: subsFallback,
        bills: billsFallback,
      },
      meta: { txns: txns.length },
    });
  } catch (e) {
    return sendPlaidError(res, e);
  }
});

/* ============================================================================
 * Start
 * ==========================================================================*/
app.listen(PORT, () => {
  console.log(`Flowly server running on http://localhost:${PORT}`);
});
