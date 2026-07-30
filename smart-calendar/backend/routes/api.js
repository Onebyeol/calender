const express = require('express');
const multer = require('multer');

const Notice = require('../models/Notice');
const ScheduleEvent = require('../models/ScheduleEvent');
const Todo = require('../models/Todo');
const { analyzeTextNotice, analyzeImageNotice } = require('../services/geminiService');
const { sendPushToUser } = require('../services/pushService');
const { ownerScope } = require('../middleware/auth');
const {
  todayIso,
  diffDays,
  resolveLeadTime,
  resolveUserLeadTime,
  applyLeadTime,
  calcProgress,
  distributeSteps,
  normalizeCategories,
  buildRules,
  FALLBACK_KEY,
} = require('../services/leadTimeService');

// 요청에 실려온 "일정 종류 설정"을 한 번에 풀어놓는다.
// 종류는 사용자가 추가/삭제/이름변경할 수 있으므로 개수가 고정돼 있지 않다.
//   labels : Gemini 프롬프트에 넣을 분류 후보 이름들 (개수가 그때그때 다름)
//   toKey  : AI가 돌려준 이름(사용자 라벨)을 내부 키로 되돌리는 함수
//   rules  : 종류별 리드타임 규칙표
// 설정을 안 보내는 경로(iOS 단축어 등)는 기본 6종으로 자동 대체된다.
function categoryContext(categories) {
  const list = normalizeCategories(categories);
  const toKey = new Map();
  list.forEach((c) => { toKey.set(c.label, c.key); toKey.set(c.key, c.key); });
  const fallback = list.some((c) => c.key === FALLBACK_KEY) ? FALLBACK_KEY : list[list.length - 1].key;
  return {
    list,
    labels: list.map((c) => c.label),
    rules: buildRules(list),
    toKey: (v) => toKey.get(String(v ?? '').trim()) || fallback,
  };
}

const router = express.Router();

// ---------- 로그인 필수 ----------
// 이 라우터의 모든 경로는 로그인한 사용자만 쓸 수 있다.
// (회원가입/로그인은 /api/auth 라우터라 이 검사에 걸리지 않는다)
//
// 예전에는 토큰이 없으면 "게스트 데이터"를 다루게 해뒀지만,
// 로그인하지 않은 사람에게 남이 만든 일정이 그대로 보이는 문제가 있어서 막았다.
router.use((req, res, next) => {
  if (req.userId) return next();

  // 공유 시트로 들어온 요청은 JSON 401을 띄워봐야 사용자가 볼 수 없다.
  // 앱으로 돌려보내면서 무엇을 해야 하는지 토스트로 알려준다.
  if (req.path.startsWith('/notices/share-')) {
    return sendShareOutcome(req, res, 'error', '앱에서 먼저 로그인해주세요. 로그인한 뒤 다시 공유하면 자동으로 등록돼요.');
  }
  return res.status(401).json({ error: '로그인이 필요함' });
});

// 이미지는 메모리에만 잠깐 올렸다가 base64로 바로 Gemini에 넘기고 버림 (디스크 저장 안 함)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 8 * 1024 * 1024, // 파일당 8MB
    files: 4,
    fields: 10,
  },
});

// 일정이 하나 생성될 때마다 호출: 즉시 등록 알림 1번 + (테스트용) 1분 뒤 알람 1번을 푸시로 보냄
// 알림은 그 일정을 만든 사용자의 기기에만 간다 (event.user가 null이면 게스트 기기들).
function notifyEventCreated(event) {
  // 사용자가 이 일정의 알림을 꺼두면 아무것도 보내지 않는다
  if (!event.notify) return;

  // 준비기간이 붙은 일정은 마감일이 아니라 "언제부터 시작하면 되는지"를 알려준다 (기획서의 핵심 메시지)
  const body = event.needsPrep
    ? `"${event.title}" — ${event.startDate}부터 준비 시작하면 돼요. (마감 ${event.endDate})`
    : `"${event.title}" 일정이 캘린더에 추가됐어요.`;

  sendPushToUser(event.user, {
    title: event.needsPrep ? '준비 시작일을 잡았어요' : '일정이 등록됐어요',
    body,
  }).catch((err) => console.error('[push] 등록 알림 실패:', err.message));

  setTimeout(() => {
    sendPushToUser(event.user, {
      title: '⏰ 테스트 알람',
      body: `"${event.title}" 일정 알림이에요!`,
    }).catch((err) => console.error('[push] 테스트 알람 실패:', err.message));
  }, 60 * 1000);
}

