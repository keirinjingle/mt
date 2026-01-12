/* public/firebase-messaging-sw.js */
/* eslint-disable no-undef */

// ★ v8 -> v9 (Compat) にアップグレード
importScripts("https://www.gstatic.com/firebasejs/9.23.0/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/9.23.0/firebase-messaging-compat.js");

// Firebase Config
firebase.initializeApp({
  apiKey: "AIzaSyBDQWarECLOYbAXd4wXb_bmEF2pluKwK9g",
  authDomain: "mofutimer.firebaseapp.com",
  projectId: "mofutimer",
  storageBucket: "mofutimer.firebasestorage.app",
  messagingSenderId: "450155002208",
  appId: "1:450155002208:web:d1d47b37e753d009730605",
});

const messaging = firebase.messaging();

// バックグラウンド通知の処理
messaging.onBackgroundMessage((payload) => {
  console.log("[SW] Background:", payload);
  
  const title = payload?.notification?.title || payload?.data?.title || "もふタイマー";
  const body = payload?.notification?.body || payload?.data?.body || "";
  const icon = "/icons/icon-192.png";
  
  // サーバーから送られたデータをそのまま通知オプションに渡す
  const options = {
    body: body,
    icon: icon,
    badge: "/icons/badge-72.png",
    data: payload.data || {}, // URL情報などがここに入っている
    tag: payload.data?.race_key, // 重複防止タグ
    renotify: true // 同じタグでも音を鳴らす設定
  };

  return self.registration.showNotification(title, options);
});

// 通知クリック時の処理
self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  // サーバーから受け取ったURL、なければ通知一覧へ
  const urlToOpen = event.notification.data?.url || 
                    event.notification.data?.notify_url || 
                    "https://mt.qui2.net/#notifications";

  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      // 既に開いているタブがあればフォーカス
      for (const client of clientList) {
        if (client.url === urlToOpen && "focus" in client) return client.focus();
      }
      // なければ新しく開く
      if (clients.openWindow) return clients.openWindow(urlToOpen);
    })
  );
});