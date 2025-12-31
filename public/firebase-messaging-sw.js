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

messaging.onBackgroundMessage((payload) => {
  const title = payload?.notification?.title || "もふタイマー";
  const body = payload?.notification?.body || "";
  const data = payload?.data || {};

  self.registration.showNotification(title, {
    body,
    data,
  });
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = "https://mt.qui2.net/#notifications";
  event.waitUntil(clients.openWindow(url));
});
