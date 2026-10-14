require("dotenv").config();

const { initializeApp, cert, getApps } = require("firebase-admin/app");
const { getMessaging } = require("firebase-admin/messaging");

const getServiceAccount = () => {
  if (!process.env.FIREBASE_SERVICE_ACCOUNT_JSON) return null;
  try {
    return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  } catch (err) {
    console.error("Failed to parse FIREBASE_SERVICE_ACCOUNT_JSON:", err.message);
    return null;
  }
};
const serviceAccount = getServiceAccount();
const isFirebaseConfigured = !!serviceAccount;

if (!isFirebaseConfigured) {
  console.warn("⚠️  Firebase not configured — FIREBASE_SERVICE_ACCOUNT_JSON missing/invalid");
} else if (!getApps().length) {
  initializeApp({ credential: cert(serviceAccount) });
  console.log("✅ Firebase Admin initialized");
}

const safeGetMessaging = () => {
  if (!isFirebaseConfigured) throw new Error("Firebase not configured");
  return getMessaging();
};

module.exports = { getMessaging: safeGetMessaging, isFirebaseConfigured };