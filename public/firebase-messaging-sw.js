/* public/firebase-messaging-sw.js */
/* eslint-disable no-undef */

importScripts("https://www.gstatic.com/firebasejs/8.10.1/firebase-app.js");
importScripts("https://www.gstatic.com/firebasejs/8.10.1/firebase-messaging.js");

// Firebase Web Config（公開してOK）
firebase.initializeApp({
  apiKey: "AIzaSyBDQWarECLOYbAXd4wXb_bmEF2pluKwK9g",
  authDomain: "mofutimer.firebaseapp.com",
  projectId: "mofutimer",
  storageBucket: "mofutimer.firebasestorage.app",
  messagingSenderId: "450155002208",
  appId: "1:450155002208:web:d1d47b37e753d009730605",
});

const messaging = firebase.messaging();

/**
 * 通知の見た目（アイコン/バッジ）
 * - Vite の public 配下はサイトルート "/" から参照できる
 * - 例: public/icons/icon-192.png → "/icons/icon-192.png"
 *
 * ※あなたの実ファイル名に合わせて変更してOK
 */
const NOTIFY_ICON = "/icons/icon-192.png";
const NOTIFY_BADGE = "/icons/badge-72.png";

/**
 * 通知タップ時の遷移先URLを解決する
 * - サーバーが data.notify_url を入れる想定
 * - 互換で複数キーに対応
 */
function resolveClickUrl(notification) {
  const data = (notification && notification.data) || {};
  return (
    data.notify_url ||
    data.url ||
    data.link ||
    data.click_action ||
    "https://mt.qui2.net/#notifications"
  );
}

messaging.onBackgroundMessage((payload) => {
  const title = payload?.notification?.title || "もふタイマー";
  const body = payload?.notification?.body || "";
  const data = payload?.data || {};

  // notification.data にURLを載せておく（クリックで拾うため）
  self.registration.showNotification(title, {
    body,
    data, // ← payload.data をそのまま載せる（重要）
    icon: NOTIFY_ICON,
    badge: NOTIFY_BADGE,

    // あると便利（対応環境のみ）
    tag: data?.race_key || undefined, // 同一レースはまとめやすい
    renotify: false,
  });
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const url = resolveClickUrl(event.notification);

  event.waitUntil(
    (async () => {
      // 既に開いてるタブがあればフォーカスして遷移
      const allClients = await clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });

      for (const c of allClients) {
        if ("focus" in c) {
          await c.focus();
          try {
            if (c.navigate) {
              await c.navigate(url);
              return;
            }
          } catch {
            // navigateがダメなら openWindow に落とす
          }
        }
      }

      if (clients.openWindow) return clients.openWindow(url);
    })()
  );
});
