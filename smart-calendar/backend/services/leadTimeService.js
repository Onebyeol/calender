// ============================================================
// 리드타임(준비기간) 판단 + 준비 단계 분해
// ------------------------------------------------------------
// 이 서비스의 핵심 원칙:
//   AI는 "준비가 필요한 유형인가(needsPrep)"와 "며칠쯤 걸릴 것 같은가(suggestedLeadDays)"
//   두 가지의 '초안'만 낸다. 최종 값은 아래 카테고리 규칙표가 보정하고,
//   마지막엔 사용자가 확인 화면에서 직접 조정한다.
//   → 발표에서 "AI가 알아서 다 정한다"고 과장하지 않아도 되는 구조.
// ============================================================

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

// 배포 서버(Render/Railway 등)는 보통 타임존이 UTC라서, 그냥 new Date()를 쓰면
// 한국 시각 오전에 날짜가 하루 밀린다. 그래서 UTC 기준으로 9시간을 더해 KST 날짜를 만든다.
function todayIso() {
  const kst = new Date(Date.now() + KST_OFFSET_MS);
  return `${kst.getUTCFullYear()}-${String(kst.getUTCMonth() + 1).padStart(2, '0')}-${String(kst.getUTCDate()).padStart(2, '0')}`;
}

// YYYY-MM-DD 문자열에 n일을 더하거나 뺀다(음수 가능).
// Date를 로컬 타임존으로 다루면 서버 TZ에 따라 하루씩 밀리므로 전부 UTC로 계산한다.
function addDays(iso, n) {
  const [y, m, d] = String(iso).split('-').map(Number);
  if (!y || !m || !d) return iso;
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

// fromIso부터 toIso까지 며칠인지 (같은 날이면 0, toIso가 과거면 음수)
function diffDays(fromIso, toIso) {
  const [y1, m1, d1] = String(fromIso).split('-').map(Number);
  const [y2, m2, d2] = String(toIso).split('-').map(Number);
  if (!y1 || !y2) return 0;
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000);
}

// ---------- 일정 종류(카테고리) 정의 ----------
// 사용자가 종류를 추가/삭제/이름변경할 수 있으므로, 규칙표를 상수로 박아두지 않고
// "종류 목록"에서 매번 만들어 쓴다. 아래는 사용자가 아무 설정도 안 했을 때의 기본값이다.
//
//   leadDays     : 그 종류의 기본 준비일수 (0이면 준비기간을 안 붙임)
//   aiDecides    : 준비가 필요한지를 AI 판단에 맡길지. false면 leadDays로 확정
//   stepTemplate : 준비 단계 템플릿 종류
const DEFAULT_CATEGORIES = [
  { key: '학사일정', label: '학사일정', hue: 178, leadDays: 2, aiDecides: true,  stepTemplate: 'school'  },
  { key: '과제',     label: '과제',     hue: 205, leadDays: 3, aiDecides: false, stepTemplate: 'writing' },
  { key: '시험',     label: '시험',     hue: 268, leadDays: 7, aiDecides: false, stepTemplate: 'exam'    },
  { key: '행사',     label: '행사',     hue: 34,  leadDays: 0, aiDecides: false, stepTemplate: 'generic' },
  { key: '회의',     label: '회의',     hue: 332, leadDays: 0, aiDecides: false, stepTemplate: 'generic' },
  { key: '기타',     label: '기타',     hue: 142, leadDays: 1, aiDecides: true,  stepTemplate: 'generic' },
];

const FALLBACK_KEY = '기타'; // 분류에 실패했을 때 떨어지는 종류. 항상 존재해야 한다.

// 종류 하나의 설정에서 리드타임 규칙을 만든다.
// 허용 범위(min~max)는 기본 준비일수에서 계산한다 — 종류마다 손으로 범위를 적게 하면
// 사용자가 종류를 추가할 때마다 답해야 할 질문이 늘어나기 때문이다.
function ruleFromCategory(cat) {
  const leadDays = Math.max(0, Math.min(30, Math.round(Number(cat.leadDays) || 0)));
  if (leadDays === 0) {
    return { needsPrep: false, fallback: 0, min: 0, max: 0 };
  }
  return {
    needsPrep: cat.aiDecides ? null : true, // null = AI 판단을 따름
    fallback: leadDays,
    min: Math.max(1, Math.round(leadDays * 0.4)),
    max: Math.min(30, Math.max(leadDays * 2, leadDays + 7)),
  };
}

/** 요청으로 들어온 종류 목록(없으면 기본값)을 정규화한다. */
function normalizeCategories(categories) {
  if (!Array.isArray(categories) || categories.length === 0) return DEFAULT_CATEGORIES;
  const seen = new Set();
  const list = [];
  for (const raw of categories.slice(0, 10)) {
    const key = String((raw && raw.key) || '').trim().slice(0, 20);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    list.push({
      key,
      label: String((raw && raw.label) || key).trim().slice(0, 12) || key,
      leadDays: Math.max(0, Math.min(30, Math.round(Number(raw && raw.leadDays) || 0))),
      aiDecides: Boolean(raw && raw.aiDecides),
      stepTemplate: STEP_TEMPLATES[raw && raw.stepTemplate] ? raw.stepTemplate : 'generic',
    });
  }
  if (!list.length) return DEFAULT_CATEGORIES;
  // 분류 실패 시 떨어질 종류가 반드시 하나는 있어야 한다
  if (!list.some((c) => c.key === FALLBACK_KEY)) {
    list.push(DEFAULT_CATEGORIES[DEFAULT_CATEGORIES.length - 1]);
  }
  return list;
}

