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
  try {
    return JSON.stringify(v);
  } catch {
    return String(v ?? "");
  }
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
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;

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

const PRODUCTS = (process.env.PLAID_PRODUCTS || "transactions")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const ADDITIONAL_PRODUCTS = (process.env.PLAID_ADDITIONAL_PRODUCTS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const PLAID_REDIRECT_URI = (process.env.PLAID_REDIRECT_URI || "").trim();
const ANDROID_PACKAGE_NAME = (process.env.ANDROID_PACKAGE_NAME || "").trim();
const LINK_CUSTOMIZATION = (process.env.PLAID_LINK_CUSTOMIZATION || "").trim();
console.log("Using Plaid Link customization =", LINK_CUSTOMIZATION || "(none)");

const plaidConfig = new Configuration({
  basePath: PlaidEnvironments[PLAID_ENV],
  baseOptions: {
    headers: {
      "PLAID-CLIENT-ID": process.env.PLAID_CLIENT_ID || "",
      "PLAID-SECRET": process.env.PLAID_SECRET || "",
      timeout: 20000,
    },
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
    additional_products: ADDITIONAL_PRODUCTS,
    hasClientId: !!process.env.PLAID_CLIENT_ID,
    hasSecret: !!process.env.PLAID_SECRET,
    redirectUri: PLAID_REDIRECT_URI || null,
    androidPackageName: ANDROID_PACKAGE_NAME || null,
    linkCustomization: LINK_CUSTOMIZATION || null,
    using: ANDROID_PACKAGE_NAME
      ? `android_package_name=${ANDROID_PACKAGE_NAME}`
      : PLAID_REDIRECT_URI
      ? `redirect_uri=${PLAID_REDIRECT_URI}`
      : "(none)",
    hasOpenAI: !!(
      process.env.OPENAI_API_KEY || process.env.EXPO_PUBLIC_OPENAI_API_KEY
    ),
  })
);

/* ============================================================================
 * OAuth return page → deeplink back to the native app (flowlyapp://)
 * ==========================================================================*/
app.get("/plaid-oauth", (req, res) => {
  const scheme = "flowlyapp";
  const qs =
    Object.keys(req.query || {}).length > 0
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

  const apiKey =
    process.env.OPENAI_API_KEY || process.env.EXPO_PUBLIC_OPENAI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "Missing OPENAI_API_KEY" });

  try {
    const result = await withTimeout(
      async (signal) => {
        const r = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: "gpt-5",
            messages: [
              {
                role: "system",
                content: "You are Flowly AI. Be concise and helpful.",
              },
              { role: "user", content: text },
            ],
            temperature: 0.4,
          }),
          signal,
        });
        if (!r.ok) {
          const body = await r.text().catch(() => "");
          const err = new Error(
            `Upstream ${r.status} ${r.statusText} ${body}`
          );
          // @ts-ignore
          err.status = r.status;
          throw err;
        }
        return r.json();
      },
      23000,
      "OpenAI request"
    );

    const out = result?.choices?.[0]?.message?.content ?? "";
    return res.json({ text: out, usedScopes: scopes || {} });
  } catch (e) {
    return sendError(res, e);
  }
});

/* ============================================================================
 * ONE-PULL CORE (cache + single normalized fetch)
 * ==========================================================================*/

// 60s in-memory cache for normalized transactions
const TXN_CACHE = new Map(); // key: userId -> { ts: number, txns: NormalizedTxn[] }
const CACHE_TTL_MS = 60_000;

/* ============================================================================
 * In-memory recurring overrides (per user, per merchant)
 * ==========================================================================*/

const RECURRING_OVERRIDE_TYPES = new Set(["subscription", "bill", "never"]);
const RECURRING_OVERRIDES = new Map(); // key: `${userId}::${normalizedMerchant}` -> overrideType

function makeOverrideKey(userId, normalizedMerchant) {
  return `${String(userId)}::${normalizedMerchant}`;
}

function setRecurringOverride({ userId, merchantName, type }) {
  const t = String(type || "").toLowerCase();
  if (!RECURRING_OVERRIDE_TYPES.has(t)) return;
  const norm = normalizeMerchant(merchantName || "");
  if (!norm) return;
  const key = makeOverrideKey(userId, norm);
  RECURRING_OVERRIDES.set(key, t);
}

function getRecurringOverride(userId, merchantNameOrNormalized) {
  const norm = normalizeMerchant(merchantNameOrNormalized || "");
  if (!norm) return null;
  const key = makeOverrideKey(userId, norm);
  return RECURRING_OVERRIDES.get(key) || null;
}

// NEW: helper to accept multiple field names from the client
function extractMerchantName(body) {
  if (!body) return null;

  // 1) Preferred explicit fields
  const direct =
    body.merchantName ||
    body.name ||
    body.merchant ||
    body.normalizedName;

  if (direct && typeof direct === "string" && direct.trim()) {
    return direct.trim();
  }

  // 2) Fallback: pick the first reasonable-looking string field
  const blacklist = new Set([
    "userId",
    "type",
    "id",
    "streamId",
    "transactionId",
    "amount",
    "nextCharge",
    "dueDate",
  ]);

  for (const [key, value] of Object.entries(body)) {
    if (blacklist.has(key)) continue;
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (!trimmed) continue;
    // simple sanity: must contain at least one letter
    if (!/[a-zA-Z]/.test(trimmed)) continue;

    return trimmed;
  }

  return null;
}

function normalizeTxn(t) {
  const expense = t.amount > 0;
  const pfcPrimary =
    t.personal_finance_category?.primary?.toLowerCase?.() || null;

  const merchantName = t.merchant_name || t.name || "Transaction";

  return {
    id: t.transaction_id,
    date: t.date,
    amount: expense ? -Math.abs(t.amount) : Math.abs(t.amount),
    categoryId: pfcPrimary || "uncategorized",
    pfcPrimary,
    merchant: merchantName,
    normalizedName: normalizeMerchant(merchantName),
    type: expense ? "expense" : "income",
    website: t.website,
    counterparties: t.counterparties,
    logo_url:
      t.logo_url ||
      (Array.isArray(t.counterparties) && t.counterparties[0]?.logo_url) ||
      null,
  };
}

