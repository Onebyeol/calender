// 서비스워커: 앱이 꺼져있거나 백그라운드여도 푸시가 오면 알림을 띄워줌
self.addEventListener('push', (event) => {
  let data = { title: '신박한 캘린더', body: '새 알림이 있어요.' };
  try {
    if (event.data) data = event.data.json();
  } catch (e) {
    if (event.data) data.body = event.data.text();
  }

  event.waitUntil(
    self.registration.showNotification(data.title || '신박한 캘린더', {
      body: data.body || '',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      vibrate: [200, 100, 200], // 진동 (지원하는 기기에서)
      tag: 'sinbak-calendar', // 같은 tag면 알림이 쌓이지 않고 갱신됨
    })
  );
});

// 알림을 탭하면 앱 창을 열거나, 이미 열려있으면 그 창에 포커스
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow('/');
    })
  );
});