// AI 분석 결과에서 프론트가 바로 쓸 수 있게 대표 이벤트/할일 1개씩만 뽑아서 정리
// + 준비기간(리드타임)을 역산해서 startDate를 앞으로 당기고 단계 체크리스트를 만든다 (기획서 8.4)
function shapeParsed(parsed, ctx) {
  const context = ctx || categoryContext(null);
  const event = (parsed.scheduleItems || [])[0];
  const todo = (parsed.todoItems || [])[0];
  const priority = parsed.priority || 'medium';
  const category = parsed.category || FALLBACK_KEY;

  // AI가 낸 needsPrep/suggestedLeadDays 초안을 종류별 규칙표로 보정한 최종값
  const lead = resolveLeadTime({
    category,
    needsPrep: parsed.needsPrep,
    suggestedLeadDays: parsed.suggestedLeadDays,
    rules: context.rules,
  });

  let shapedEvent = event
    ? {
        title: event.title,
        startDate: event.startDate,
        endDate: event.endDate || event.startDate,
        start: event.startTime || '09:00',
        end: event.endTime || '10:00',
      }
    : null;

  // 준비기간을 실제로 적용 (needsPrep이 false면 startDate는 그대로 유지됨)
  if (shapedEvent) {
    shapedEvent = applyLeadTime(shapedEvent, lead, category, { categories: context.list });
  }

  let shapedTodo = todo ? { title: todo.title, due: todo.due || (event ? event.startDate : '') } : null;

  // 안전장치: 중요도가 high인데 AI가 todo를 안 만들었으면 여기서 자동으로 하나 만들어줌
  // (오늘 처리해야 할 일이 없다는 건 말이 안 되니까)
  if (!shapedTodo && priority === 'high') {
    shapedTodo = {
      title: shapedEvent ? `${shapedEvent.title} 처리하기` : `${category} 확인하기`,
      // 준비기간이 붙은 일정이면 "마감일"이 아니라 "준비 시작일"이 오늘 해야 할 일의 기준이 된다
      due: shapedEvent ? shapedEvent.startDate : todayIso(),
    };
  }

  return {
    summary: parsed.summary || '',
    priority,
    category,
    event: shapedEvent,
    todo: shapedTodo,
    // 확인 화면에서 리드타임을 보여주고 조정하게 하려면 이벤트 밖에도 값이 필요함
    needsPrep: lead.needsPrep,
    leadTimeDays: lead.leadTimeDays,
    leadTimeSource: lead.leadTimeSource,
  };
}

// 확인(저장) 단계에서 사용자가 조정한 리드타임을 반영해 일정 필드를 다시 계산한다.
// 계산 로직을 서버 한 곳에만 두려고, 프론트는 leadTimeDays 값만 보내고 날짜 계산은 여기서 한다.
function buildEventFields(addEvent, category, priority, ctx) {
  const context = ctx || categoryContext(null);
  const base = {
    title: addEvent.title,
    startDate: addEvent.startDate,
    endDate: addEvent.endDate || addEvent.startDate,
    start: addEvent.start || '09:00',
    end: addEvent.end || '10:00',
    // 사용자가 준비기간을 늘렸다 줄였다 해도 항상 원래 마감 기준으로 다시 계산되도록
    originalStartDate: addEvent.originalStartDate || addEvent.startDate,
  };

  const lead = addEvent.leadTimeDays !== undefined
    ? resolveUserLeadTime({ category, leadTimeDays: addEvent.leadTimeDays, rules: context.rules })
    : resolveLeadTime({ category, needsPrep: addEvent.needsPrep, suggestedLeadDays: addEvent.leadTimeDays, rules: context.rules });

  // 사용자가 예전에 고쳐둔 단계 구성을 프론트가 같이 보내오면 표준 템플릿 대신 그걸 쓴다
  return applyLeadTime(base, lead, category, { stepTitles: addEvent.stepTitles, categories: context.list });
}

// ---------- 1단계: 분석만 하고 저장은 안 함 (미리보기) ----------

router.post('/notices/analyze-text', async (req, res) => {
  try {
    const { text } = req.body;
    if (!text || !text.trim()) {
      return res.status(400).json({ error: '공지 텍스트가 비어있음' });
    }

    const ctx = categoryContext(req.body.categories);
    const { parsed, rawContent } = await analyzeTextNotice(text.trim(), ctx.labels);
    // AI는 사용자가 지은 이름으로 답하므로 내부 키로 되돌린다
    parsed.category = ctx.toKey(parsed.category);
    res.json({ sourceType: 'text', rawContent, result: shapeParsed(parsed, ctx) });
  } catch (err) {
    console.error('[POST /notices/analyze-text]', err);
    res.status(500).json({ error: '공지 분석 중 오류 발생', detail: err.message });
  }
});