/** 종류 목록 → { key: rule } 규칙표 */
function buildRules(categories) {
  const rules = {};
  normalizeCategories(categories).forEach((c) => { rules[c.key] = ruleFromCategory(c); });
  return rules;
}

function getRule(category, rules) {
  const table = rules || buildRules(null);
  return table[category] || table[FALLBACK_KEY] || ruleFromCategory({ leadDays: 1, aiDecides: true });
}

/**
 * AI 초안 + 규칙표를 합쳐서 최종 리드타임을 결정한다.
 * @returns {{needsPrep:boolean, leadTimeDays:number, leadTimeSource:string}}
 *   leadTimeSource: 'ai'(AI 값 그대로) | 'rule'(규칙표 기본값) | 'rule-corrected'(AI 값을 범위로 보정) | 'user'(사용자 조정)
 */
function resolveLeadTime({ category, needsPrep, suggestedLeadDays, rules }) {
  const rule = getRule(category, rules);

  // 1단계: 준비가 필요한 유형인지 판단 (규칙표가 확정한 카테고리는 AI 의견을 무시)
  const prepNeeded = rule.needsPrep === null ? Boolean(needsPrep) : rule.needsPrep;
  if (!prepNeeded) {
    return { needsPrep: false, leadTimeDays: 0, leadTimeSource: 'rule' };
  }

  // 2단계: 며칠인지 결정
  const raw = Number(suggestedLeadDays);
  let days;
  let source;
  if (Number.isFinite(raw) && raw > 0) {
    days = Math.round(raw);
    source = 'ai';
  } else {
    days = rule.fallback;
    source = 'rule';
  }

  // 3단계: 규칙표 범위 보정 (AI가 "수행평가 준비 90일" 같은 값을 내는 걸 막음)
  const clamped = Math.min(Math.max(days, rule.min), rule.max);
  if (clamped !== days) {
    days = clamped;
    source = 'rule-corrected';
  }

  if (days <= 0) {
    return { needsPrep: false, leadTimeDays: 0, leadTimeSource: source };
  }
  return { needsPrep: true, leadTimeDays: days, leadTimeSource: source };
}

/** 사용자가 확인 화면에서 직접 고른 값을 규칙표 범위 안으로만 가둬서 받아준다. */
function resolveUserLeadTime({ category, leadTimeDays, rules }) {
  const rule = getRule(category, rules);
  const raw = Number(leadTimeDays);
  if (!Number.isFinite(raw) || raw <= 0) {
    return { needsPrep: false, leadTimeDays: 0, leadTimeSource: 'user' };
  }
  // 사용자 판단은 존중하되, 규칙표 최대치의 2배까지만 허용 (오타로 300일 같은 값이 들어오는 것 방지)
  const hardMax = Math.max(rule.max * 2, 30);
  return {
    needsPrep: true,
    leadTimeDays: Math.min(Math.round(raw), hardMax),
    leadTimeSource: 'user',
  };
}

// ---------- 준비 단계 템플릿 (기획서 8.9) ----------
const STEP_TEMPLATES = {
  presentation: ['자료조사', '초안 작성', '리허설', '최종 점검'],
  writing:      ['자료조사', '개요 잡기', '본문 작성', '퇴고·제출'],
  exam:         ['시험 범위 정리', '1차 복습', '오답노트', '최종 점검'],
  school:       ['안내문 확인', '준비물 챙기기', '최종 확인'],
  generic:      ['내용 확인', '준비하기', '마무리'],
};

// 제목에 발표 성격이 보이면 카테고리보다 제목을 우선한다.
// (같은 '과제'라도 발표형과 논술형은 준비 단계가 다르다 — 기획서 8.9)
const PRESENTATION_HINT = /발표|프레젠테이션|피피티|ppt|피티|스피치/i;

// 어떤 템플릿을 골랐는지를 키 문자열로 돌려준다.
// 사용자가 단계를 고쳤을 때 "무엇에 대해 고친 것인지"를 기억하는 단위가 이 키다.
// 카테고리(과제)가 아니라 템플릿 종류(발표형/논술형)로 기억해야
// "발표 수행평가"에서 고친 구성이 "독후감"에 잘못 적용되지 않는다.
// 종류마다 어떤 단계 템플릿을 쓸지는 종류 설정(stepTemplate)에 들어있다.
// 다만 제목에 발표 성격이 보이면 종류 설정보다 제목을 우선한다
// (같은 '과제'라도 발표형과 논술형은 준비 단계가 다르기 때문 — 기획서 8.9).
function pickStepTemplateKey(category, title = '', categories) {
  if (PRESENTATION_HINT.test(title)) return 'presentation';
  const found = normalizeCategories(categories).find((c) => c.key === category);
  return (found && STEP_TEMPLATES[found.stepTemplate]) ? found.stepTemplate : 'generic';
}

