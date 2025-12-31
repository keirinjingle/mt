// src/firebase.js
import { initializeApp } from "firebase/app";
import { getMessaging } from "firebase/messaging";

/**
 * Firebase Web Config
 * - 値は Vite の import.meta.env から取得
 * - 実体は .env.local（git管理しない）
 */
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: "mofutimer",
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: "450155002208",
  appId: "1:450155002208:web:d1d47b37e753d009730605",
};

const app = initializeApp(firebaseConfig);

/**
 * Firebase Cloud Messaging
 */
export const messaging = getMessaging(app);

/**
 * Web Push 用 VAPID 公開鍵
 * ※ 公開してOK（秘密鍵ではない）
 */
export const VAPID_KEY =
  "BCngjYKqJSC4gdFaFL-SbyHS7KSkvw8VElfPQfDK6XTepKmbP4BuMqD_EhhfTcD5_kzDhCkPrWeRgYETPgN4bG4";
