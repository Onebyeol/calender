// ============================================================
// 심사/시연용 계정의 샘플 데이터
// ------------------------------------------------------------
// 날짜를 하드코딩하지 않고 "오늘로부터 며칠"로 적어둔다.
// 심사가 언제 이뤄지든 항상 D-3, 오늘 시작, 마감 지남 같은 상태가 그대로 재현되게 하기 위함이다.
// (하드코딩했다면 대회 심사일에는 전부 과거 일정이 되어 화면이 텅 비어 보인다)
//
// 심는 시점: 데모 계정으로 로그인할 때, 아래 둘 중 하나면 다시 심는다.
//   1) 일정이 하나도 없음 (첫 로그인이거나 심사위원이 전부 지웠음)
//   2) 마지막으로 심은 날짜가 오늘이 아님 (날짜 기준이 밀렸음)
// 같은 날 안에서는 다시 심지 않으므로, 심사위원이 시연 중에 만든 일정은 사라지지 않는다.
// ============================================================

const Notice = require('../models/Notice');
const ScheduleEvent = require('../models/ScheduleEvent');
const Todo = require('../models/Todo');
const { todayIso, addDays, pickStepTemplate, pickStepTemplateKey, distributeSteps } = require('./leadTimeService');

// prepStart / eventStart / end 는 모두 "오늘로부터 며칠 뒤"(음수면 과거)
const DEMO_EVENTS = [
  {
    title: '2학기 중간고사',
    category: '시험',
    priority: 'high',
    prepStart: -3, eventStart: 11, end: 13,
    leadTimeDays: 14,
    doneSteps: 1,
    aiSummary: '10월 중간고사 시간표 안내. 국어·수학·영어·과학 4과목이며 시험 범위는 교과서 전 범위입니다.',
    source: '[학사공지] 2학기 중간고사 시행 안내\n\n일시: 시험 첫날 08:40 ~ 셋째날 12:30\n대상: 1~3학년 전교생\n과목: 국어, 수학, 영어, 통합과학\n범위: 교과서 전 범위 및 수업자료\n※ 시험 기간 중 단축수업 실시',
  },
  {
    title: '국어 수행평가 발표 자료 제출',
    category: '과제',
    priority: 'high',
    prepStart: 0, eventStart: 5, end: 5,
    leadTimeDays: 5,
    doneSteps: 0,
    aiSummary: '문학 작품 한 편을 골라 5분 발표 자료를 만들어 제출하는 수행평가입니다. 오늘부터 준비를 시작하면 마감에 맞출 수 있어요.',
    source: '[국어과] 2학기 수행평가 안내\n\n주제: 문학 작품 비평 발표\n분량: 5분 내외 발표 + PPT 5장 이상\n제출: 학급 게시판 업로드\n마감: 다음 주 금요일 23:59까지\n※ 지각 제출 시 감점',
  },
  {
    title: '과학탐구 보고서 제출',
    category: '과제',
    priority: 'medium',
    prepStart: 2, eventStart: 9, end: 9,
    leadTimeDays: 7,
    doneSteps: 0,
    aiSummary: '자유 주제 과학탐구 보고서를 A4 3장 이상으로 작성해 제출합니다.',
    source: '[과학과] 과학탐구 보고서 제출 안내\n\n주제: 자유 (생활 속 과학 현상 권장)\n분량: A4 3장 이상, 참고문헌 표기 필수\n제출처: 과학실 앞 제출함\n마감: 다다음 주 화요일까지',
  },
  {
    title: '동아리 발표회',
    category: '행사',
    priority: 'medium',
    prepStart: 6, eventStart: 6, end: 6,
    leadTimeDays: 0,
    doneSteps: 0,
    aiSummary: '',
    source: '',
  },
  {
    title: '학부모 상담 주간',
    category: '학사일정',
    priority: 'low',
    prepStart: 3, eventStart: 5, end: 6,
    leadTimeDays: 2,
    doneSteps: 0,
    aiSummary: '학부모 상담 주간 안내. 신청서를 미리 제출해야 합니다.',
    source: '[가정통신문] 학부모 상담 주간 운영 안내\n\n기간: 다음 주 목요일 ~ 금요일\n방법: 담임교사와 사전 예약 후 방문 또는 전화 상담\n신청: 가정통신문 회신서 제출\n문의: 담임교사',
  },
  {
    // 마감이 지났고 회고를 아직 안 한 일정 — "마감 후 회고"(기획서 8.10) 화면을 보여주기 위한 항목
    title: '영어 단어시험',
    category: '시험',
    priority: 'medium',
    prepStart: -6, eventStart: -2, end: -2,
    leadTimeDays: 4,
    doneSteps: 4,
    aiSummary: '영어 단어시험 범위 안내. Unit 5~8, 총 120단어입니다.',
    source: '[영어과] 단어시험 안내\n\n범위: Unit 5 ~ Unit 8 (총 120단어)\n일시: 지난 주 수요일 1교시\n형식: 영영풀이 20문항\n※ 70점 미만은 재시험',
  },
];