router.post('/notices/analyze-image', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: '이미지 파일이 없음' });
    }
    const base64Image = req.file.buffer.toString('base64');
    // multipart라 categories가 JSON 문자열로 들어온다
    let categories = null;
    try { categories = req.body.categories ? JSON.parse(req.body.categories) : null; } catch (e) { categories = null; }
    const ctx = categoryContext(categories);
    const { parsed, rawContent } = await analyzeImageNotice(base64Image, req.file.mimetype, ctx.labels);
    parsed.category = ctx.toKey(parsed.category);
    res.json({ sourceType: 'image', rawContent, result: shapeParsed(parsed, ctx) });
  } catch (err) {
    console.error('[POST /notices/analyze-image]', err);
    res.status(500).json({ error: '이미지 분석 중 오류 발생', detail: err.message });
  }
});

// ---------- 2단계: 사용자가 "캘린더에 추가"/"할일에 추가" 눌렀을 때만 저장 ----------
// addEvent/addTodo 중 원하는 것만 body에 담아 보내면 그것만 저장됨

router.post('/notices/confirm', async (req, res) => {
  try {
    const { sourceType, rawContent, summary, priority, category, addEvent, addTodo } = req.body;
    if (!sourceType || !rawContent) {
      return res.status(400).json({ error: 'sourceType/rawContent가 필요함' });
    }

    const ctx = categoryContext(req.body.categories);
    const cat = category || FALLBACK_KEY;
    // 사용자가 확인 화면에서 조정했을 수 있으므로 여기서 준비기간을 최종 계산한다
    const eventFields = addEvent ? buildEventFields(addEvent, cat, priority, ctx) : null;

    const notice = await Notice.create({
      user: req.userId,
      sourceType,
      rawContent,
      summary: summary || '',
      priority: priority || 'medium',
      category: cat,
      needsPrep: eventFields ? eventFields.needsPrep : false,
      leadTimeDays: eventFields ? eventFields.leadTimeDays : 0,
    });

    let savedEvent = null;
    let savedTodo = null;

    if (eventFields) {
      savedEvent = await ScheduleEvent.create({
        user: req.userId,
        noticeId: notice._id,
        ...eventFields,
        category: cat,
        notify: true,
        priority: priority || 'medium',
        aiSummary: summary || '',
        sourceType,
        sourceContent: rawContent,
      });
      notifyEventCreated(savedEvent);
    }

    if (addTodo) {
      savedTodo = await Todo.create({
        user: req.userId,
        noticeId: notice._id,
        title: addTodo.title,
        due: addTodo.due,
        done: false,
      });
    }

    res.status(201).json({ notice, event: savedEvent, todo: savedTodo });
  } catch (err) {
    console.error('[POST /notices/confirm]', err);
    res.status(500).json({ error: '저장 중 오류 발생', detail: err.message });
  }
});

// ---------- 일정(캘린더) CRUD ----------

// 전체 일정 조회 (캘린더 월 그리드 + 알림 탭 그룹핑에 사용, 클라이언트에서 월별 필터링)
router.get('/schedule', async (req, res) => {
  try {
    const events = await ScheduleEvent.find(ownerScope(req)).sort({ startDate: 1, start: 1 });
    res.json(events);
  } catch (err) {
    console.error('[GET /schedule]', err);
    res.status(500).json({ error: '일정 조회 오류', detail: err.message });
  }
});

// 수동으로 일정 추가 (+ 버튼)
// 수동 추가에도 준비기간을 붙일 수 있게 leadTimeDays를 받는다 (안 보내면 예전처럼 단일 일정)
router.post('/schedule', async (req, res) => {
  try {
    const { title, startDate, endDate, start, end, notify, priority, leadTimeDays, category } = req.body;
    if (!title || !startDate) {
      return res.status(400).json({ error: 'title/startDate가 필요함' });
    }
    const ctx = categoryContext(req.body.categories);
    const cat = category || FALLBACK_KEY;
    const lead = resolveUserLeadTime({ category: cat, leadTimeDays, rules: ctx.rules });
    const fields = applyLeadTime(
      { title, startDate, endDate: endDate || startDate, start: start || '09:00', end: end || '10:00' },
      lead,
      cat,
      { categories: ctx.list }
    );

    const event = await ScheduleEvent.create({
      user: req.userId,
      ...fields,
      category: cat,
      notify: notify !== undefined ? notify : true,
      priority: priority || 'medium',
      sourceType: 'manual',
    });
    notifyEventCreated(event);
    res.status(201).json(event);
  } catch (err) {
    console.error('[POST /schedule]', err);
    res.status(500).json({ error: '일정 추가 오류', detail: err.message });
  }
});