async function getAllTransactionsOnce({ userId, access_token }) {
  // In-memory cache for 60s to avoid hammering Plaid when user re-opens Budget quickly
  const hit = TXN_CACHE.get(userId);
  if (hit && Date.now() - hit.ts < CACHE_TTL_MS) return hit.txns;

  // 1) Run /transactions/sync to keep cursor + webhooks working
  let cursor = await getCursor(userId);
  let hasMoreSync = true;

  while (hasMoreSync) {
    const sync = await plaid.transactionsSync({
      access_token,
      cursor: cursor || undefined,
      count: 500,
    });
    const nextCursor = sync.data.next_cursor;
    cursor = nextCursor;
    hasMoreSync = !!sync.data.has_more;
  }

  await setUserCursor(userId, cursor);

  // 2) Always fetch up to last 12 months of history via /transactions/get (with pagination)
  const end = new Date();
  const start = new Date(end.getTime() - 365 * 24 * 60 * 60 * 1000); // ~12 months

  let all = [];
  let offset = 0;
  let hasMorePages = true;

  while (hasMorePages) {
    const resp = await plaid.transactionsGet({
      access_token,
      start_date: toISO(start),
      end_date: toISO(end),
      options: {
        count: 500,
        offset,
        include_personal_finance_category: true,
      },
    });

    const txns = resp.data.transactions || [];
    const total = resp.data.total_transactions || 0;

    all = all.concat(txns);
    offset = all.length;
    hasMorePages = all.length < total;
  }

  const normalized = all.map(normalizeTxn);
  TXN_CACHE.set(userId, { ts: Date.now(), txns: normalized });
  return normalized;
}

/* ============================================================================
 * Recurring detection (heuristics fallback)
 * ==========================================================================*/
// Normalize PFC (personal finance category) strings like "FOOD_AND_DRINK"
function normalizePFCString(s) {
  return String(s || "").toLowerCase().replace(/_/g, " ");
}

// Frequency-aware recency (so old subs/bills drop sooner)
const RECENT_DAYS_GENERIC_CUTOFF = 90;   // fallback
const RECENT_DAYS_MONTHLY_CUTOFF = 60;   // e.g. monthly / weekly / bi-weekly
const RECENT_DAYS_ANNUAL_CUTOFF = 400;   // annual charges

function recentEnough(lastISO, freqHint = "generic") {
  if (!lastISO) return true;
  const cutoff =
    freqHint === "monthly"
      ? RECENT_DAYS_MONTHLY_CUTOFF
      : freqHint === "annual"
      ? RECENT_DAYS_ANNUAL_CUTOFF
      : RECENT_DAYS_GENERIC_CUTOFF;
  return daysBetween(lastISO, new Date()) <= cutoff;
}

// Whitelists (known good subscriptions)
const SUB_BRANDS = [
  "netflix",
  "spotify",
  "hulu",
  "disney",
  "hbomax",
  "max",
  "youtube",
  "youtube premium",
  "apple.com/bill",
  "adobe",
  "microsoft",
  "onedrive",
  "dropbox",
  "icloud",
  "prime",
  "audible",
  "google",
  "openai",
  "canva",
  "notion",
  "github",
  "xbox",
  "playstation",
  "nintendo",
  "crunchyroll",
  "pandora",
  "paramount",
  "peacock",
  "showtime",
  "headspace",
  "calm",
  "duolingo",
  "uber one",
  "lyft pink",
  "hbo",
  "paramount+",
  "paramount plus",
];

// Whitelists (known good bills)
const BILL_BRANDS = [
  "xfinity",
  "comcast",
  "verizon",
  "at&t",
  "att",
  "t-mobile",
  "tmobile",
  "spectrum",
  "wow internet",
  "geico",
  "state farm",
  "progressive",
  "allstate",
  "liberty mutual",
  "usaa",
  "edison",
  "pg&e",
  "pge",
  "con edison",
  "coned",
  "duke energy",
  "fpl",
  "water",
  "utilities",
  "utility",
  "mortgage",
  "rent",
  "loan",
  "navient",
  "nelnet",
];

// Obvious one-off retail/food/gas/grocery/transport/P2P to exclude unless whitelisted
const EXCLUDE_HINTS = [
  // Fast food / chains
  "mcdonald",
  "burger king",
  "wendy's",
  "taco bell",
  "chipotle",
  "starbucks",
  "dunkin",
  "subway",
  "chick-fil-a",
  "panda express",
  "little caesars",
  "domino",
  "pizza hut",
  "kfc",
  "arby's",
  "sonic",
  "whataburger",
  "olive garden",
  "cook out",
  "cookout",
  "steakhouse",
  "burrito",
  "taco ",
  " tacos",
  "wing",
  "bbq",
  "bar & grill",
  "grill",
  "pub",
  "tavern",
  "bistro",
  "cafe",
  "coffee",
  "kitchen",
  "pizza",
  "hungry howie",
  "howie",

  // Gas / convenience
  "wawa",
  "raceway",
  "race trac",
  "racetrac",
  "shell",
  "bp",
  "chevron",
  "marathon",
  "exxon",
  "valero",
  "circle k",
  "7-eleven",
  "7 eleven",

  // General shopping / big box
  "walmart",
  "target",
  "costco",
  "safeway",
  "kroger",
  "heb",
  "meijer",
  "whole foods",
  "aldi",
  "publix",
  "tom thumb",
  "winco",
  "food lion",

  // Rideshare / delivery
  "uber ",
  " uber",
  "lyft",
  "doordash",
  "door dash",
  "grubhub",
  "instacart",
  "postmates",
  "uber eats",

  // P2P / wallets
  "venmo",
  "cash app",
  "cashapp",
  "paypal",
  "zelle",
];

// Brands that should basically never be treated as "bills" by heuristics
// (we still allow them if Plaid recurring explicitly classifies them as bills
// or the user overrides them).
const NEVER_BILL_BRANDS = [
  "uber",
  "lyft",
  "steam",
  "playstation",
  "xbox",
  "crypto.com",
  "crypto com",
];

