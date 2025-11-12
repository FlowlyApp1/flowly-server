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

// IMPORTANT: request core products via PLAID_PRODUCTS (e.g. "transactions")
// and consent-requiring add-ons via PLAID_ADDITIONAL_PRODUCTS (e.g. "recurring_transactions")
const PRODUCTS = (process.env.PLAID_PRODUCTS || "transactions")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const ADDITIONAL_PRODUCTS = (process.env.PLAID_ADDITIONAL_PRODUCTS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// iOS OAuth redirect page hosted on this server
const PLAID_REDIRECT_URI = (process.env.PLAID_REDIRECT_URI || "").trim();

// Keep for diagnostics only (we are iOS-only for link token creation)
const ANDROID_PACKAGE_NAME = (process.env.ANDROID_PACKAGE_NAME || "").trim();

// Optional Link customization
const LINK_CUSTOMIZATION = (process.env.PLAID_LINK_CUSTOMIZATION || "").trim();
console.log("Using Plaid Link customization =", LINK_CUSTOMIZATION || "(none)");

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
    using:
      ANDROID_PACKAGE_NAME
        ? `android_package_name=${ANDROID_PACKAGE_NAME}`
        : (PLAID_REDIRECT_URI ? `redirect_uri=${PLAID_REDIRECT_URI}` : "(none)"),
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
 * ONE-PULL CORE (cache + single normalized fetch)
 * ==========================================================================*/

// 60s in-memory cache
const TXN_CACHE = new Map(); // key: userId -> { ts: number, txns: NormalizedTxn[] }
const CACHE_TTL_MS = 60_000;

function normalizeTxn(t) {
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
}

async function getAllTransactionsOnce({ userId, access_token }) {
  const hit = TXN_CACHE.get(userId);
  if (hit && Date.now() - hit.ts < CACHE_TTL_MS) return hit.txns;

  let cursor = await getCursor(userId);
  let added = [];
  let hasMore = true;

  while (hasMore) {
    const sync = await plaid.transactionsSync({
      access_token,
      cursor: cursor || undefined,
      count: 500,
    });
    added = added.concat(sync.data.added || []);
    cursor = sync.data.next_cursor;
    hasMore = !!sync.data.has_more;
  }

  await setUserCursor(userId, cursor);

  if (added.length === 0) {
    const end = new Date();
    const start = new Date(end.getTime() - 90 * 24 * 60 * 60 * 1000);
    const resp = await plaid.transactionsGet({
      access_token,
      start_date: toISO(start),
      end_date: toISO(end),
      options: { count: 500, include_personal_finance_category: true },
    });
    added = resp.data.transactions || [];
  }

  const txns = added.map(normalizeTxn);
  TXN_CACHE.set(userId, { ts: Date.now(), txns });
  return txns;
}

/* ============================================================================
 * Recurring detection (heuristics on NORMALIZED txns)
 * ==========================================================================*/

const SUB_BRANDS = [
  "netflix","spotify","hulu","disney","hbomax","max","youtube","youtube premium","apple.com/bill",
  "adobe","microsoft","onedrive","dropbox","icloud","prime","audible","google","openai",
  "canva","notion","github","xbox","playstation","nintendo","crunchyroll","pandora","paramount",
  "peacock","showtime","headspace","calm","duolingo","uber one","lyft pink"
];

const BILL_BRANDS = [
  "xfinity","comcast","verizon","at&t","att","t-mobile","tmobile","spectrum","wow internet",
  "geico","state farm","progressive","allstate","liberty mutual","usaa",
  "edison","pg&e","pge","con edison","coned","duke energy","fpl","water","utilities","utility"
];

function looksMonthly(dates) {
  if (dates.length < 2) return false;
  dates.sort((a, b) => new Date(a) - new Date(b));
  for (let i = 1; i < dates.length; i++) {
    const gap = daysBetween(dates[i - 1], dates[i]);
    if (gap >= 25 && gap <= 35) return true;
  }
  return false;
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
function merchantMatches(key, list) {
  return list.some((brand) => key.includes(brand));
}

function deriveSubscriptionsFromTxns(txns) {
  const expenses = txns.filter((t) => t.type === "expense").map((t) => ({ ...t, amount: Math.abs(t.amount) }));
  const byMerchant = groupByMerchantNormalized(expenses);
  const out = [];

  for (const [key, group] of byMerchant.entries()) {
    const amounts = group.rows.map((r) => r.amount).sort((a, b) => a - b);
    const median = amounts[Math.floor(amounts.length / 2)] || 0;
    const dates = group.rows.map((r) => r.date);

    const name = group.name;
    const brandHint = merchantMatches(key, SUB_BRANDS);
    const monthlyish = looksMonthly(dates);

    if ((brandHint || monthlyish) && group.rows.length >= 2) {
      const latest = group.rows.sort((a, b) => new Date(b.date) - new Date(a.date))[0];
      out.push(
        buildItem({
          id: `${key}:${Math.round(median * 100)}`,
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
  const expenses = txns.filter((t) => t.type === "expense").map((t) => ({ ...t, amount: Math.abs(t.amount) }));
  const byMerchant = groupByMerchantNormalized(expenses);
  const out = [];

  for (const [key, group] of byMerchant.entries()) {
    const name = group.name;
    const dates = group.rows.map((r) => r.date);
    const amounts = group.rows.map((r) => r.amount).sort((a, b) => a - b);
    const median = amounts[Math.floor(amounts.length / 2)] || 0;

    const isBillBrand = merchantMatches(key, BILL_BRANDS);
    const monthlyish = looksMonthly(dates);

    if ((isBillBrand || monthlyish) && group.rows.length >= 2) {
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
    pfcLooksBill ||
    nameHas(billHints) ||
    catHas("utilities") ||
    catHas("telecommunication") ||
    catHas("insurance") ||
    catHas("service") ||
    catHas("mortgage") ||
    catHas("rent") ||
    catHas("loan");

  const looksSubscription =
    pfcLooksSubscription ||
    (monthlyish && (nameHas(subscriptionHints) || catHas("subscription") || catHas("entertainment")));

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

  const r = await plaid.recurringTransactionsGet({ access_token });
  const streams = r.data?.streams || [];
  STREAMS_CACHE.set(userId, { ts: Date.now(), streams });
  return streams;
}

/* ============================================================================
 * Plaid routes
 * ==========================================================================*/

// Create Link Token — iOS-only; uses additional_consented_products for add-ons
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
      additional_consented_products: ADDITIONAL_PRODUCTS,
      country_codes: ["US"],
      language: "en",
      redirect_uri: PLAID_REDIRECT_URI,
      ...(LINK_CUSTOMIZATION ? { link_customization_name: LINK_CUSTOMIZATION } : {}),
    };

    // strip empty values
    for (const k of Object.keys(payload)) {
      const v = payload[k];
      if (
        v === "" ||
        v == null ||
        (Array.isArray(v) && v.length === 0)
      ) delete payload[k];
    }

    console.log("linkTokenCreate (iOS-only) keys:", Object.keys(payload).sort());

    const resp = await plaid.linkTokenCreate(payload);
    return res.json({ link_token: resp.data.link_token, platform: "ios" });
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
          redirect_uri: PLAID_REDIRECT_URI,
        });
        return res.json({ link_token: fallback.data.link_token, fallback: true, platform: "ios" });
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
        });
        return res.json({ link_token: retry.data.link_token, downgraded_to: "transactions", platform: "ios" });
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
    if (!public_token) return res.status(400).json({ error: "missing_public_token" });

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

/* ============================================================================
 * Start
 * ==========================================================================*/
app.listen(PORT, () => {
  console.log(`Flowly server running on http://localhost:${PORT}`);
});