// 일정 수정
// leadTimeDays가 들어오면 원래 마감 기준으로 startDate와 단계 계획일을 다시 계산한다
router.patch('/schedule/:id', async (req, res) => {
  try {
    // 남의 일정을 id만 알아내서 수정하지 못하도록 소유자 조건을 항상 함께 건다
    const event = await ScheduleEvent.findOne({ _id: req.params.id, ...ownerScope(req) });
    if (!event) return res.status(404).json({ error: '일정을 찾을 수 없음' });

    const fields = ['title', 'startDate', 'endDate', 'start', 'end', 'notify', 'priority'];
    fields.forEach((f) => {
      if (req.body[f] !== undefined) event[f] = req.body[f];
    });

    if (req.body.leadTimeDays !== undefined) {
      const ctx = categoryContext(req.body.categories);
      const cat = req.body.category || event.category || FALLBACK_KEY;
      const lead = resolveUserLeadTime({ category: cat, leadTimeDays: req.body.leadTimeDays, rules: ctx.rules });
      // 사용자가 시작 날짜를 직접 고쳤다면 그 값을 새 기준일로 삼는다
      const anchor = req.body.startDate !== undefined
        ? req.body.startDate
        : (event.originalStartDate || event.startDate);
      // 사용자가 단계를 직접 고쳐뒀을 수 있으므로, 기간만 다시 잡고 단계 제목은 그대로 가져간다
      const recalced = applyLeadTime(
        { title: event.title, startDate: anchor, endDate: event.endDate, originalStartDate: anchor },
        lead,
        cat,
        { stepTitles: event.steps.map((s) => s.title), categories: ctx.list }
      );
      event.startDate = recalced.startDate;
      event.originalStartDate = recalced.originalStartDate;
      event.needsPrep = recalced.needsPrep;
      event.leadTimeDays = recalced.leadTimeDays;
      event.leadTimeSource = recalced.leadTimeSource;
      // 이미 체크해둔 단계가 있으면 완료 상태는 살리고 계획 날짜만 새로 배분한다
      if (recalced.steps.length && event.steps.length === recalced.steps.length) {
        recalced.steps.forEach((s, i) => {
          s.done = event.steps[i].done;
          s.doneAt = event.steps[i].doneAt;
        });
      }
      event.steps = recalced.steps;
    }

    await event.save();
    res.json(event);
  } catch (err) {
    console.error('[PATCH /schedule/:id]', err);
    res.status(500).json({ error: '일정 수정 오류', detail: err.message });
  }
});

// ---------- 준비 단계 체크리스트 (기획서 8.9) ----------
// Todo의 완료 토글과 같은 패턴. 인덱스로 단계 하나를 뒤집는다.
router.patch('/schedule/:id/steps/:index', async (req, res) => {
  try {
    // 남의 일정을 id만 알아내서 수정하지 못하도록 소유자 조건을 항상 함께 건다
    const event = await ScheduleEvent.findOne({ _id: req.params.id, ...ownerScope(req) });
    if (!event) return res.status(404).json({ error: '일정을 찾을 수 없음' });

    const idx = Number(req.params.index);
    if (!Number.isInteger(idx) || idx < 0 || idx >= event.steps.length) {
      return res.status(400).json({ error: '단계 번호가 올바르지 않음' });
    }

    const step = event.steps[idx];
    step.done = !step.done;
    step.doneAt = step.done ? new Date() : null;
    await event.save();

    res.json(event);
  } catch (err) {
    console.error('[PATCH /schedule/:id/steps/:index]', err);
    res.status(500).json({ error: '단계 업데이트 오류', detail: err.message });
  }
});

