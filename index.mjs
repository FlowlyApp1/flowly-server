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

// 60s in-memory cache
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
  // Fast food / chains (some already existed)
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

function buildItem({ id, name, amount, date, cycle, website, counterparties }) {
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
    alerts: false,
  };
}

function normalizeMerchant(name = "") {
  return String(name)
    .toLowerCase()
    // strip non-alphanumeric
    .replace(/[^a-z0-9]/g, " ")
    // collapse spaces
    .replace(/\s+/g, " ")
    .trim();
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
    const c = (r.pfcPrimary || r.categoryId || "").toLowerCase();
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
  const p = (pfc || "").toLowerCase();
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
    if (lastDate && daysBetween(lastDate, now) > RECENT_DAYS_CUTOFF) continue;

    const topPFC = topCategoryPrimary(rows) || "";
    const isKnownSub = overrideIsSub || merchantMatches(nameLower, SUB_BRANDS);
    const isKnownBill = merchantMatches(nameLower, BILL_BRANDS);
    const excludedByName = merchantMatches(nameLower, EXCLUDE_HINTS);
    const excludedByPFC = EXCLUDE_PFC.some((c) => topPFC.includes(c));

    // Exclude food/gas/shopping/venmo/uber etc unless explicitly whitelisted as a subscription
    if (!overrideIsSub && (excludedByName || excludedByPFC) && !isKnownSub) continue;

    const occ = rows.length;
    const cv = coefVar(amounts);

    // Known subs: be more lenient, just require at least 1 recent charge
    const passesKnown = isKnownSub && occ >= 1;

    const gapsMonthly = monthlyGaps(dates);
    const passesUnknown =
      !isKnownSub && !isKnownBill && occ >= 3 && span >= 60 && gapsMonthly >= 1;

    const stable = isKnownSub ? cv <= 0.6 : cv <= 0.3;

    if ((passesKnown || passesUnknown) && stable) {
      const latest = rows.sort(
        (a, b) => new Date(b.date) - new Date(a.date)
      )[0];
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
    if (lastDate && daysBetween(lastDate, now) > RECENT_DAYS_CUTOFF) continue;

    const topPFC = topCategoryPrimary(rows) || "";
    const isKnownBill = overrideIsBill || merchantMatches(nameLower, BILL_BRANDS);
    const isKnownSub = merchantMatches(nameLower, SUB_BRANDS);
    const billishByCategory = isBillishPFC(topPFC);

    const excludedByName = merchantMatches(nameLower, EXCLUDE_HINTS);
    const excludedByPFC = EXCLUDE_PFC.some((c) => topPFC.includes(c));

    // Exclude food/gas/shopping/venmo/uber, etc., unless explicitly whitelisted as a bill
    if (!overrideIsBill && (excludedByName || excludedByPFC) && !isKnownBill) continue;

    const occ = rows.length;
    const cv = coefVar(amounts);

    let passes = false;

    if (isKnownBill) {
      // Known bill brands (utilities, insurance, etc.) – allow even if new,
      // but still want at least 1 occurrence
      passes = occ >= 1 && span >= 0;
    } else if (billishByCategory && !isKnownSub) {
      // Category looks like a bill (utilities, loans, rent, etc.)
      // Can be new, but should appear at least twice (e.g. first two months)
      passes = occ >= 2 && span >= 25;
    } else if (!isKnownSub) {
      // Generic recurring stuff – very strict
      passes = occ >= 3 && span >= 60 && gapsMonthly >= 1;
    }

    // Bills can be a bit more variable
    const stable = cv <= 0.7;

    if (passes && stable) {
      const latest = rows.sort(
        (a, b) => new Date(b.date) - new Date(a.date)
      )[0];
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

  // If this looks like obvious food/gas/shopping/venmo/uber/etc AND is not on
  // a whitelist, drop it up front.
  if ((excludedByName || excludedByPFC) && !isKnownSub && !isKnownBill) {
    return null;
  }

  // Bill-ish by PFC or categories
  const billishByCategory =
    isBillishPFC(pfcPrimary) ||
    categories.some((cat) => isBillishPFC(cat));

  // Subscription-ish PFC/categories
  const pfcLooksSubscription =
    pfcPrimary.includes("subscription") ||
    pfcPrimary.includes("entertainment") ||
    categories.some(
      (c) => c.includes("subscription") || c.includes("entertainment")
    );

  // Strong signals
  if (isKnownBill && !isKnownSub) return "bill";
  if (isKnownSub && !isKnownBill) return "subscription";

  // If it's not at least roughly monthly, and not whitelisted, ignore.
  if (!monthlyish && !isKnownSub && !isKnownBill) {
    return null;
  }

  // Category-driven classification
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

  // If we couldn't confidently classify, drop it instead of guessing.
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
      // Retry without any optional extras (we already removed them, but keep a minimal retry)
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
      if (userId) STREAMS_CACHE.delete(userId); // bust streams cache on sync updates too
    }
    if (
      webhook_type === "TRANSACTIONS" &&
      webhook_code === "RECURRING_TRANSACTIONS_UPDATE"
    ) {
      const userId = await getUserIdByItemId(item_id);
      if (userId) STREAMS_CACHE.delete(userId);
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
          if (lastDate && daysBetween(lastDate, now) > RECENT_DAYS_CUTOFF) {
            continue;
          }

          const { days, cycle } = freqToInfo(s.frequency);
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
          } else if (kind === "bill") {
            streamBills.push({
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
        }
      }
    } catch {
      // If recurring product isn't enabled or fails, just fall back to heuristics below
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

    // 4) Merge streams + heuristics (dedupe by merchant name, streams win)
    const streamSubNames = new Set(streamSubs.map((s) => lower(s.name)));
    const mergedSubs = [
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

    const streamBillNames = new Set(streamBills.map((b) => lower(b.name)));
    const mergedBills = [
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
    const { userId: rawUserId, merchantName, type } = req.body || {};
    const userId = String(rawUserId || "demo-user");

    if (!merchantName || !type) {
      return res.status(400).json({ error: "missing_fields" });
    }

    const t = String(type || "").toLowerCase();
    if (!RECURRING_OVERRIDE_TYPES.has(t)) {
      return res.status(400).json({ error: "invalid_type" });
    }

    setRecurringOverride({ userId, merchantName, type: t });
    return res.json({ ok: true });
  } catch (e) {
    return sendError(res, e);
  }
});

/* ===== Legacy-style override endpoints used by Budget UI (Option A wiring) ===== */
app.post("/api/override/move_to_bills", async (req, res) => {
  try {
    const { userId: rawUserId, merchantName } = req.body || {};
    const userId = String(rawUserId || "demo-user");
    if (!merchantName) {
      return res.status(400).json({ error: "missing_merchantName" });
    }

    setRecurringOverride({ userId, merchantName, type: "bill" });
    return res.json({ ok: true });
  } catch (e) {
    return sendError(res, e);
  }
});

app.post("/api/override/move_to_subscriptions", async (req, res) => {
  try {
    const { userId: rawUserId, merchantName } = req.body || {};
    const userId = String(rawUserId || "demo-user");
    if (!merchantName) {
      return res.status(400).json({ error: "missing_merchantName" });
    }

    setRecurringOverride({ userId, merchantName, type: "subscription" });
    return res.json({ ok: true });
  } catch (e) {
    return sendError(res, e);
  }
});

app.post("/api/override/remove_from_bills", async (req, res) => {
  try {
    const { userId: rawUserId, merchantName } = req.body || {};
    const userId = String(rawUserId || "demo-user");
    if (!merchantName) {
      return res.status(400).json({ error: "missing_merchantName" });
    }

    setRecurringOverride({ userId, merchantName, type: "never" });
    return res.json({ ok: true });
  } catch (e) {
    return sendError(res, e);
  }
});

app.post("/api/override/remove_from_subscriptions", async (req, res) => {
  try {
    const { userId: rawUserId, merchantName } = req.body || {};
    const userId = String(rawUserId || "demo-user");
    if (!merchantName) {
      return res.status(400).json({ error: "missing_merchantName" });
    }

    setRecurringOverride({ userId, merchantName, type: "never" });
    return res.json({ ok: true });
  } catch (e) {
    return sendError(res, e);
  }
});

/* ===== Subscriptions & Bills via Plaid Recurring Streams (with fallback) ===== */
app.get("/api/subscriptions", async (req, res) => {
  try {
    const userId = String(req.query.userId || "demo-user");
    const user = await getUserById(userId);
    if (!user?.access_token)
      return res.status(400).json({ error: "no_linked_item" });

    let streams = [];
    try {
      streams = await getRecurringStreamsOnce({
        userId,
        access_token: user.access_token,
      });
    } catch (e) {
      streams = [];
    }

    if (streams.length > 0) {
      const subs = [];
      const now = new Date();

      for (const s of streams) {
        const kind = classifyStream(s, userId);
        if (kind !== "subscription") continue;

        const lastDate = s.last_date || s.first_date || null;
        if (lastDate && daysBetween(lastDate, now) > RECENT_DAYS_CUTOFF) {
          continue;
        }

        const { days, cycle } = freqToInfo(s.frequency);
        const next =
          s.next_date ||
          (s.last_date
            ? addDays(s.last_date, days)
            : s.first_date
            ? addDays(s.first_date, days)
            : toISO(new Date()));

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

      return res.json({ subscriptions: subs });
    }

    // Fallback
    const txns = await getAllTransactionsOnce({
      userId,
      access_token: user.access_token,
    });
    const subs = deriveSubscriptionsFromTxns(txns, userId);
    return res.json({ subscriptions: subs });
  } catch (e) {
    return sendPlaidError(res, e);
  }
});

app.get("/api/bills", async (req, res) => {
  try {
    const userId = String(req.query.userId || "demo-user");
    const user = await getUserById(userId);
    if (!user?.access_token)
      return res.status(400).json({ error: "no_linked_item" });

    let streams = [];
    try {
      streams = await getRecurringStreamsOnce({
        userId,
        access_token: user.access_token,
      });
    } catch (e) {
      streams = [];
    }

    if (streams.length > 0) {
      const bills = [];
      const now = new Date();

      for (const s of streams) {
        const kind = classifyStream(s, userId);
        if (kind !== "bill") continue;

        const lastDate = s.last_date || s.first_date || null;
        if (lastDate && daysBetween(lastDate, now) > RECENT_DAYS_CUTOFF) {
          continue;
        }

        const { days } = freqToInfo(s.frequency);
        const next =
          s.next_date ||
          (s.last_date
            ? addDays(s.last_date, days)
            : s.first_date
            ? addDays(s.first_date, days)
            : toISO(new Date()));

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

      return res.json({ bills });
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
    const bills = deriveBillsFromTxns(txns, subMerchantNames, userId).map((b) => ({
      id: b.id,
      name: b.name,
      amount: b.amount,
      dueDate: b.nextCharge,
      autopay: false,
      variable: false,
      alerts: false,
      website: b.website || null,
      counterparties: b.counterparties || undefined,
    }));
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
