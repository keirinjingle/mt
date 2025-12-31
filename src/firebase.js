// src/firebase.js
import { initializeApp } from "firebase/app";
import { getMessaging } from "firebase/messaging";

const firebaseConfig = {
  // ★ここはあなたの既存の Web Config を入れる（公開OK）
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: "mofutimer",
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: "450155002208",
  appId: "1:450155002208:web:d1d47b37e753d009730605",
};

const app = initializeApp(firebaseConfig);
export const messaging = getMessaging(app);

// 公開VAPID鍵
export const VAPID_KEY =
  "BCngjYKqJSC4gdFaFL-SbyHS7KSkvw8VElfPQfDK6XTepKmbP4BuMqD_EhhfTcD5_kzDhCkPrWeRgYETPgN4bG4";