// ---------- 준비 단계 구성 자체를 바꾸기 (이름 수정 / 추가 / 삭제 / 순서 변경) ----------
// 단계 목록 전체를 받아서 통째로 교체하고, 계획 날짜는 새 개수에 맞춰 다시 배분한다.
// 완료 상태는 "제목이 그대로 남아있는 단계"만 유지한다(이름을 바꾸면 새 단계로 본다).
router.put('/schedule/:id/steps', async (req, res) => {
  try {
    // 남의 일정을 id만 알아내서 수정하지 못하도록 소유자 조건을 항상 함께 건다
    const event = await ScheduleEvent.findOne({ _id: req.params.id, ...ownerScope(req) });
    if (!event) return res.status(404).json({ error: '일정을 찾을 수 없음' });

    const incoming = Array.isArray(req.body.steps) ? req.body.steps : [];
    const cleaned = incoming
      .map((s) => ({ title: String(s?.title ?? '').trim().slice(0, 30), done: !!s?.done }))
      .filter((s) => s.title)
      .slice(0, 8);

    if (cleaned.length === 0) {
      return res.status(400).json({ error: '단계는 최소 1개 이상이어야 함' });
    }

    const prevByTitle = new Map(event.steps.map((s) => [s.title, s]));
    const rebuilt = distributeSteps(cleaned.map((s) => s.title), event.startDate, event.endDate);
    rebuilt.forEach((step, i) => {
      if (!cleaned[i].done) return;
      step.done = true;
      const prev = prevByTitle.get(step.title);
      step.doneAt = prev && prev.doneAt ? prev.doneAt : new Date();
    });

    event.steps = rebuilt;
    await event.save();
    res.json(event);
  } catch (err) {
    console.error('[PUT /schedule/:id/steps]', err);
    res.status(500).json({ error: '단계 구성 저장 오류', detail: err.message });
  }
});

// ---------- 마감 후 회고 (기획서 8.10) ----------
// 계획된 시작일과 실제로 첫 단계를 체크한 날을 비교해서 "얼마나 늦게 시작했는지"를 같이 돌려준다.
router.post('/schedule/:id/retro', async (req, res) => {
  try {
    const { feeling } = req.body;
    if (!['tight', 'ok', 'loose'].includes(feeling)) {
      return res.status(400).json({ error: 'feeling은 tight/ok/loose 중 하나여야 함' });
    }

    // 남의 일정을 id만 알아내서 수정하지 못하도록 소유자 조건을 항상 함께 건다
    const event = await ScheduleEvent.findOne({ _id: req.params.id, ...ownerScope(req) });
    if (!event) return res.status(404).json({ error: '일정을 찾을 수 없음' });

    // 실제 준비 시작일 = 가장 먼저 체크한 단계의 완료 시각
    const doneSteps = event.steps.filter((s) => s.done && s.doneAt);
    let actualLeadDays = null;
    if (doneSteps.length) {
      const firstDone = doneSteps.reduce((a, b) => (a.doneAt < b.doneAt ? a : b));
      const kst = new Date(firstDone.doneAt.getTime() + 9 * 60 * 60 * 1000);
      const actualStart = `${kst.getUTCFullYear()}-${String(kst.getUTCMonth() + 1).padStart(2, '0')}-${String(kst.getUTCDate()).padStart(2, '0')}`;
      actualLeadDays = Math.max(0, diffDays(actualStart, event.endDate));
    }

    event.retro = { answeredAt: new Date(), feeling, actualLeadDays };
    await event.save();

    res.json({
      event,
      // 프론트가 다음 등록 기본값을 조정할 때 쓰는 힌트
      plannedLeadDays: event.leadTimeDays,
      actualLeadDays,
      delayDays: actualLeadDays === null ? null : event.leadTimeDays - actualLeadDays,
    });
  } catch (err) {
    console.error('[POST /schedule/:id/retro]', err);
    res.status(500).json({ error: '회고 저장 오류', detail: err.message });
  }
});

// 일정 삭제
router.delete('/schedule/:id', async (req, res) => {
  try {
    const event = await ScheduleEvent.findOneAndDelete({ _id: req.params.id, ...ownerScope(req) });
    if (!event) return res.status(404).json({ error: '일정을 찾을 수 없음' });
    res.json({ deleted: true });
  } catch (err) {
    console.error('[DELETE /schedule/:id]', err);
    res.status(500).json({ error: '일정 삭제 오류', detail: err.message });
  }
});

// ---------- 할일 ----------

router.get('/todos', async (req, res) => {
  try {
    const todos = await Todo.find(ownerScope(req)).sort({ done: 1, due: 1 });
    res.json(todos);
  } catch (err) {
    console.error('[GET /todos]', err);
    res.status(500).json({ error: '할일 조회 오류', detail: err.message });
  }
});

// 수동으로 할일 추가 (+ 버튼)
router.post('/todos', async (req, res) => {
  try {
    const { title, due } = req.body;
    if (!title || !due) {
      return res.status(400).json({ error: 'title/due가 필요함' });
    }
    const todo = await Todo.create({ user: req.userId, title, due, done: false });
    res.status(201).json(todo);
  } catch (err) {
    console.error('[POST /todos]', err);
    res.status(500).json({ error: '할일 추가 오류', detail: err.message });
  }
});

