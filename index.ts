// server/index.ts
import "dotenv/config";
import express, { Response } from "express";
import cors from "cors";
import bodyParser from "body-parser";
import { Configuration, PlaidApi, PlaidEnvironments } from "plaid";

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: "1mb" }));

const PORT = Number(process.env.PORT || 3000);

// ----- Env + Plaid client -----
const PLAID_ENV = (process.env.PLAID_ENV || "sandbox").trim();
const PRODUCTS_ENV = (process.env.PLAID_PRODUCTS || "transactions")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

const PLAID_REDIRECT_URI = (process.env.PLAID_REDIRECT_URI || "").trim();
const ANDROID_PACKAGE_NAME = (process.env.ANDROID_PACKAGE_NAME || "").trim();
const USE_ANDROID = !!ANDROID_PACKAGE_NAME;
const USE_REDIRECT = !!PLAID_REDIRECT_URI && !USE_ANDROID;

const config = new Configuration({
  basePath: PlaidEnvironments[PLAID_ENV as keyof typeof PlaidEnvironments],
  baseOptions: {
    headers: {
      "PLAID-CLIENT-ID": process.env.PLAID_CLIENT_ID ?? "",
      "PLAID-SECRET": process.env.PLAID_SECRET ?? "",
      "Plaid-Version": "2020-09-14",
    },
    timeout: 15000,
  },
});
const plaid = new PlaidApi(config);

// demo-only storage
let accessToken: string | null = null;

// ----- helpers -----
function sendPlaidError(res: Response, err: any, fallbackStatus = 500) {
  const details = err?.response?.data || { message: String(err?.message || err) };
  console.error("Plaid error →", details);
  res.status(err?.response?.status || fallbackStatus).json(details);
}

// ----- diagnostics -----
app.get("/api/health", (_req, res) => res.json({ ok: true }));
app.get("/api/env-check", (_req, res) =>
  res.json({
    env: PLAID_ENV,
    products: PRODUCTS_ENV,
    using: USE_ANDROID ? `android_package_name=${ANDROID_PACKAGE_NAME}` :
           USE_REDIRECT ? `redirect_uri=${PLAID_REDIRECT_URI}` : "(none)",
  })
);

// ----- Create Link Token -----
app.post("/api/create_link_token", async (req, res) => {
  const client_user_id = String(req.body?.userId || "demo-user");

  const make = async (products: string[]) =>
    plaid.linkTokenCreate({
      user: { client_user_id },
      client_name: "Flowly",
      products,
      country_codes: ["US"],
      language: "en",
      ...(USE_ANDROID ? { android_package_name: ANDROID_PACKAGE_NAME } : {}),
      ...(USE_REDIRECT ? { redirect_uri: PLAID_REDIRECT_URI } : {}),
    });

  try {
    const resp = await make(PRODUCTS_ENV);
    return res.json({ link_token: resp.data.link_token });
  } catch (e: any) {
    const code = e?.response?.data?.error_code;
    if (code === "PRODUCTS_NOT_ENABLED") {
      try {
        const retry = await make(["balance"]);
        return res.json({ link_token: retry.data.link_token, downgraded_to: "balance" });
      } catch (e2) {
        return sendPlaidError(res, e2);
      }
    }
    if (code === "INVALID_FIELD") {
      try {
        const fallback = await plaid.linkTokenCreate({
          user: { client_user_id },
          client_name: "Flowly",
          products: PRODUCTS_ENV,
          country_codes: ["US"],
          language: "en",
        });
        return res.json({ link_token: fallback.data.link_token, fallback: true });
      } catch (e3) {
        return sendPlaidError(res, e3);
      }
    }
    return sendPlaidError(res, e);
  }
});

// ----- Token exchange -----
app.post("/api/exchange_public_token", async (req, res) => {
  try {
    const { public_token } = req.body || {};
    if (!public_token) return res.status(400).json({ error: "missing_public_token" });

    const resp = await plaid.itemPublicTokenExchange({ public_token });
    accessToken = resp.data.access_token;
    res.json({ ok: true });
  } catch (e) {
    return sendPlaidError(res, e);
  }
});

// ----- Transactions -----
app.get("/api/transactions", async (_req, res) => {
  try {
    if (!accessToken) return res.status(400).json({ error: "no_linked_item" });

    const end = new Date();
    const start = new Date(end);
    start.setMonth(end.getMonth() - 3);

    const r = await plaid.transactionsGet({
      access_token: accessToken,
      start_date: start.toISOString().slice(0, 10),
      end_date: end.toISOString().slice(0, 10),
      options: { count: 250, offset: 0 },
    });

    const txns = r.data.transactions.map((t: any) => {
      const expense = t.amount > 0;
      return {
        id: t.transaction_id,
        date: t.date,
        amount: expense ? -Math.abs(t.amount) : Math.abs(t.amount),
        categoryId: (t.personal_finance_category?.primary || "uncategorized").toLowerCase(),
        merchant: t.merchant_name || t.name,
        type: expense ? "expense" : "income",
        merchantDomain: t.merchant_website || undefined, // not all types include this
        logoUrl: undefined,
      };
    });

    res.json({ txns });
  } catch (e) {
    return sendPlaidError(res, e);
  }
});

app.listen(PORT, () => {
  console.log(`Plaid server running on http://localhost:${PORT}`);
});
