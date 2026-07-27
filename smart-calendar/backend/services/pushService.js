const webpush = require('web-push');
const PushSubscription = require('../models/PushSubscription');

let configured = false;

function ensureConfigured() {
  if (configured) return;
  const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT } = process.env;
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    console.warn('[push] VAPID 키가 .env에 없어서 웹 푸시가 비활성화됨');
    return;
  }
  webpush.setVapidDetails(VAPID_SUBJECT || 'mailto:example@example.com', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  configured = true;
}

/**
 * 저장된 모든 구독자에게 푸시 알림을 보냄 (지금은 로그인/유저 구분이 없어서
 * "이 기기에서 알림 받기"를 눌렀던 모든 브라우저에게 다 감)
 * @param {{title: string, body: string, url?: string}} payload
 */
async function sendPushToAll(payload) {
  ensureConfigured();
  if (!configured) return;

  const subs = await PushSubscription.find();
  if (subs.length === 0) {
    console.log('[push] 등록된 구독자가 없음 (아직 아무도 "알림 받기"를 안 눌렀음)');
    return;
  }

  const body = JSON.stringify(payload);

  await Promise.all(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } },
          body
        );
      } catch (err) {
        // 구독이 만료됐거나(410 Gone) 브라우저에서 알림을 껐으면 DB에서도 지워줌
        if (err.statusCode === 404 || err.statusCode === 410) {
          await PushSubscription.deleteOne({ _id: sub._id });
        } else {
          console.error('[push] 발송 실패:', err.message);
        }
      }
    })
  );
}

module.exports = { sendPushToAll };