router.patch('/todos/:id', async (req, res) => {
  try {
    const todo = await Todo.findOne({ _id: req.params.id, ...ownerScope(req) });
    if (!todo) return res.status(404).json({ error: '할일을 찾을 수 없음' });
    todo.done = !todo.done;
    await todo.save();
    res.json(todo);
  } catch (err) {
    console.error('[PATCH /todos/:id]', err);
    res.status(500).json({ error: '할일 업데이트 오류', detail: err.message });
  }
});

// ---------- 일별 브리핑 (기획서 8.6 + 8.12) ----------
// 정렬을 "임박도" 한 축이 아니라 "임박도 + 부담" 두 축으로 계산한다.
//   임박도: 마감까지 남은 일수가 적을수록 높음
//   부담  : 남은 준비 분량(1 - 진행률)을 남은 일수로 나눈 값. 준비가 밀려 있을수록 높음
// 두 값 모두 이미 저장돼 있는 endDate / leadTimeDays / steps만으로 계산되므로 추가 입력이 없다.
function scoreEvent(ev, today) {
  const daysLeft = diffDays(today, ev.endDate);
  const progress = calcProgress(ev.steps);

  const urgency = Math.round(100 / (daysLeft + 1));
  const load = ev.needsPrep
    ? Math.round(((1 - progress) * ev.leadTimeDays * 30) / Math.max(1, daysLeft + 1))
    : 0;
  const priorityBonus = { high: 15, medium: 5, low: 0 }[ev.priority] ?? 5;

  // 화면에 "왜 위에 있는지"를 한 줄로 설명해주기 위한 문구
  let hint;
  if (daysLeft === 0) hint = '오늘 마감이에요';
  else if (daysLeft === 1) hint = '내일 마감이에요';
  else if (ev.needsPrep && progress === 0) hint = `아직 시작 전이에요 · D-${daysLeft}`;
  else if (ev.needsPrep && load >= urgency) hint = `준비가 밀렸어요 · D-${daysLeft}`;
  else hint = `D-${daysLeft}`;

  return {
    ...ev.toObject(),
    daysLeft,
    progress,
    urgency,
    load,
    score: urgency + load + priorityBonus,
    hint,
  };
}

router.get('/briefing', async (req, res) => {
  try {
    const today = req.query.date || todayIso();
    const [events, todos] = await Promise.all([
      ScheduleEvent.find(ownerScope(req)),
      Todo.find({ done: false, ...ownerScope(req) }),
    ]);

    // 오늘 신경 써야 하는 일정 = 준비 기간이나 일정 구간 안에 오늘이 들어있는 것
    const active = events
      .filter((ev) => ev.startDate <= today && today <= ev.endDate)
      .map((ev) => scoreEvent(ev, today))
      .sort((a, b) => b.score - a.score);

    // 아직 시작 전이지만 3일 안에 준비를 시작해야 하는 일정 (미리 알려주는 용도)
    const upcoming = events
      .filter((ev) => ev.startDate > today && diffDays(today, ev.startDate) <= 3)
      .map((ev) => ({ ...ev.toObject(), startsIn: diffDays(today, ev.startDate) }))
      .sort((a, b) => a.startsIn - b.startsIn);

    // 마감이 지났는데 회고를 아직 안 한 일정 (기획서 8.10)
    const retroPending = events
      .filter((ev) => ev.needsPrep && ev.endDate < today && !ev.retro?.answeredAt)
      .sort((a, b) => b.endDate.localeCompare(a.endDate))
      .slice(0, 3)
      .map((ev) => ev.toObject());

    const todayTodos = todos.filter((td) => td.due <= today);

    res.json({
      date: today,
      // 그 주에 준비 기간이 몇 개나 겹쳐 있는지 = 이번 주 부담 (기획서 8.5의 숫자 버전)
      overlapCount: active.filter((ev) => ev.needsPrep).length,
      active,
      upcoming,
      retroPending,
      todos: todayTodos,
    });
  } catch (err) {
    console.error('[GET /briefing]', err);
    res.status(500).json({ error: '브리핑 조회 오류', detail: err.message });
  }
});

