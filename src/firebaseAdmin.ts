import admin from "firebase-admin";

if (!admin.apps.length) {
  // Option A: GOOGLE_APPLICATION_CREDENTIALS points to your service account JSON
  // export GOOGLE_APPLICATION_CREDENTIALS=/path/to/serviceAccount.json

  // Option B: Use JSON in env var FIREBASE_SERVICE_ACCOUNT (stringified)
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    const svc = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({
      credential: admin.credential.cert(svc),
    });
  } else {
    admin.initializeApp({
      credential: admin.credential.applicationDefault(),
    });
  }
}

export default admin;
