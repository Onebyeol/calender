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
 * 특정 사용자의 기기에만 푸시 알림을 보냄.
 * userId가 null이면 로그인하지 않은 상태에서 알림을 켠 기기들이 대상이 된다
 * (게스트끼리는 같은 묶음이라 서로 알림을 받는다 — 로그인하면 완전히 분리된다).
 * @param {string|null} userId
 * @param {{title: string, body: string, url?: string}} payload
 */
async function sendPushToUser(userId, payload) {
  ensureConfigured();
  if (!configured) return;

  const subs = await PushSubscription.find({ user: userId || null });
  if (subs.length === 0) {
    console.log('[push] 이 사용자에게 등록된 구독자가 없음 (아직 "알림 받기"를 안 눌렀음)');
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

module.exports = { sendPushToUser };
