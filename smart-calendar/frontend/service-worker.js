// Android Web Share Target의 파일 POST는 서비스워커에서 먼저 formData로 읽은 뒤
// 새 multipart 요청으로 서버에 전달한다. Android/WebAPK가 만든 원본 스트림을 서버로
// 바로 넘길 때 일부 기기에서 "Unexpected end of form"이 나는 문제를 피하기 위함이다.
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'POST' || url.pathname !== '/api/notices/share-target') return;

  event.respondWith((async () => {
    try {
      const incoming = await event.request.formData();
      const outgoing = new FormData();

      for (const [key, value] of incoming.entries()) {
        const isFile = typeof value === 'object'
          && value !== null
          && typeof value.arrayBuffer === 'function';
        if (isFile) {
          outgoing.append('image', value, value.name || 'shared-image');
        } else {
          outgoing.append(key, String(value));
        }
      }

      return await fetch('/api/notices/share-upload', {
        method: 'POST',
        body: outgoing,
        credentials: 'include',
      });
    } catch (err) {
      const query = new URLSearchParams({
        shareStatus: 'error',
        shareMessage: '공유한 이미지 데이터를 읽지 못했어요.',
      });
      return Response.redirect(`${self.location.origin}/?${query.toString()}`, 303);
    }
  })());
});

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