// ---------- 공유/단축어 자동화: 분석 + 저장을 한 번에 ----------
// Android Web Share Target과 iOS 단축어가 같은 저장 로직을 공유한다.
async function saveQuickAddAnalysis({ parsed, rawContent, sourceType, ctx, userId }) {
  parsed.category = ctx.toKey(parsed.category);
  const shaped = shapeParsed(parsed, ctx);

  const notice = await Notice.create({
    user: userId,
    sourceType,
    rawContent,
    summary: shaped.summary,
    priority: shaped.priority,
    category: shaped.category,
    needsPrep: shaped.needsPrep,
    leadTimeDays: shaped.leadTimeDays,
  });

  let savedEvent = null;
  let savedTodo = null;

  if (shaped.event) {
    // shapeParsed()에서 이미 준비기간이 반영된 상태(startDate 당겨짐 + steps 생성)라 그대로 저장
    savedEvent = await ScheduleEvent.create({
      user: userId,
      noticeId: notice._id,
      ...shaped.event,
      category: shaped.category,
      notify: true,
      priority: shaped.priority,
      aiSummary: shaped.summary,
      sourceType,
      sourceContent: rawContent,
    });
    notifyEventCreated(savedEvent);
  }
  if (shaped.todo) {
    savedTodo = await Todo.create({
      user: userId,
      noticeId: notice._id,
      title: shaped.todo.title,
      due: shaped.todo.due,
      done: false,
    });
  }

  let message;
  if (savedEvent && savedEvent.needsPrep) {
    message = `"${savedEvent.title}" — ${savedEvent.startDate}부터 준비 시작 (마감 ${savedEvent.endDate}, 준비 ${savedEvent.leadTimeDays}일)`;
  } else if (savedEvent) {
    message = `"${savedEvent.title}" 일정이 추가됐어요.`;
  } else if (savedTodo) {
    message = `"${savedTodo.title}" 할일이 추가됐어요.`;
  } else {
    message = '분석은 했지만 캘린더에 추가할 일정/할일은 없었어요.';
  }

  return { message, notice, event: savedEvent, todo: savedTodo };
}

async function quickAddTextNotice(text, categories, userId = null) {
  // 공유 시트는 종류 설정을 못 보내므로 기본 6종으로 처리된다.
  const ctx = categoryContext(categories);
  const { parsed, rawContent } = await analyzeTextNotice(text.trim(), ctx.labels);
  return saveQuickAddAnalysis({ parsed, rawContent, sourceType: 'text', ctx, userId });
}

async function quickAddImageNotice(file, categories, userId = null) {
  const ctx = categoryContext(categories);
  const base64Image = file.buffer.toString('base64');
  const { parsed, rawContent } = await analyzeImageNotice(base64Image, file.mimetype, ctx.labels);
  return saveQuickAddAnalysis({ parsed, rawContent, sourceType: 'image', ctx, userId });
}

// 아이폰 단축어용 JSON API
router.post('/notices/quick-add', async (req, res) => {
  try {
    const { text } = req.body;
    if (!text || !text.trim()) {
      return res.status(400).json({ error: '공지 텍스트가 비어있음' });
    }

    const result = await quickAddTextNotice(text, req.body.categories, req.userId);
    res.status(201).json(result);
  } catch (err) {
    console.error('[POST /notices/quick-add]', err);
    res.status(500).json({ error: '자동 처리 중 오류 발생', detail: err.message });
  }
});

function sendShareOutcome(req, res, status, message) {
  // 서비스워커 중계 요청은 JSON을 받고 자신이 최종 앱 URL로 리다이렉트한다.
  // 서버가 여기서 바로 리다이렉트하면 fetch가 HTML까지 따라간 뒤 action URL에 남을 수 있다.
  if (req.query?.relay === '1') {
    return res.status(status === 'success' ? 200 : 400).json({
      shareStatus: status,
      shareMessage: message,
    });
  }

  const query = new URLSearchParams({
    shareStatus: status,
    shareMessage: message,
  });
  return res.redirect(303, `/?${query.toString()}`);
}

function sharedTextFrom(source) {
  const value = source || {};
  return [...new Set(
    [value.title, value.text, value.url]
      .map((item) => String(item || '').trim())
      .filter(Boolean)
  )].join('\n\n');
}

function detectSharedImageMime(file) {
  const declared = String(file?.mimetype || '').toLowerCase();
  if (declared.startsWith('image/')) return declared;

  const buffer = file?.buffer;
  if (buffer?.length >= 12) {
    if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
    if (buffer.subarray(0, 3).toString('ascii') === 'GIF') return 'image/gif';
    if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
    if (buffer.subarray(4, 12).toString('ascii').startsWith('ftyphei')) return 'image/heic';
  }

  const extension = String(file?.originalname || '').split('.').pop().toLowerCase();
  return {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    heic: 'image/heic',
    heif: 'image/heif',
  }[extension] || null;
}

