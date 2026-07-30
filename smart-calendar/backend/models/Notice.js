const mongoose = require('mongoose');

// 원본 공지 하나를 저장하는 스키마.
// AI 분석 결과(요약/중요도/카테고리)를 같이 들고 있어서
// 나중에 "이 공지에서 파생된 일정/할일" 을 역추적할 수 있게 함
const noticeSchema = new mongoose.Schema(
  {
    // 소유자. null이면 로그인 없이(둘러보기 / 공유 시트 / 단축어) 만들어진 게스트 데이터다.
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      index: true,
    },
    sourceType: {
      type: String,
      enum: ['text', 'image'],
      required: true,
    },
    rawContent: {
      // text 입력이면 원문 텍스트, image 입력이면 OCR로 추출된 텍스트
      type: String,
      required: true,
    },
    summary: {
      type: String,
      default: '',
    },
    priority: {
      type: String,
      enum: ['high', 'medium', 'low'],
      default: 'medium',
    },
    category: {
      // 예: 학사일정 / 과제 / 시험 / 행사 / 기타
      type: String,
      default: '기타',
    },
    // AI가 "준비가 필요한 유형"이라고 판단했는지 (기획서 8.3)
    needsPrep: {
      type: Boolean,
      default: false,
    },
    // 이 공지에 최종 적용된 준비기간(일)
    leadTimeDays: {
      type: Number,
      default: 0,
    },
    aiRaw: {
      // AI가 반환한 원본 JSON을 그대로 보관 (디버깅/재처리용)
      type: mongoose.Schema.Types.Mixed,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Notice', noticeSchema);
