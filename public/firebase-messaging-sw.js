/* eslint-disable no-restricted-globals */
// Firebase Cloud Messaging Service Worker for HSS ALL IN ONE
// Handles background web push and notification click redirection to '/HSS-ALL-IN-ONE-App-/'

importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js');

// Base path constant for HSS ALL IN ONE deployment (dynamically detects GitHub Pages repo subpath vs root)
const BASE_PATH = (self.location && self.location.pathname)
  ? (self.location.pathname.replace(/[^/]+$/, '') || '/')
  : '/';

// Service worker immediate activation
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(clients.claim());
});

// Initialize Firebase compat app for service worker
firebase.initializeApp({
  apiKey: "AIzaSyDyI4ZU-UgnoqYr_nicbTIAR5-gDY8aBTw",
  authDomain: "hss-all-in-one-1.firebaseapp.com",
  databaseURL: "https://hss-all-in-one-1-default-rtdb.firebaseio.com",
  projectId: "hss-all-in-one-1",
  storageBucket: "hss-all-in-one-1.firebasestorage.app",
  messagingSenderId: "679893158194",
  appId: "1:679893158194:web:5f7cf7e5a953c05330af2b"
});

const messaging = firebase.messaging();

/**
 * Resolves any target path to a fully qualified URL pointing to the base path '/HSS-ALL-IN-ONE/'
 */
function resolveAppUrl(targetPath) {
  const origin = self.location.origin;
  if (!targetPath || targetPath === '/' || targetPath === origin || targetPath === origin + '/') {
    return new URL(BASE_PATH, origin).href;
  }
  if (targetPath.startsWith('http://') || targetPath.startsWith('https://')) {
    return targetPath;
  }
  if (targetPath.startsWith(BASE_PATH)) {
    return new URL(targetPath, origin).href;
  }
  const cleanSubpath = targetPath.replace(/^\/+/, '');
  return new URL(BASE_PATH + cleanSubpath, origin).href;
}

// Background push notification event handler
messaging.onBackgroundMessage((payload) => {
  console.log('[firebase-messaging-sw.js] Background message received:', payload);

  const title = payload.notification?.title || payload.data?.title || 'HSS ALL IN ONE Notification';
  const body = payload.notification?.body || payload.data?.body || 'You have a new update from school.';
  
  // Resolve icon, badge, and target deep link respecting '/HSS-ALL-IN-ONE/'
  const iconUrl = payload.notification?.icon || payload.data?.icon || resolveAppUrl('icon-192.png');
  const badgeUrl = payload.data?.badge || resolveAppUrl('favicon-32x32.png');
  const targetUrl = resolveAppUrl(payload.data?.url || payload.data?.click_action || BASE_PATH);
  const category = payload.data?.category || 'school_notices';

  const notificationOptions = {
    body: body,
    icon: iconUrl,
    badge: badgeUrl,
    tag: payload.data?.tag || `hss-${Date.now()}`,
    data: {
      url: targetUrl,
      category: category,
      timestamp: Date.now()
    },
    vibrate: [200, 100, 200],
    requireInteraction: false
  };

  return self.registration.showNotification(title, notificationOptions);
});

// Notification click handler: redirects to the base path '/HSS-ALL-IN-ONE/'
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  // Target redirect URL points to the base path '/HSS-ALL-IN-ONE/'
  const clickTarget = event.notification.data?.url || BASE_PATH;
  const redirectUrl = resolveAppUrl(clickTarget);

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      // Check if there is already an open window matching the origin or base path
      for (let i = 0; i < windowClients.length; i++) {
        const client = windowClients[i];
        if (client.url.includes(BASE_PATH) || client.url.startsWith(self.location.origin)) {
          if ('focus' in client) {
            client.focus();
          }
          if ('navigate' in client && client.url !== redirectUrl) {
            return client.navigate(redirectUrl);
          }
          return;
        }
      }
      // If no open client found, open a new window redirecting to '/HSS-ALL-IN-ONE/'
      if (clients.openWindow) {
        return clients.openWindow(redirectUrl);
      }
    })
  );
});