// PFC categories to exclude unless on whitelist
const EXCLUDE_PFC = [
  "restaurant",
  "restaurants",
  "dining",
  "fast food",
  "food and drink",
  "gas",
  "fuel",
  "grocery",
  "general merchandise",
  "shopping",
];

// Consider a subscription/bill "stale" if last charge older than this
const RECENT_DAYS_CUTOFF = 90;

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

function dateSpanDays(dates) {
  if (!dates.length) return 0;
  const sorted = [...dates].sort((a, b) => new Date(a) - new Date(b));
  return daysBetween(sorted[0], sorted[sorted.length - 1]);
}

function nextMonthlyFrom(lastISO) {
  return addDays(lastISO, 30);
}

function pickWebsiteFromNormalized(t) {
  if (t.website) return t.website;
  const cp = Array.isArray(t.counterparties) ? t.counterparties[0] : null;
  return cp?.website || null;
}

function buildItem({
  id,
  name,
  amount,
  date,
  cycle,
  website,
  counterparties,
  logo_url,
}) {
  const norm = normalizeMerchant(name);
  return {
    id,
    name,
    normalizedName: norm,
    amount: Math.abs(Number(amount || 0)),
    cycle, // 'monthly' | 'annual'
    nextCharge:
      cycle === "monthly" ? nextMonthlyFrom(date) : addDays(date, 365),
    website: website || null,
    counterparties: counterparties || undefined,
    logo_url: logo_url || undefined,
    alerts: false,
  };
}

function cleanDisplayName(raw = "") {
  let name = String(raw);

  name = name.replace(/^pos debit\s*-\s*/i, "");
  name = name.replace(/^ach transaction\s*/i, "");
  name = name.replace(/^transfer to\s*/i, "");
  name = name.replace(/^payment to\s*/i, "");
  name = name.replace(/^online payment\s*/i, "");

  // collapse whitespace
  return name.replace(/\s+/g, " ").trim();
}

