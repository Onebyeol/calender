const mongoose = require('mongoose');

// 브라우저의 PushManager.subscribe()가 반환하는 구독 객체를 그대로 저장
const pushSubscriptionSchema = new mongoose.Schema(
  {
    // 이 구독이 누구 것인지. null이면 로그인하지 않은 상태에서 알림을 켠 기기다.
    // endpoint는 브라우저마다 하나뿐이라, 같은 기기에서 다른 계정으로 로그인해 알림을 켜면
    // 아래 findOneAndUpdate(upsert)로 소유자만 새 계정으로 옮겨간다.
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      index: true,
    },
    endpoint: { type: String, required: true, unique: true },
    keys: {
      p256dh: { type: String, required: true },
      auth: { type: String, required: true },
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('PushSubscription', pushSubscriptionSchema);
