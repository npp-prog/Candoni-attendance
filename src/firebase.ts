import { initializeApp } from 'firebase/app';
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from 'firebase/app-check';
import { connectAuthEmulator, getAuth } from 'firebase/auth';
import { connectFirestoreEmulator, getFirestore } from 'firebase/firestore';
import { connectFunctionsEmulator, getFunctions } from 'firebase/functions';

const env = import.meta.env;

export const firebaseConfigured = Boolean(env.VITE_FIREBASE_API_KEY && env.VITE_FIREBASE_PROJECT_ID);

export const app = initializeApp({
  apiKey: env.VITE_FIREBASE_API_KEY || 'missing',
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: env.VITE_FIREBASE_PROJECT_ID || 'missing',
  appId: env.VITE_FIREBASE_APP_ID,
  messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET,
});

export const useEmulators = env.VITE_USE_EMULATORS === 'true';

// App Check (optional): attests that requests come from this web app. It reduces
// automated abuse but does not prove user identity or physical location.
if (!useEmulators && env.VITE_APPCHECK_RECAPTCHA_ENTERPRISE_KEY) {
  initializeAppCheck(app, {
    provider: new ReCaptchaEnterpriseProvider(env.VITE_APPCHECK_RECAPTCHA_ENTERPRISE_KEY),
    isTokenAutoRefreshEnabled: true,
  });
}

export const auth = getAuth(app);
// Production uses the named database "candoni-attendance" (see .env.production).
const databaseId = env.VITE_FIRESTORE_DATABASE_ID || '(default)';
export const db = databaseId === '(default)' ? getFirestore(app) : getFirestore(app, databaseId);
export const functions = getFunctions(app, env.VITE_FUNCTIONS_REGION || 'asia-southeast1');
export const ORG_ID = env.VITE_ORG_ID || 'candoni';

if (useEmulators) {
  const host = location.hostname === 'localhost' ? 'localhost' : '127.0.0.1';
  connectAuthEmulator(auth, `http://${host}:9099`, { disableWarnings: true });
  connectFirestoreEmulator(db, host, 8080);
  connectFunctionsEmulator(functions, host, 5001);
}
