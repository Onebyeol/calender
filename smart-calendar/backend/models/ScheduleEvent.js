const mongoose = require('mongoose');

// 준비기간을 쪼갠 하위 단계 (기획서 8.9)
// "공지 하나당 이벤트 하나"라는 기존 원칙을 깨지 않으려고, 별도 이벤트가 아니라
// ScheduleEvent 안의 배열로 둔다.
const stepSchema = new mongoose.Schema(
  {
    title: { type: String, required: true },
    // 이 단계를 언제까지 하면 좋은지 (준비 시작일~마감일 사이에 균등 배분)
    plannedDate: { type: String, default: '' }, // YYYY-MM-DD
    done: { type: Boolean, default: false },
    // 실제로 체크한 시각 - 계획 대비 실제 비교(기획서 8.10)에 사용
    doneAt: { type: Date, default: null },
  },
  { _id: false }
);

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

    // 공지 카테고리(학사일정/과제/시험/행사/회의/기타).
    // 리드타임을 다시 계산하거나 회고 결과를 카테고리별 개인화 값에 반영할 때 필요해서
    // Notice에만 두지 않고 일정에도 복사해둔다.
    category: {
      type: String,
      default: '기타',
    },

    // ---------- 준비기간(리드타임) 관련 ----------
    // 준비가 필요한 유형인지. true면 startDate가 마감일보다 앞으로 당겨져 있고,
    // 캘린더에는 "준비 시작일 ~ 마감일" 막대로 그려진다.
    needsPrep: {
      type: Boolean,
      default: false,
    },
    // 적용된 준비기간(일)
    leadTimeDays: {
      type: Number,
      default: 0,
    },
    // 이 값이 어디서 왔는지: ai / rule / rule-corrected / user
    // 발표할 때 "이건 AI가 낸 값, 이건 규칙표가 보정한 값"을 구분해 설명하기 위해 남긴다.
    leadTimeSource: {
      type: String,
      default: '',
    },
    // 리드타임을 적용하기 전의 원래 일정 시작일.
    // startDate를 앞으로 당기면 원래 날짜 정보가 사라지므로 따로 보관한다.
    // (사용자가 나중에 준비기간을 조정할 때 여기서 다시 계산한다)
    originalStartDate: {
      type: String,
      default: '',
    },
    // 어떤 단계 템플릿에서 나온 일정인지 (presentation / writing / exam / school / generic).
    // 사용자가 단계 구성을 고쳤을 때 "무엇에 대해 고친 것인지"를 기억하는 키로 쓴다.
    stepTemplateKey: {
      type: String,
      default: '',
    },
    // 준비 단계 체크리스트
    steps: {
      type: [stepSchema],
      default: [],
    },
    // 마감 후 회고 (기획서 8.10)
    retro: {
      answeredAt: { type: Date, default: null },
      // 'tight'(부족했다) | 'ok'(적당했다) | 'loose'(넉넉했다)
      feeling: { type: String, default: '' },
      // 실제로 준비를 시작한 날 기준 준비일수 (첫 단계 체크 시각으로 계산)
      actualLeadDays: { type: Number, default: null },
    },
  },
  { timestamps: true }
);

scheduleEventSchema.index({ startDate: 1, endDate: 1 });

module.exports = mongoose.model('ScheduleEvent', scheduleEventSchema);