const STEP_TEMPLATE_LABELS = {
  presentation: '발표형',
  writing: '작성형',
  exam: '시험형',
  school: '학사형',
  generic: '일반',
};

function pickStepTemplate(category, title = '', categories) {
  return STEP_TEMPLATES[pickStepTemplateKey(category, title, categories)];
}

// 사용자가 보낸 단계 제목 배열을 안전하게 정리한다 (빈 값 제거, 개수·길이 제한)
function sanitizeStepTitles(titles) {
  if (!Array.isArray(titles)) return null;
  const clean = titles
    .map((t) => String(t ?? '').trim().slice(0, 30))
    .filter(Boolean)
    .slice(0, 8);
  return clean.length ? clean : null;
}

/**
 * 단계 제목 배열에 "언제까지 하면 좋은지" 계획 날짜를 배분한다.
 * 첫 단계는 준비 시작일, 마지막 단계는 마감일에 놓이고 나머지는 그 사이에 균등 배치된다.
 */
function distributeSteps(titles, startDate, endDate) {
  const span = Math.max(0, diffDays(startDate, endDate));
  const last = titles.length - 1;
  return titles.map((stepTitle, i) => ({
    title: stepTitle,
    plannedDate: last <= 0 ? endDate : addDays(startDate, Math.round((span * i) / last)),
    done: false,
    doneAt: null,
  }));
}

/**
 * 준비기간을 단계로 쪼갠다.
 * customTitles가 있으면(= 사용자가 예전에 고쳐둔 구성이 있으면) 표준 템플릿 대신 그걸 쓴다.
 */
function buildSteps(category, title, startDate, endDate, customTitles, categories) {
  const titles = sanitizeStepTitles(customTitles) || pickStepTemplate(category, title, categories);
  return distributeSteps(titles, startDate, endDate);
}

/**
 * 일정에 준비기간을 실제로 적용한다. 이 함수가 "막대가 어디서부터 시작하는가"를 정한다.
 *
 * 기획서 8.4는 `startDate = endDate - leadTimeDays`로 적혀 있지만, 실제로는
 * **일정 시작일** 기준으로 빼는 게 맞다. 예를 들어 "기말고사 7/27~7/31"에 7일을 붙일 때
 * endDate(7/31) 기준이면 7/24가 되어 시험 기간 한복판에서 준비를 시작하는 꼴이 된다.
 * 하루짜리 마감(startDate === endDate)일 때는 두 계산이 같은 값이 되므로,
 * 기획서의 의도를 지키면서 기간형 일정까지 맞게 처리된다.
 */
function applyLeadTime(event, lead, category, options = {}) {
  const anchor = event.originalStartDate || event.startDate; // 리드타임 적용 전 원래 시작일
  const endDate = event.endDate || anchor;

  if (!lead.needsPrep || lead.leadTimeDays <= 0) {
    return {
      ...event,
      startDate: anchor,
      endDate,
      originalStartDate: anchor,
      needsPrep: false,
      leadTimeDays: 0,
      leadTimeSource: lead.leadTimeSource || 'rule',
      stepTemplateKey: '',
      steps: [],
    };
  }

  let startDate = addDays(anchor, -lead.leadTimeDays);

  // 이미 지나간 날부터 준비를 시작할 수는 없으니, 마감이 아직 안 지났으면 오늘로 당긴다.
  // (준비 기간이 원래보다 짧아진 건 브리핑에서 "부담"으로 잡히므로 정보가 사라지지는 않는다)
  const today = todayIso();
  if (startDate < today && today <= endDate) {
    startDate = today;
  }

  return {
    ...event,
    startDate,
    endDate,
    originalStartDate: anchor,
    needsPrep: true,
    leadTimeDays: lead.leadTimeDays,
    leadTimeSource: lead.leadTimeSource || 'rule',
    stepTemplateKey: pickStepTemplateKey(category, event.title || '', options.categories),
    steps: buildSteps(category, event.title || '', startDate, endDate, options.stepTitles, options.categories),
  };
}

/** 단계 완료 비율(0~1). steps가 없으면 0. */
function calcProgress(steps) {
  if (!steps || steps.length === 0) return 0;
  return steps.filter((s) => s.done).length / steps.length;
}

module.exports = {
  todayIso,
  addDays,
  diffDays,
  DEFAULT_CATEGORIES,
  FALLBACK_KEY,
  normalizeCategories,
  buildRules,
  getRule,
  resolveLeadTime,
  resolveUserLeadTime,
  pickStepTemplate,
  pickStepTemplateKey,
  STEP_TEMPLATE_LABELS,
  sanitizeStepTitles,
  distributeSteps,
  buildSteps,
  applyLeadTime,
  calcProgress,
};