// Android 제조사/공유 앱마다 파일 필드명과 단일·배열 전송 방식이 달라서 any()로 받은 뒤
// 실제 이미지 첫 장을 골라낸다. 용량·파일 수 제한은 위 upload 설정을 그대로 적용한다.
function receiveSharedImage(req, res, next) {
  upload.any()(req, res, (err) => {
    if (err) {
      console.error('[share upload]', err.code || 'UPLOAD_ERROR', err.field || '', err.message);
      const message = err.code === 'LIMIT_FILE_SIZE'
        ? '이미지는 8MB 이하만 공유할 수 있어요.'
        : err.code === 'LIMIT_FILE_COUNT'
          ? '한 번에 공유한 이미지가 너무 많아요.'
          : '공유한 이미지를 읽지 못했어요.';
      return sendShareOutcome(req, res, 'error', message);
    }

    const files = Array.isArray(req.files) ? req.files : [];
    req.file = files.find((file) => {
      const mime = detectSharedImageMime(file);
      if (!mime) return false;
      file.mimetype = mime;
      return true;
    }) || null;

    if (files.length && !req.file) {
      return sendShareOutcome(req, res, 'error', '지원하지 않는 이미지 형식이에요. PNG 또는 JPG로 다시 시도해주세요.');
    }
    return next();
  });
}

// Android PWA 공유 대상: 텍스트 또는 이미지를 곧바로 AI 분석·저장하고 앱으로 돌아간다.
async function handleSharedNotice(req, res) {
  const sharedText = sharedTextFrom(req.body);

  if (req.file && !String(req.file.mimetype || '').startsWith('image/')) {
    return sendShareOutcome(req, res, 'error', '이미지 파일만 공유할 수 있어요.');
  }
  if (!req.file && !sharedText) {
    return sendShareOutcome(req, res, 'error', '공유된 텍스트나 이미지가 없어 등록하지 못했어요.');
  }

  try {
    const result = req.file
      ? await quickAddImageNotice(req.file, null, req.userId)
      : await quickAddTextNotice(sharedText, null, req.userId);
    return sendShareOutcome(req, res, 'success', result.message);
  } catch (err) {
    console.error('[POST /notices/share-target]', err);
    return sendShareOutcome(req, res, 'error', 'AI 자동 등록에 실패했어요. 잠시 후 다시 시도해주세요.');
  }
}

// 일부 Android/WebAPK는 설치 캐시나 호환성 문제로 action URL을 GET으로 다시 연다.
// 원문이 쿼리에 있으면 텍스트 자동 등록을 수행하고, 없더라도 JSON 404 대신 앱으로 복귀시킨다.
router.get('/notices/share-target', async (req, res) => {
  const sharedText = sharedTextFrom(req.query);
  if (!sharedText) {
    return sendShareOutcome(req, res, 'error', '공유 데이터를 받지 못했어요. 앱을 다시 설치한 뒤 시도해주세요.');
  }
  try {
    const result = await quickAddTextNotice(sharedText, null, req.userId);
    return sendShareOutcome(req, res, 'success', result.message);
  } catch (err) {
    console.error('[GET /notices/share-target]', err);
    return sendShareOutcome(req, res, 'error', 'AI 자동 등록에 실패했어요. 잠시 후 다시 시도해주세요.');
  }
});

// 서비스워커가 아직 갱신되지 않은 설치본은 기존 경로로 직접 들어올 수 있어 유지한다.
router.post('/notices/share-target', receiveSharedImage, handleSharedNotice);
// 새 서비스워커는 Android의 원본 multipart를 읽어 다시 만든 뒤 이 경로로 전달한다.
router.post('/notices/share-upload', receiveSharedImage, handleSharedNotice);

// ---------- 웹 푸시 ----------

const PushSubscription = require('../models/PushSubscription');

// 프론트에서 구독할 때 필요한 VAPID 공개키
router.get('/push/vapid-public-key', (req, res) => {
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY || '' });
});

// 브라우저가 PushManager.subscribe()로 만든 구독 정보를 저장
router.post('/push/subscribe', async (req, res) => {
  try {
    const { endpoint, keys } = req.body;
    if (!endpoint || !keys || !keys.p256dh || !keys.auth) {
      return res.status(400).json({ error: '구독 정보가 올바르지 않음' });
    }
    // 같은 기기(endpoint)에서 다른 계정으로 로그인한 뒤 알림을 켜면 소유자만 새 계정으로 바뀐다
    await PushSubscription.findOneAndUpdate(
      { endpoint },
      { endpoint, keys, user: req.userId },
      { upsert: true, new: true }
    );
    res.status(201).json({ ok: true });
  } catch (err) {
    console.error('[POST /push/subscribe]', err);
    res.status(500).json({ error: '구독 저장 오류', detail: err.message });
  }
});

module.exports = router;
