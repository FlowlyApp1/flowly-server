// server/firebase.mjs
import { initializeApp, applicationDefault, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const projectId = process.env.FIREBASE_PROJECT_ID || undefined;

// Prefer GOOGLE_APPLICATION_CREDENTIALS (path to service account JSON) or
// set FIREBASE_SERVICE_ACCOUNT_JSON to the JSON string.
let app;
if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  app = initializeApp({ credential: cert(serviceAccount) });
} else {
  app = initializeApp({
    credential: applicationDefault(),
    projectId,
  });
}

export const db = getFirestore();

/** Users → { access_token, item_id, cursor } */
export const usersCol = db.collection("users");

export async function upsertUserItem({ userId, access_token, item_id }) {
  const ref = usersCol.doc(userId);
  await ref.set({ access_token, item_id }, { merge: true });
}

export async function getUserById(userId) {
  const doc = await usersCol.doc(userId).get();
  return doc.exists ? doc.data() : null;
}

export async function setUserCursor(userId, cursor) {
  await usersCol.doc(userId).set({ cursor }, { merge: true });
}

export async function getCursor(userId) {
  const doc = await usersCol.doc(userId).get();
  return doc.exists ? doc.data()?.cursor || null : null;
}

/** Optional reverse lookup by item_id (useful in webhooks) */
export async function getUserIdByItemId(item_id) {
  const snap = await usersCol.where("item_id", "==", item_id).limit(1).get();
  if (snap.empty) return null;
  return snap.docs[0].id;
}
