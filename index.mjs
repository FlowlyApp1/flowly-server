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
const PRODUCTS = (process.env.PLAID_PRODUCTS || "transactions")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// IMPORTANT (iOS OAuth): must be your HTTPS page (Render), e.g. https://<domain>/plaid-oauth
const PLAID_REDIRECT_URI = (process.env.PLAID_REDIRECT_URI || "").trim();

// Android intent verification
const ANDROID_PACKAGE_NAME = (process.env.ANDROID_PACKAGE_NAME || "").trim();

// Link customization (optional)
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
 * OAuth return page
 * Always bounce into the installed native app via the **flowlyapp://** scheme.
 * ==========================================================================*/
app.get("/plaid-oauth", (req, res) => {
  const scheme = "flowlyapp"; // native app’s custom URL scheme
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
 * Plaid routes
 * ==========================================================================*/

// Create Link Token — client must pass { platform: 'ios' | 'android' }
app.post("/api/create_link_token", async (req, res) => {
  try {
    const client_user_id = String(req.body?.userId || "demo-user");
    const platform = String(req.body?.platform || "").toLowerCase(); // 'ios' | 'android'
    if (platform !== "ios" && platform !== "android") {
      return res.status(400).json({
        error: "invalid_platform",
        hint: "Pass platform as 'ios' or 'android'.",
      });
    }

    const base = {
      user: { client_user_id },
      client_name: "Flowly",
      products: PRODUCTS,
      country_codes: ["US"],
      language: "en",
      ...(LINK_CUSTOMIZATION ? { link_customization_name: LINK_CUSTOMIZATION } : {}),
    };

    // Platform-specific extras
    let extras = {};
    if (platform === "ios") {
      if (!PLAID_REDIRECT_URI) {
        return res.status(400).json({
          error: "missing_redirect_uri",
          hint: "Set PLAID_REDIRECT_URI to your HTTPS page, e.g. https://<your-domain>/plaid-oauth",
        });
      }
      extras = { redirect_uri: PLAID_REDIRECT_URI };
    } else {
      if (!ANDROID_PACKAGE_NAME) {
        return res.status(400).json({
          error: "missing_android_package_name",
          hint: "Set ANDROID_PACKAGE_NAME (e.g. com.seanjones.flowlyapp)",
        });
      }
      extras = { android_package_name: ANDROID_PACKAGE_NAME };
    }

    console.log("Creating link token with:", {
      platform,
      LINK_CUSTOMIZATION: LINK_CUSTOMIZATION || "(none)",
      using_redirect: !!extras.redirect_uri,
      using_android_pkg: !!extras.android_package_name,
    });

    const resp = await plaid.linkTokenCreate({ ...base, ...extras });
    res.json({ link_token: resp.data.link_token, platform });
  } catch (e) {
    const code = e?.response?.data?.error_code;

    // Fallbacks for common dashboard/config errors
    if (code === "INVALID_FIELD") {
      try {
        const client_user_id = String(req.body?.userId || "demo-user");
        const fallback = await plaid.linkTokenCreate({
          user: { client_user_id },
          client_name: "Flowly",
          products: PRODUCTS,
          country_codes: ["US"],
          language: "en",
          ...(LINK_CUSTOMIZATION ? { link_customization_name: LINK_CUSTOMIZATION } : {}),
        });
        return res.json({ link_token: fallback.data.link_token, fallback: true });
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
          products: ["balance"],
          country_codes: ["US"],
          language: "en",
          ...(LINK_CUSTOMIZATION ? { link_customization_name: LINK_CUSTOMIZATION } : {}),
        });
        return res.json({ link_token: retry.data.link_token, downgraded_to: "balance" });
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

// Transactions via /transactions/sync with one-time backfill
app.get("/api/transactions", async (req, res) => {
  try {
    const userId = String(req.query.userId || "demo-user");
    const user = await getUserById(userId);
    if (!user?.access_token) return res.status(400).json({ error: "no_linked_item" });

    let cursor = await getCursor(userId);
    let added = [];
    let hasMore = true;

    // 1) Incremental sync
    while (hasMore) {
      const sync = await plaid.transactionsSync({
        access_token: user.access_token,
        cursor: cursor || undefined,
        count: 500,
      });
      added = added.concat(sync.data.added || []);
      cursor = sync.data.next_cursor;
      hasMore = !!sync.data.has_more;
    }

    // Persist latest cursor
    await setUserCursor(userId, cursor);

    // 2) Backfill if first sync returned nothing
    if (added.length === 0) {
      const end = new Date();
      const start = new Date(end.getTime() - 90 * 24 * 60 * 60 * 1000); // last 90 days

      const resp = await plaid.transactionsGet({
        access_token: user.access_token,
        start_date: toISO(start),
        end_date: toISO(end),
        options: {
          count: 500,
          include_personal_finance_category: true,
        },
      });

      added = resp.data.transactions || [];
    }

    // 3) Normalize shape expected by the app
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
    const code = e?.response?.data?.error_code || e?.error_code;
    if (code === "PRODUCT_NOT_READY") {
      // Tell the app: “still preparing; try again soon”
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

/* ============================================================================
 * NEW: lightweight recurring detection for subscriptions & bills
 *  - No extra Plaid products required.
 *  - Heuristics over the last ~180 days of transactions.
 *  - Returns logo-friendly fields (website/counterparties) used by the app.
 * ==========================================================================*/

/** Fetch a recent window of transactions (180 days), including PFC + counterparties */
async function fetchRecentTxns(access_token, days = 180, count = 1000) {
  const end = new Date();
  const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);

  const resp = await plaid.transactionsGet({
    access_token,
    start_date: toISO(start),
    end_date: toISO(end),
    options: {
      count,
      include_personal_finance_category: true,
    },
  });

  return resp.data.transactions || [];
}

/** Basic sets of brands to hint classification */
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

/** Decide if two dates look monthly-ish (25–35 days apart) */
function looksMonthly(dates) {
  if (dates.length < 2) return false;
  dates.sort((a, b) => new Date(a) - new Date(b));
  // Check any adjacent pair
  for (let i = 1; i < dates.length; i++) {
    const gap = daysBetween(dates[i - 1], dates[i]);
    if (gap >= 25 && gap <= 35) return true;
  }
  return false;
}

/** Choose next charge date by adding ~30 days to the latest date */
function nextMonthlyFrom(lastISO) {
  return addDays(lastISO, 30);
}

/** Normalize website (from transaction or counterparty) */
function pickWebsite(t) {
  if (t.website) return t.website;
  const cp = Array.isArray(t.counterparties) ? t.counterparties[0] : null;
  return cp?.website || null;
}

/** Build normalized item for UI */
function buildItem({ id, name, amount, date, cycle, website, counterparties }) {
  return {
    id,
    name,
    amount: Math.abs(Number(amount || 0)),
    cycle, // 'monthly' | 'annual'
    nextCharge: cycle === "monthly" ? nextMonthlyFrom(date) : addDays(date, 365),
    // Logo helpers for the app's LogoBubble:
    website: website || null,
    counterparties: counterparties || undefined,
    alerts: false,
  };
}

/** Group transactions by merchant (case-insensitive) */
function groupByMerchant(txns) {
  const map = new Map();
  for (const t of txns) {
    const merch = (t.merchant_name || t.name || "Unknown").trim();
    const key = merch.toLowerCase();
    if (!map.has(key)) map.set(key, { name: merch, rows: [] });
    map.get(key).rows.push(t);
  }
  return map;
}

/** Simple classifier: is this merchant likely a subscription/bill brand? */
function merchantMatches(key, list) {
  return list.some((brand) => key.includes(brand));
}

/** Extract approximate recurring “subscriptions” */
async function deriveSubscriptions(access_token) {
  const all = await fetchRecentTxns(access_token);
  const expenses = all.filter((t) => t.amount > 0); // Plaid: positive -> money out (expense)
  const byMerchant = groupByMerchant(expenses);

  const out = [];
  for (const [key, group] of byMerchant.entries()) {
    // Pick rows close in amount and monthly cadence
    const amounts = group.rows.map((r) => r.amount).sort((a, b) => a - b);
    const median = amounts[Math.floor(amounts.length / 2)] || 0;
    const dates = group.rows.map((r) => r.date);

    const name = group.name;
    const brandHint = merchantMatches(key, SUB_BRANDS);
    const monthlyish = looksMonthly(dates);

    if ((brandHint || monthlyish) && group.rows.length >= 2) {
      // Latest charge
      const latest = group.rows.sort((a, b) => new Date(b.date) - new Date(a.date))[0];
      out.push(
        buildItem({
          id: `${key}:${Math.round(median * 100)}`,
          name,
          amount: median,
          date: latest.date,
          cycle: "monthly",
          website: pickWebsite(latest),
          counterparties: latest.counterparties,
        })
      );
    }
  }

  // Deduplicate by id and prefer most-recent
  const uniq = new Map();
  for (const s of out) {
    if (!uniq.has(s.id)) uniq.set(s.id, s);
    else {
      const a = uniq.get(s.id);
      if (new Date(s.nextCharge) > new Date(a.nextCharge)) uniq.set(s.id, s);
    }
  }
  return Array.from(uniq.values()).slice(0, 50);
}

/** Extract approximate recurring “bills” */
async function deriveBills(access_token) {
  const all = await fetchRecentTxns(access_token);
  const expenses = all.filter((t) => t.amount > 0);
  const byMerchant = groupByMerchant(expenses);

  const out = [];
  for (const [key, group] of byMerchant.entries()) {
    const name = group.name;
    const dates = group.rows.map((r) => r.date);
    const amounts = group.rows.map((r) => r.amount).sort((a, b) => a - b);
    const median = amounts[Math.floor(amounts.length / 2)] || 0;

    // Bills: utilities/telecom/insurance, or consistent monthly charges with utility-like names
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
          website: pickWebsite(latest),
          counterparties: latest.counterparties,
        })
      );
    }
  }

  // Deduplicate & cap results
  const uniq = new Map();
  for (const b of out) {
    if (!uniq.has(b.id)) uniq.set(b.id, b);
  }
  return Array.from(uniq.values()).slice(0, 50);
}

/* ===== Routes ===== */

/** Subscriptions */
app.get("/api/subscriptions", async (req, res) => {
  try {
    const userId = String(req.query.userId || "demo-user");
    const user = await getUserById(userId);
    if (!user?.access_token) return res.status(400).json({ error: "no_linked_item" });

    const items = await deriveSubscriptions(user.access_token);
    // Normalize to the client type (name, amount, cycle, nextCharge, website/counterparties)
    const subs = items.map((s) => ({
      id: s.id,
      name: s.name,
      amount: s.amount,
      cycle: s.cycle, // 'monthly'
      nextCharge: s.nextCharge,
      isPaused: false,
      alerts: false,
      website: s.website || null,
      counterparties: s.counterparties || undefined,
    }));

    res.json({ subscriptions: subs });
  } catch (e) {
    return sendPlaidError(res, e);
  }
});

/** Bills */
app.get("/api/bills", async (req, res) => {
  try {
    const userId = String(req.query.userId || "demo-user");
    const user = await getUserById(userId);
    if (!user?.access_token) return res.status(400).json({ error: "no_linked_item" });

    const items = await deriveBills(user.access_token);
    const bills = items.map((b) => ({
      id: b.id,
      name: b.name,
      amount: b.amount,
      dueDate: b.nextCharge, // maps to your UI’s "Due" label
      autopay: false,
      alerts: false,
      website: b.website || null,
      counterparties: b.counterparties || undefined,
    }));

    res.json({ bills });
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