function normalizeMerchant(name = "") {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Helper: for dedupe / grouping
function normalizedDisplayKey(name = "", normalizedName) {
  let base = normalizedName || normalizeMerchant(name);
  // Strip very generic suffixes that often cause dupe-like names
  if (base.endsWith(" com")) base = base.slice(0, -4).trim();
  if (base.endsWith(" inc")) base = base.slice(0, -4).trim();
  if (base.endsWith(" llc")) base = base.slice(0, -4).trim();
  return base || (name || "").toLowerCase().trim();
}

function groupByMerchantNormalized(txns) {
  const map = new Map();
  for (const t of txns) {
    const merch = (t.merchant || "Unknown").trim();
    const key = merch.toLowerCase();
    if (!map.has(key)) map.set(key, { name: merch, key, rows: [] });
    map.get(key).rows.push(t);
  }
  return map;
}

function merchantMatches(key, list) {
  return list.some((brand) => key.includes(brand));
}

function topCategoryPrimary(rows) {
  const counts = new Map();
  for (const r of rows) {
    const c = normalizePFCString(r.pfcPrimary || r.categoryId || "");
    if (!c) continue;
    counts.set(c, (counts.get(c) || 0) + 1);
  }
  let top = null;
  let max = 0;
  for (const [k, v] of counts) {
    if (v > max) {
      max = v;
      top = k;
    }
  }
  return top;
}

// Stronger: is this merchant mostly in excluded PFC categories?
function isMostlyExcludedCategory(rows) {
  let total = 0;
  let excluded = 0;
  for (const r of rows) {
    const c = normalizePFCString(r.pfcPrimary || r.categoryId || "");
    if (!c) continue;
    total += 1;
    if (EXCLUDE_PFC.some((p) => c.includes(p))) {
      excluded += 1;
    }
  }
  return total > 0 && excluded / total >= 0.6;
}

function coefVar(nums) {
  if (!nums.length) return Infinity;
  const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
  if (mean === 0) return Infinity;
  const variance =
    nums.reduce((s, x) => s + Math.pow(x - mean, 2), 0) / nums.length;
  const std = Math.sqrt(variance);
  return std / Math.abs(mean);
}

// Bill-ish category check for normalized PFC
function isBillishPFC(pfc) {
  const p = normalizePFCString(pfc);
  if (!p) return false;
  return (
    p.includes("utility") ||
    p.includes("utilities") ||
    p.includes("energy") ||
    p.includes("electric") ||
    p.includes("gas") ||
    p.includes("water") ||
    p.includes("telecommunication") ||
    p.includes("internet") ||
    p.includes("wireless") ||
    p.includes("phone") ||
    p.includes("cellular") ||
    p.includes("insurance") ||
    p.includes("mortgage") ||
    p.includes("rent") ||
    p.includes("loan") ||
    p.includes("student loan") ||
    p.includes("service") ||
    p.includes("services") ||
    p.includes("tax") ||
    p.includes("tuition") ||
    p.includes("education")
  );
}

// Generic dedupe helper: one item per normalized merchant, preferring streams/“richer” entries
function dedupeByMerchantName(items) {
  const byKey = new Map();
  for (const item of items) {
    const key = normalizedDisplayKey(item.name, item.normalizedName);
    const existing = byKey.get(key);

    if (!existing) {
      byKey.set(key, item);
      continue;
    }

    const existingFromFallback =
      typeof existing.id === "string" &&
      (existing.id.startsWith("sub:") || existing.id.startsWith("bill:"));
    const currentFromFallback =
      typeof item.id === "string" &&
      (item.id.startsWith("sub:") || item.id.startsWith("bill:"));

    const existingHasLogo = !!existing.logo_url;
    const currentHasLogo = !!item.logo_url;

    const existingDate = existing.nextCharge || existing.dueDate || null;
    const currentDate = item.nextCharge || item.dueDate || null;

    let replace = false;

    // Prefer streams (non "sub:" / "bill:" ids) over fallback
    if (existingFromFallback && !currentFromFallback) {
      replace = true;
    } else if (!existingFromFallback && currentFromFallback) {
      replace = false;
    } else {
      // Prefer one with logo
      if (!existingHasLogo && currentHasLogo) {
        replace = true;
      } else if (existingHasLogo && !currentHasLogo) {
        replace = false;
      } else if (existingDate && currentDate) {
        // Prefer more recent
        if (new Date(currentDate) > new Date(existingDate)) {
          replace = true;
        }
      }
    }

    if (replace) {
      byKey.set(key, item);
    }
  }
  return Array.from(byKey.values());
}

function deriveSubscriptionsFromTxns(txns, userId = null) {
  const expenses = txns
    .filter((t) => t.type === "expense")
    .map((t) => ({ ...t, amount: Math.abs(t.amount) }));

  const byMerchant = groupByMerchantNormalized(expenses);
  const out = [];
  const now = new Date();

  for (const [, group] of byMerchant.entries()) {
    const { key, name, rows } = group;
    const amounts = rows.map((r) => r.amount).sort((a, b) => a - b);
    const median = amounts[Math.floor(amounts.length / 2)] || 0;
    const dates = rows.map((r) => r.date);
    const gapsMonthly = monthlyGaps(dates);
    const span = dateSpanDays(dates);
    const nameLower = name.toLowerCase();

    // User override (per merchant / per user)
    const override = userId ? getRecurringOverride(userId, name) : null;
    if (override === "never" || override === "bill") {
      continue;
    }
    const overrideIsSub = override === "subscription";

    // Last charge recency filter (drop old stuff)
    const lastDate =
      dates.length > 0
        ? dates.reduce(
            (latest, d) =>
              new Date(d) > new Date(latest) ? d : latest,
            dates[0]
          )
        : null;

    
    const freqHint =
      gapsMonthly >= 1 && span >= 60 ? "monthly" : "generic";

    if (lastDate && !recentEnough(lastDate, freqHint)) continue;

    const topPFC = topCategoryPrimary(rows) || "";
    const isKnownSub = overrideIsSub || merchantMatches(nameLower, SUB_BRANDS);
    const isKnownBill = merchantMatches(nameLower, BILL_BRANDS);
    const excludedByName = merchantMatches(nameLower, EXCLUDE_HINTS);
    const excludedByPFC = EXCLUDE_PFC.some((c) => topPFC.includes(c));
    const mostlyExcluded = isMostlyExcludedCategory(rows);

    // Exclude food/gas/shopping/venmo/uber etc unless explicitly whitelisted as a subscription
    if (
      !overrideIsSub &&
      (excludedByName || excludedByPFC || mostlyExcluded) &&
      !isKnownSub
    )
      continue;

    const occ = rows.length;
    const cv = coefVar(amounts);

    // Known subs: still a bit lenient but favor fixed-ish prices
    const passesKnown = isKnownSub && occ >= 1;

    const passesUnknown =
      !isKnownSub && !isKnownBill && occ >= 3 && span >= 60 && gapsMonthly >= 1;

    // Subscriptions should be “mostly fixed”
    const stable = isKnownSub ? cv <= 0.4 : cv <= 0.2;

    if ((passesKnown || passesUnknown) && stable) {
      const latest = rows.sort(
        (a, b) => new Date(b.date) - new Date(a.date)
      )[0];
      out.push(
        buildItem({
          id: `sub:${key}:${Math.round(median * 100)}`,
          name: cleanDisplayName(name),
          amount: median,
          date: latest.date,
          cycle: "monthly",
          website: pickWebsiteFromNormalized(latest),
          counterparties: latest.counterparties,
          logo_url: latest.logo_url,
        })
      );
    }
  }

  const uniq = new Map();
  for (const s of out) if (!uniq.has(s.id)) uniq.set(s.id, s);
  return Array.from(uniq.values()).slice(0, 50);
}

function deriveBillsFromTxns(txns, subscriptionMerchantNames = new Set(), userId = null) {
  const expenses = txns
    .filter((t) => t.type === "expense")
    .map((t) => ({ ...t, amount: Math.abs(t.amount) }));

  const byMerchant = groupByMerchantNormalized(expenses);
  const out = [];
  const now = new Date();

  for (const [, group] of byMerchant.entries()) {
    const { name, key, rows } = group;
    const nameLower = name.toLowerCase();

    // Some brands should basically never be bills unless explicitly overridden
    const neverBillBrand = merchantMatches(nameLower, NEVER_BILL_BRANDS);

    // Don't show something as a bill if we've already decided it's a subscription
    if (subscriptionMerchantNames.has(nameLower)) continue;

    // User override (per merchant / per user)
    const override = userId ? getRecurringOverride(userId, name) : null;
    if (override === "never" || override === "subscription") {
      continue;
    }
    const overrideIsBill = override === "bill";

    const dates = rows.map((r) => r.date);
    const span = dateSpanDays(dates);
    const gapsMonthly = monthlyGaps(dates);
    const amounts = rows.map((r) => r.amount).sort((a, b) => a - b);
    const median = amounts[Math.floor(amounts.length / 2)] || 0;

    // Last charge recency filter (drop old bills)
    const lastDate =
      dates.length > 0
        ? dates.reduce(
            (latest, d) =>
              new Date(d) > new Date(latest) ? d : latest,
            dates[0]
          )
        : null;
  
    const freqHint =
      gapsMonthly >= 1 && span >= 60 ? "monthly" : "generic";
  
    if (lastDate && !recentEnough(lastDate, freqHint)) continue;

    const topPFC = topCategoryPrimary(rows) || "";
    const isKnownBill = overrideIsBill || merchantMatches(nameLower, BILL_BRANDS);
    const isKnownSub = merchantMatches(nameLower, SUB_BRANDS);
    const billishByCategory = isBillishPFC(topPFC);

    if (
      neverBillBrand &&
      !overrideIsBill &&
      !isKnownBill &&
      !billishByCategory
    ) {
      continue;
    }

    const excludedByName = merchantMatches(nameLower, EXCLUDE_HINTS);
    const excludedByPFC = EXCLUDE_PFC.some((c) => topPFC.includes(c));
    const mostlyExcluded = isMostlyExcludedCategory(rows);

    // Exclude food/gas/shopping/venmo/uber, etc., unless explicitly whitelisted as a bill
    if (
      !overrideIsBill &&
      (excludedByName || excludedByPFC || mostlyExcluded) &&
      !isKnownBill
    )
      continue;

    const occ = rows.length;
    const cv = coefVar(amounts);

    let passes = false;
    let cvLimit = 1.0;

    if (isKnownBill) {
      // Trusted brands: just need at least one recent occurrence
      passes = occ >= 1 && span >= 0;
    } else if (billishByCategory && !isKnownSub) {
      // Utilities / loans / insurance: a bit lenient
      passes = occ >= 2 && span >= 25;
      cvLimit = 0.8;
    } else if (!isKnownSub) {
      // Completely unknown "bills" must be VERY consistent
      passes = occ >= 4 && span >= 90 && gapsMonthly >= 2;
      cvLimit = 0.5;
    }

    // Bills can fluctuate more than subs, but shouldn't be random
    const stable = cv <= cvLimit;

    if (passes && stable) {
      const latest = rows.sort(
        (a, b) => new Date(b.date) - new Date(a.date)
      )[0];
      out.push(
        buildItem({
          id: `bill:${key}:${Math.round(median * 100)}`,
          name: cleanDisplayName(name),
          amount: median,
          date: latest.date,
          cycle: "monthly",
          website: pickWebsiteFromNormalized(latest),
          counterparties: latest.counterparties,
          logo_url: latest.logo_url,
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

/**
 * classifyStream
 *  - Reuses the same brand whitelists / exclude lists / PFC logic as the
 *    heuristic engine, so streams behave more like budget_snapshot.
 *  - Returns "subscription", "bill", or null to drop.
 */
function classifyStream(s, userId = null) {
  const rawName = s.merchant_name || s.description || "";
  const name = rawName.toLowerCase();
  const pfcPrimary = s.personal_finance_category?.primary?.toLowerCase?.() || "";
  const categories = (Array.isArray(s.category) ? s.category : []).map((c) =>
    String(c).toLowerCase()
  );
  const freq = String(s.frequency || "").toUpperCase();

  // User override first
  const override = userId ? getRecurringOverride(userId, rawName) : null;
  if (override === "never") return null;
  if (override === "subscription" || override === "bill") return override;

  const monthlyish = [
    "WEEKLY",
    "BIWEEKLY",
    "SEMI_MONTHLY",
    "MONTHLY",
    "QUARTERLY",
    "ANNUALLY",
    "YEARLY",
  ].includes(freq);

  const isKnownSub = merchantMatches(name, SUB_BRANDS);
  const isKnownBill = merchantMatches(name, BILL_BRANDS);

  const excludedByName = merchantMatches(name, EXCLUDE_HINTS);
  const excludedByPFC = EXCLUDE_PFC.some(
    (c) =>
      pfcPrimary.includes(c) ||
      categories.some((cat) => cat.includes(c))
  );

  if ((excludedByName || excludedByPFC) && !isKnownSub && !isKnownBill) {
    return null;
  }

  const billishByCategory =
    isBillishPFC(pfcPrimary) ||
    categories.some((cat) => isBillishPFC(cat));

  const pfcLooksSubscription =
    pfcPrimary.includes("subscription") ||
    pfcPrimary.includes("entertainment") ||
    categories.some(
      (c) => c.includes("subscription") || c.includes("entertainment")
    );

  if (isKnownBill && !isKnownSub) return "bill";
  if (isKnownSub && !isKnownBill) return "subscription";

  if (!monthlyish && !isKnownSub && !isKnownBill) {
    return null;
  }

  const looksBill =
    billishByCategory ||
    isKnownBill ||
    categories.some(
      (c) =>
        c.includes("utilities") ||
        c.includes("telecommunication") ||
        c.includes("insurance") ||
        c.includes("mortgage") ||
        c.includes("rent") ||
        c.includes("loan")
    );

  const looksSubscription = pfcLooksSubscription || isKnownSub;

  if (looksBill && !looksSubscription) return "bill";
  if (looksSubscription && !looksBill) return "subscription";

  return null;
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
 * Result caches for subscriptions/bills endpoints
 * ==========================================================================*/

const RECURRING_RESULT_TTL = 2 * 60 * 1000; // 2 minutes
const SUBS_RESULT_CACHE = new Map(); // userId -> { ts, data }
const BILLS_RESULT_CACHE = new Map(); // userId -> { ts, data }

function getCachedRecurringResult(cache, userId) {
  const hit = cache.get(userId);
  if (!hit) return null;
  if (Date.now() - hit.ts > RECURRING_RESULT_TTL) {
    cache.delete(userId);
    return null;
  }
  return hit.data;
}

function setCachedRecurringResult(cache, userId, data) {
  cache.set(userId, { ts: Date.now(), data });
}

/* ============================================================================
 * Plaid routes
 * ==========================================================================*/

// Create Link Token — iOS-only
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
      // Request up to 365 days of transaction history for new Items
      transactions: {
        days_requested: 365,
      },
      ...(LINK_CUSTOMIZATION
        ? { link_customization_name: LINK_CUSTOMIZATION }
        : {}),
    };

    // strip empties
    for (const k of Object.keys(payload)) {
      const v = payload[k];
      if (v === "" || v == null || (Array.isArray(v) && v.length === 0)) {
        delete payload[k];
      }
    }

    console.log("linkTokenCreate keys:", Object.keys(payload).sort());

    const resp = await plaid.linkTokenCreate(payload);
    return res.json({ link_token: resp.data.link_token, platform: "ios" });
  } catch (e) {
    const code = e?.response?.data?.error_code;

    if (code === "INVALID_FIELD") {
      // Retry minimal
      try {
        const client_user_id = String(req.body?.userId || "demo-user");
        const fallback = await plaid.linkTokenCreate({
          user: { client_user_id },
          client_name: "Flowly",
          products: PRODUCTS,
          country_codes: ["US"],
          language: "en",
          redirect_uri: PLAID_REDIRECT_URI,
          transactions: {
            days_requested: 365,
          },
          ...(LINK_CUSTOMIZATION
            ? { link_customization_name: LINK_CUSTOMIZATION }
            : {}),
        });
        return res.json({
          link_token: fallback.data.link_token,
          fallback: true,
          platform: "ios",
        });
      } catch (e2) {
        return sendPlaidError(res, e2);
      }
    }

    if (code === "PRODUCTS_NOT_ENABLED") {
      try {
        const client_user_id = String(req.body?.userId || "demo-user");
        const retry = await plaid.linkTokenCreate({
          user: { client_user_id },
          client_name: "Flowly",
          products: ["transactions"],
          country_codes: ["US"],
          language: "en",
          redirect_uri: PLAID_REDIRECT_URI,
          transactions: {
            days_requested: 365,
          },
          ...(LINK_CUSTOMIZATION
            ? { link_customization_name: LINK_CUSTOMIZATION }
            : {}),
        });
        return res.json({
          link_token: retry.data.link_token,
          downgraded_to: "transactions",
          platform: "ios",
        });
      } catch (e3) {
        return sendPlaidError(res, e3);
      }
    }

    return sendPlaidError(res, e);
  }
});

// Exchange public_token -> access_token
app.post("/api/exchange_public_token", async (req, res) => {
  try {
    const userId = String(req.body?.userId || "demo-user");
    const { public_token } = req.body || {};
    if (!public_token)
      return res.status(400).json({ error: "missing_public_token" });

    const r = await plaid.itemPublicTokenExchange({ public_token });
    const { access_token, item_id } = r.data;

    await upsertUserItem({ userId, access_token, item_id });
    res.json({ ok: true, item_id });
  } catch (e) {
    return sendPlaidError(res, e);
  }
});

// Transactions
app.get("/api/transactions", async (req, res) => {
  try {
    const userId = String(req.query.userId || "demo-user");
    const user = await getUserById(userId);
    if (!user?.access_token)
      return res.status(400).json({ error: "no_linked_item" });

    const txns = await getAllTransactionsOnce({
      userId,
      access_token: user.access_token,
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
    if (!user?.access_token)
      return res.status(400).json({ error: "no_linked_item" });

    const resp = await plaid.accountsBalanceGet({
      access_token: user.access_token,
    });

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
    if (
      webhook_type === "TRANSACTIONS" &&
      webhook_code === "SYNC_UPDATES_AVAILABLE"
    ) {
      const userId = await getUserIdByItemId(item_id);
      console.log(
        "SYNC_UPDATES_AVAILABLE for item",
        item_id,
        "user",
        userId
      );
      if (userId) {
        STREAMS_CACHE.delete(userId);
        SUBS_RESULT_CACHE.delete(userId);
        BILLS_RESULT_CACHE.delete(userId);
        TXN_CACHE.delete(userId);
      }
    }
    if (
      webhook_type === "TRANSACTIONS" &&
      webhook_code === "RECURRING_TRANSACTIONS_UPDATE"
    ) {
      const userId = await getUserIdByItemId(item_id);
      if (userId) {
        STREAMS_CACHE.delete(userId);
        SUBS_RESULT_CACHE.delete(userId);
        BILLS_RESULT_CACHE.delete(userId);
        TXN_CACHE.delete(userId);
      }
    }
    res.json({ ok: true });
  } catch (e) {
    console.error("webhook error", e);
    res.status(200).json({ ok: true });
  }
});

/* ===== One-shot snapshot (txns + derived subs + derived bills, with streams) ===== */
app.get("/api/budget_snapshot", async (req, res) => {
  try {
    const userId = String(req.query.userId || "demo-user");
    const user = await getUserById(userId);
    if (!user?.access_token)
      return res.status(400).json({ error: "no_linked_item" });

    // 1) Always: 12 months of normalized transactions
    const txns = await getAllTransactionsOnce({
      userId,
      access_token: user.access_token,
    });

    const lower = (s) => (s || "").toLowerCase().trim();

    // 2) Try recurring streams once (subscriptions + bills)
    let streamSubs = [];
    let streamBills = [];
    try {
      const streams = await getRecurringStreamsOnce({
        userId,
        access_token: user.access_token,
      });
      if (Array.isArray(streams) && streams.length > 0) {
        const now = new Date();

        for (const s of streams) {
          const kind = classifyStream(s, userId);
          if (!kind) continue;

          const lastDate = s.last_date || s.first_date || null;
          const { days, cycle } = freqToInfo(s.frequency);
          const freqHint = cycle === "annual" ? "annual" : "monthly";
  
          if (lastDate && !recentEnough(lastDate, freqHint)) {
            continue;
          }
          const next =
            s.next_date ||
            (s.last_date
              ? addDays(s.last_date, days)
              : s.first_date
              ? addDays(s.first_date, days)
              : toISO(new Date()));

          if (kind === "subscription") {
            streamSubs.push({
              id: s.stream_id,
              name: cleanDisplayName(
                s.merchant_name || s.description || "Subscription"
              ),
              normalizedName: normalizeMerchant(
                s.merchant_name || s.description || "Subscription"
              ),
              amount: toDollars(s.last_amount ?? s.average_amount ?? 0),
              cycle: cycle === "annual" ? "annual" : "monthly",
              nextCharge: next,
              isPaused: s.is_active === false,
              alerts: false,
              website: s.website || null,
              logo_url: s.logo_url || undefined,
              counterparties: s.counterparties || undefined,
            });
          } else if (kind === "bill") {
            streamBills.push({
              id: s.stream_id,
              name: cleanDisplayName(
                s.merchant_name || s.description || "Bill"
              ),
              normalizedName: normalizeMerchant(
                s.merchant_name || s.description || "Bill"
              ),
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
        }
      }
    } catch {
      streamSubs = [];
      streamBills = [];
    }

    // 3) Heuristic fallback from 12 months of txns
    const heuristicSubsRaw = deriveSubscriptionsFromTxns(txns, userId);

    const subscriptionMerchantNames = new Set();
    for (const s of streamSubs) subscriptionMerchantNames.add(lower(s.name));
    for (const s of heuristicSubsRaw) subscriptionMerchantNames.add(lower(s.name));

    const heuristicBillsRaw = deriveBillsFromTxns(
      txns,
      subscriptionMerchantNames,
      userId
    );

    // 4) Merge streams + heuristics (dedupe by merchant-ish name, streams win)
    const streamSubNames = new Set(streamSubs.map((s) => lower(s.name)));
    const mergedSubsPreDedupe = [
      ...streamSubs,
      ...heuristicSubsRaw
        .filter((s) => !streamSubNames.has(lower(s.name)))
        .map((s) => ({
          id: s.id,
          name: s.name,
          normalizedName: s.normalizedName || normalizeMerchant(s.name),
          amount: s.amount,
          cycle: s.cycle,
          nextCharge: s.nextCharge,
          isPaused: false,
          alerts: false,
          website: s.website || null,
          counterparties: s.counterparties || undefined,
        })),
    ];
    const mergedSubs = dedupeByMerchantName(mergedSubsPreDedupe);

    const streamBillNames = new Set(streamBills.map((b) => lower(b.name)));
    const mergedBillsPreDedupe = [
      ...streamBills,
      ...heuristicBillsRaw
        .filter((b) => !streamBillNames.has(lower(b.name)))
        .map((b) => ({
          id: b.id,
          name: b.name,
          normalizedName: b.normalizedName || normalizeMerchant(b.name),
          amount: b.amount,
          dueDate: b.nextCharge,
          autopay: false,
          variable: false,
          alerts: false,
          website: b.website || null,
          counterparties: b.counterparties || undefined,
        })),
    ];
    const mergedBills = dedupeByMerchantName(mergedBillsPreDedupe);

    res.json({
      txns,
      subscriptions: mergedSubs,
      bills: mergedBills,
    });
  } catch (e) {
    return sendPlaidError(res, e);
  }
});

/* ===== Recurring override API (from UI actions) ===== */
app.post("/api/recurring/override", async (req, res) => {
  try {
    const { userId: rawUserId, type } = req.body || {};
    const userId = String(rawUserId || "demo-user");
    const merchantName = extractMerchantName(req.body);

    if (!merchantName || !type) {
      return res
        .status(400)
        .json({ error: "missing_fields", hint: "Need merchantName and type" });
    }

    const t = String(type || "").toLowerCase();
    if (!RECURRING_OVERRIDE_TYPES.has(t)) {
      return res.status(400).json({ error: "invalid_type" });
    }

    setRecurringOverride({ userId, merchantName, type: t });

    // Bust caches so the next fetch reflects the override immediately
    STREAMS_CACHE.delete(userId);
    SUBS_RESULT_CACHE.delete(userId);
    BILLS_RESULT_CACHE.delete(userId);
    TXN_CACHE.delete(userId);

    return res.json({ ok: true });
  } catch (e) {
    return sendError(res, e);
  }
});

/* --- Backwards-compat endpoints for older client code --- */
app.post("/api/override/move_to_bills", (req, res) => {
  const userId = String(req.body?.userId || "demo-user");
  const merchantName = extractMerchantName(req.body);
  if (!merchantName) {
    return res
      .status(400)
      .json({
        error: "missing_merchantName",
        hint: "Send merchantName/name/merchant/normalizedName",
      });
  }
  setRecurringOverride({ userId, merchantName, type: "bill" });
  STREAMS_CACHE.delete(userId);
  SUBS_RESULT_CACHE.delete(userId);
  BILLS_RESULT_CACHE.delete(userId);
  TXN_CACHE.delete(userId);
  return res.json({ ok: true });
});

app.post("/api/override/move_to_subscriptions", (req, res) => {
  const userId = String(req.body?.userId || "demo-user");
  const merchantName = extractMerchantName(req.body);
  if (!merchantName) {
    return res
      .status(400)
      .json({
        error: "missing_merchantName",
        hint: "Send merchantName/name/merchant/normalizedName",
      });
  }
  setRecurringOverride({ userId, merchantName, type: "subscription" });
  STREAMS_CACHE.delete(userId);
  SUBS_RESULT_CACHE.delete(userId);
  BILLS_RESULT_CACHE.delete(userId);
  TXN_CACHE.delete(userId);
  return res.json({ ok: true });
});

app.post("/api/override/remove_from_subscriptions", (req, res) => {
  const userId = String(req.body?.userId || "demo-user");
  const merchantName = extractMerchantName(req.body);
  if (!merchantName) {
    return res
      .status(400)
      .json({
        error: "missing_merchantName",
        hint: "Send merchantName/name/merchant/normalizedName",
      });
  }
  setRecurringOverride({ userId, merchantName, type: "never" });
  STREAMS_CACHE.delete(userId);
  SUBS_RESULT_CACHE.delete(userId);
  BILLS_RESULT_CACHE.delete(userId);
  TXN_CACHE.delete(userId);
  return res.json({ ok: true });
});

/* ===== Subscriptions & Bills via Plaid Recurring Streams (with fallback + caching) ===== */
app.get("/api/subscriptions", async (req, res) => {
  try {
    const userId = String(req.query.userId || "demo-user");

    // Quick in-memory cache so tab switching feels instant
    const cached = getCachedRecurringResult(SUBS_RESULT_CACHE, userId);
    if (cached) return res.json({ subscriptions: cached });

    const user = await getUserById(userId);
    if (!user?.access_token)
      return res.status(400).json({ error: "no_linked_item" });

    let streams = [];
    try {
      streams = await getRecurringStreamsOnce({
        userId,
        access_token: user.access_token,
      });
    } catch {
      streams = [];
    }

    if (streams.length > 0) {
      const subs = [];
      const now = new Date();

      for (const s of streams) {
        const kind = classifyStream(s, userId);
        if (kind !== "subscription") continue;

        const lastDate = s.last_date || s.first_date || null;
        const { days, cycle } = freqToInfo(s.frequency);
        const freqHint = cycle === "annual" ? "annual" : "monthly";

        if (lastDate && !recentEnough(lastDate, freqHint)) {
          continue;
        }
        const next =
          s.next_date ||
          (s.last_date
            ? addDays(s.last_date, days)
            : s.first_date
            ? addDays(s.first_date, days)
            : toISO(new Date()));

        subs.push({
          id: s.stream_id,
          name: cleanDisplayName(
            s.merchant_name || s.description || "Subscription"
          ),
          normalizedName: normalizeMerchant(
            s.merchant_name || s.description || "Subscription"
          ),
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

      const deduped = dedupeByMerchantName(subs);
      setCachedRecurringResult(SUBS_RESULT_CACHE, userId, deduped);
      return res.json({ subscriptions: deduped });
    }

    // Fallback
    const txns = await getAllTransactionsOnce({
      userId,
      access_token: user.access_token,
    });
    const subsRaw = deriveSubscriptionsFromTxns(txns, userId);
    const subs = dedupeByMerchantName(
      subsRaw.map((s) => ({
        id: s.id,
        name: s.name,
        normalizedName: s.normalizedName || normalizeMerchant(s.name),
        amount: s.amount,
        cycle: s.cycle,
        nextCharge: s.nextCharge,
        isPaused: false,
        alerts: false,
        website: s.website || null,
        counterparties: s.counterparties || undefined,
      }))
    );
    setCachedRecurringResult(SUBS_RESULT_CACHE, userId, subs);
    return res.json({ subscriptions: subs });
  } catch (e) {
    return sendPlaidError(res, e);
  }
});

app.get("/api/bills", async (req, res) => {
  try {
    const userId = String(req.query.userId || "demo-user");

    const cached = getCachedRecurringResult(BILLS_RESULT_CACHE, userId);
    if (cached) return res.json({ bills: cached });

    const user = await getUserById(userId);
    if (!user?.access_token)
      return res.status(400).json({ error: "no_linked_item" });

    let streams = [];
    try {
      streams = await getRecurringStreamsOnce({
        userId,
        access_token: user.access_token,
      });
    } catch {
      streams = [];
    }

    if (streams.length > 0) {
      const bills = [];
      const now = new Date();

      for (const s of streams) {
        const kind = classifyStream(s, userId);
        if (kind !== "bill") continue;

        const lastDate = s.last_date || s.first_date || null;
        const { days, cycle } = freqToInfo(s.frequency);
        const freqHint = cycle === "annual" ? "annual" : "monthly";

        if (lastDate && !recentEnough(lastDate, freqHint)) {
          continue;
        }
        const next =
          s.next_date ||
          (s.last_date
            ? addDays(s.last_date, days)
            : s.first_date
            ? addDays(s.first_date, days)
            : toISO(new Date()));

        bills.push({
          id: s.stream_id,
          name: cleanDisplayName(
            s.merchant_name || s.description || "Bill"
          ),
          normalizedName: normalizeMerchant(
            s.merchant_name || s.description || "Bill"
          ),
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

      const deduped = dedupeByMerchantName(bills);
      setCachedRecurringResult(BILLS_RESULT_CACHE, userId, deduped);
      return res.json({ bills: deduped });
    }

    // Fallback — use subs to avoid duplicates
    const txns = await getAllTransactionsOnce({
      userId,
      access_token: user.access_token,
    });
    const subsFallback = deriveSubscriptionsFromTxns(txns, userId);
    const subMerchantNames = new Set(
      subsFallback.map((s) => (s.name || "").toLowerCase().trim())
    );
    const billsRaw = deriveBillsFromTxns(txns, subMerchantNames, userId);
    const bills = dedupeByMerchantName(
      billsRaw.map((b) => ({
        id: b.id,
        name: b.name,
        normalizedName: b.normalizedName || normalizeMerchant(b.name),
        amount: b.amount,
        dueDate: b.nextCharge,
        autopay: false,
        variable: false,
        alerts: false,
        website: b.website || null,
        counterparties: b.counterparties || undefined,
      }))
    );

    setCachedRecurringResult(BILLS_RESULT_CACHE, userId, bills);
    return res.json({ bills });
  } catch (e) {
    return sendPlaidError(res, e);
  }
});

/* ===== Debug endpoint (streams + fallback comparison) ===== */
app.get("/api/debug/recurring", async (req, res) => {
  try {
    const userId = String(req.query.userId || "demo-user");
    const user = await getUserById(userId);
    if (!user?.access_token)
      return res.status(400).json({ error: "no_linked_item" });

    const [streams, txns] = await Promise.all([
      getRecurringStreamsOnce({ userId, access_token: user.access_token }),
      getAllTransactionsOnce({ userId, access_token: user.access_token }),
    ]);

    const subsFallback = deriveSubscriptionsFromTxns(txns, userId);
    const subMerchantNames = new Set(
      subsFallback.map((s) => (s.name || "").toLowerCase().trim())
    );
    const billsFallback = deriveBillsFromTxns(txns, subMerchantNames, userId);

    const subsStreams = [];
    const billsStreams = [];
    const now = new Date();

    for (const s of streams) {
      const kind = classifyStream(s, userId);
      const lastDate = s.last_date || s.first_date || null;
      const recentEnough =
        !lastDate || daysBetween(lastDate, now) <= RECENT_DAYS_CUTOFF;

      const { days, cycle } = freqToInfo(s.frequency);
      const next =
        s.next_date ||
        (s.last_date
          ? addDays(s.last_date, days)
          : s.first_date
          ? addDays(s.first_date, days)
          : toISO(new Date()));
      const base = {
        id: s.stream_id,
        name: s.merchant_name || s.description || "Recurring",
        amount: toDollars(s.last_amount ?? s.average_amount ?? 0),
        cycle: cycle === "annual" ? "annual" : "monthly",
        next,
        recentEnough,
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
      meta: {
        txns: txns.length,
      },
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
   
