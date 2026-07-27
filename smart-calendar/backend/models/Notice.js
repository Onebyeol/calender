const mongoose = require('mongoose');

// 원본 공지 하나를 저장하는 스키마.
// AI 분석 결과(요약/중요도/카테고리)를 같이 들고 있어서
// 나중에 "이 공지에서 파생된 일정/할일" 을 역추적할 수 있게 함
const noticeSchema = new mongoose.Schema(
  {
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
    aiRaw: {
      // AI가 반환한 원본 JSON을 그대로 보관 (디버깅/재처리용)
      type: mongoose.Schema.Types.Mixed,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Notice', noticeSchema);
