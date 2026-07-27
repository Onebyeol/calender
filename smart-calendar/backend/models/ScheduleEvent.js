const mongoose = require('mongoose');

const scheduleEventSchema = new mongoose.Schema(
  {
    // AI 분석에서 나온 일정이면 원본 공지를 가리킴. 수동으로 추가한 일정이면 null
    noticeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Notice',
      default: null,
    },
    title: {
      type: String,
      required: true,
    },
    // 여러 날짜에 걸친 일정(예: 기말고사 기간)을 표현하기 위해 시작/종료 날짜를 분리
    startDate: {
      type: String, // YYYY-MM-DD
      required: true,
    },
    endDate: {
      type: String, // YYYY-MM-DD, 하루짜리 일정이면 startDate와 동일
      required: true,
    },
    start: {
      type: String, // HH:mm
      default: '09:00',
    },
    end: {
      type: String, // HH:mm
      default: '10:00',
    },
    alarm: {
      type: Boolean,
      default: true,
    },
    notify: {
      type: Boolean,
      default: true,
    },
    priority: {
      type: String,
      enum: ['high', 'medium', 'low'],
      default: 'medium',
    },
    // AI가 분석한 경우에만 채워짐 - 상세보기 화면에서 보여줌
    aiSummary: {
      type: String,
      default: '',
    },
    sourceType: {
      type: String,
      enum: ['text', 'image', 'manual'],
      default: 'manual',
    },
    sourceContent: {
      // 원문(텍스트 원문 또는 이미지였다는 표시). 수동 추가는 빈 문자열
      type: String,
      default: '',
    },
  },
  { timestamps: true }
);

scheduleEventSchema.index({ startDate: 1, endDate: 1 });

module.exports = mongoose.model('ScheduleEvent', scheduleEventSchema);