// due 도 "오늘로부터 며칠"
const DEMO_TODOS = [
  { title: '발표 주제로 쓸 문학 작품 고르기', due: 0, done: false },
  { title: '중간고사 시험범위 정리해두기', due: 1, done: false },
  { title: '과학탐구 주제 후보 3개 적어보기', due: 2, done: false },
  { title: '영어 단어장 3회독', due: -2, done: true },
];

/** 데모 계정이 소유한 기존 데이터를 전부 지운다 (게스트/다른 사용자 데이터는 건드리지 않음) */
async function clearDemoData(userId) {
  await Promise.all([
    ScheduleEvent.deleteMany({ user: userId }),
    Todo.deleteMany({ user: userId }),
    Notice.deleteMany({ user: userId }),
  ]);
}

async function insertDemoData(userId) {
  const today = todayIso();

  for (const spec of DEMO_EVENTS) {
    const startDate = addDays(today, spec.prepStart);
    const endDate = addDays(today, spec.end);
    const originalStartDate = addDays(today, spec.eventStart);
    const needsPrep = spec.leadTimeDays > 0;

    let noticeId = null;
    if (spec.source) {
      const notice = await Notice.create({
        user: userId,
        sourceType: 'text',
        rawContent: spec.source,
        summary: spec.aiSummary,
        priority: spec.priority,
        category: spec.category,
        needsPrep,
        leadTimeDays: spec.leadTimeDays,
      });
      noticeId = notice._id;
    }

    // 단계 제목과 계획 날짜는 실제 앱과 똑같은 함수로 만든다 (샘플만 다르게 보이면 의미가 없다)
    let steps = [];
    if (needsPrep) {
      const titles = pickStepTemplate(spec.category, spec.title);
      steps = distributeSteps(titles, startDate, endDate);
      // 앞에서부터 doneSteps개를 완료 처리해서 "준비가 진행 중인" 상태를 만든다
      for (let i = 0; i < Math.min(spec.doneSteps, steps.length); i++) {
        steps[i].done = true;
        // 계획일에 체크한 것으로 둔다 (회고 화면의 "실제 준비 시작일" 계산에 쓰임)
        steps[i].doneAt = new Date(`${steps[i].plannedDate}T09:00:00+09:00`);
      }
    }

    await ScheduleEvent.create({
      user: userId,
      noticeId,
      title: spec.title,
      startDate,
      endDate,
      originalStartDate,
      start: '09:00',
      end: '10:00',
      alarm: true,
      notify: true,
      priority: spec.priority,
      category: spec.category,
      aiSummary: spec.aiSummary,
      sourceType: spec.source ? 'text' : 'manual',
      sourceContent: spec.source,
      needsPrep,
      leadTimeDays: spec.leadTimeDays,
      // 이 값이 규칙표에서 나왔다는 표시. 발표 때 "AI 값 / 규칙 보정 값"을 구분해 설명하기 위함.
      leadTimeSource: needsPrep ? 'rule' : '',
      stepTemplateKey: needsPrep ? pickStepTemplateKey(spec.category, spec.title) : '',
      steps,
    });
  }

  await Todo.insertMany(
    DEMO_TODOS.map((td) => ({
      user: userId,
      title: td.title,
      due: addDays(today, td.due),
      done: td.done,
    }))
  );
}

/**
 * 데모 계정에 샘플 데이터가 준비돼 있는지 확인하고, 필요하면 다시 심는다.
 * @returns {Promise<boolean>} 실제로 다시 심었으면 true
 */
async function ensureDemoData(user) {
  if (!user.isDemo) return false;

  const today = todayIso();
  const eventCount = await ScheduleEvent.countDocuments({ user: user._id });
  const needsReseed = eventCount === 0 || user.demoSeededOn !== today;
  if (!needsReseed) return false;

  await clearDemoData(user._id);
  await insertDemoData(user._id);

  user.demoSeededOn = today;
  await user.save();
  return true;
}

module.exports = { ensureDemoData };
