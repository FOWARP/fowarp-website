// 알림 수신 전용 서비스워커.
// 캐싱은 하지 않는다 — 사이트를 오프라인화할 목적이 아니라 푸시를 받기
// 위한 것뿐이고, 캐시를 붙이면 배포한 새 페이지가 안 보이는 사고가 난다.

self.addEventListener('install', function (e) {
  self.skipWaiting();
});

self.addEventListener('activate', function (e) {
  e.waitUntil(self.clients.claim());
});

self.addEventListener('push', function (e) {
  var d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { body: e.data && e.data.text() }; }

  e.waitUntil(
    self.registration.showNotification(d.title || 'FOWARP', {
      body: d.body || '',
      icon: '/apple-touch-icon.png',
      badge: '/apple-touch-icon.png',
      tag: d.tag || 'fowarp',
      data: { url: d.url || '/' },
    })
  );
});

self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  var url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
      for (var i = 0; i < list.length; i++) {
        if ('focus' in list[i]) return list[i].focus();
      }
      return self.clients.openWindow(url);
    })
  );
});
