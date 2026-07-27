const express = require('express');
const multer = require('multer');

const Notice = require('../models/Notice');
const ScheduleEvent = require('../models/ScheduleEvent');
const Todo = require('../models/Todo');
const { analyzeTextNotice, analyzeImageNotice } = require('../services/geminiService');
const { sendPushToAll } = require('../services/pushService');

const router = express.Router();

// 이미지는 메모리에만 잠깐 올렸다가 base64로 바로 Gemini에 넘기고 버림 (디스크 저장 안 함)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 }, // 8MB
});

// 일정이 하나 생성될 때마다 호출: 즉시 등록 알림 1번 + (테스트용) 1분 뒤 알람 1번을 푸시로 보냄
function notifyEventCreated(event) {
  sendPushToAll({
    title: '일정이 등록됐어요',
    body: `"${event.title}" 일정이 캘린더에 추가됐어요.`,
  }).catch((err) => console.error('[push] 등록 알림 실패:', err.message));

  setTimeout(() => {
    sendPushToAll({
      title: '⏰ 테스트 알람',
      body: `"${event.title}" 일정 알림이에요!`,
    }).catch((err) => console.error('[push] 테스트 알람 실패:', err.message));
  }, 60 * 1000);
}

// AI 분석 결과에서 프론트가 바로 쓸 수 있게 대표 이벤트/할일 1개씩만 뽑아서 정리
function shapeParsed(parsed) {
  const event = (parsed.scheduleItems || [])[0];
  const todo = (parsed.todoItems || [])[0];
  const priority = parsed.priority || 'medium';

  const shapedEvent = event
    ? {
        title: event.title,
        startDate: event.startDate,
        endDate: event.endDate || event.startDate,
        start: event.startTime || '09:00',
        end: event.endTime || '10:00',
      }
    : null;

  let shapedTodo = todo ? { title: todo.title, due: todo.due || (event ? event.startDate : '') } : null;

  // 안전장치: 중요도가 high인데 AI가 todo를 안 만들었으면 여기서 자동으로 하나 만들어줌
  // (오늘 처리해야 할 일이 없다는 건 말이 안 되니까)
  if (!shapedTodo && priority === 'high') {
    shapedTodo = {
      title: shapedEvent ? `${shapedEvent.title} 처리하기` : `${(parsed.category || '공지')} 확인하기`,
      due: shapedEvent ? shapedEvent.startDate : todayIsoKST(),
    };
  }

  return {
    summary: parsed.summary || '',
    priority,
    category: parsed.category || '기타',
    event: shapedEvent,
    todo: shapedTodo,
  };
}

function todayIsoKST() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

// ---------- 1단계: 분석만 하고 저장은 안 함 (미리보기) ----------

router.post('/notices/analyze-text', async (req, res) => {
  try {
    const { text } = req.body;
    if (!text || !text.trim()) {
      return res.status(400).json({ error: '공지 텍스트가 비어있음' });
    }

    const { parsed, rawContent } = await analyzeTextNotice(text.trim());
    res.json({ sourceType: 'text', rawContent, result: shapeParsed(parsed) });
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
    const { parsed, rawContent } = await analyzeImageNotice(base64Image, req.file.mimetype);
    res.json({ sourceType: 'image', rawContent, result: shapeParsed(parsed) });
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

    const notice = await Notice.create({
      sourceType,
      rawContent,
      summary: summary || '',
      priority: priority || 'medium',
      category: category || '기타',
    });

    let savedEvent = null;
    let savedTodo = null;

    if (addEvent) {
      savedEvent = await ScheduleEvent.create({
        noticeId: notice._id,
        title: addEvent.title,
        startDate: addEvent.startDate,
        endDate: addEvent.endDate || addEvent.startDate,
        start: addEvent.start || '09:00',
        end: addEvent.end || '10:00',
        alarm: true,
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
    const events = await ScheduleEvent.find().sort({ startDate: 1, start: 1 });
    res.json(events);
  } catch (err) {
    console.error('[GET /schedule]', err);
    res.status(500).json({ error: '일정 조회 오류', detail: err.message });
  }
});

// 수동으로 일정 추가 (+ 버튼)
router.post('/schedule', async (req, res) => {
  try {
    const { title, startDate, endDate, start, end, alarm, notify, priority } = req.body;
    if (!title || !startDate) {
      return res.status(400).json({ error: 'title/startDate가 필요함' });
    }
    const event = await ScheduleEvent.create({
      title,
      startDate,
      endDate: endDate || startDate,
      start: start || '09:00',
      end: end || '10:00',
      alarm: alarm !== undefined ? alarm : true,
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
router.patch('/schedule/:id', async (req, res) => {
  try {
    const fields = ['title', 'startDate', 'endDate', 'start', 'end', 'alarm', 'notify', 'priority'];
    const update = {};
    fields.forEach((f) => {
      if (req.body[f] !== undefined) update[f] = req.body[f];
    });
    const event = await ScheduleEvent.findByIdAndUpdate(req.params.id, update, { new: true });
    if (!event) return res.status(404).json({ error: '일정을 찾을 수 없음' });
    res.json(event);
  } catch (err) {
    console.error('[PATCH /schedule/:id]', err);
    res.status(500).json({ error: '일정 수정 오류', detail: err.message });
  }
});

// 일정 삭제
router.delete('/schedule/:id', async (req, res) => {
  try {
    const event = await ScheduleEvent.findByIdAndDelete(req.params.id);
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
    const todos = await Todo.find().sort({ done: 1, due: 1 });
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
    const todo = await Todo.create({ title, due, done: false });
    res.status(201).json(todo);
  } catch (err) {
    console.error('[POST /todos]', err);
    res.status(500).json({ error: '할일 추가 오류', detail: err.message });
  }
});

router.patch('/todos/:id', async (req, res) => {
  try {
    const todo = await Todo.findById(req.params.id);
    if (!todo) return res.status(404).json({ error: '할일을 찾을 수 없음' });
    todo.done = !todo.done;
    await todo.save();
    res.json(todo);
  } catch (err) {
    console.error('[PATCH /todos/:id]', err);
    res.status(500).json({ error: '할일 업데이트 오류', detail: err.message });
  }
});

// ---------- 단축어 자동화 전용: 분석 + 저장을 한 번에 (앱 화면 없이 백그라운드 처리) ----------
// 아이폰 "단축어" 앱에서 공유 시트로 텍스트를 받아 이 엔드포인트에 바로 POST하면,
// 사용자가 앱을 열 필요 없이 AI가 알아서 일정/할일까지 저장해줌.
router.post('/notices/quick-add', async (req, res) => {
  try {
    const { text } = req.body;
    if (!text || !text.trim()) {
      return res.status(400).json({ error: '공지 텍스트가 비어있음' });
    }

    const { parsed, rawContent } = await analyzeTextNotice(text.trim());
    const shaped = shapeParsed(parsed);

    const notice = await Notice.create({
      sourceType: 'text',
      rawContent,
      summary: shaped.summary,
      priority: shaped.priority,
      category: shaped.category,
    });

    let savedEvent = null;
    let savedTodo = null;

    if (shaped.event) {
      savedEvent = await ScheduleEvent.create({
        noticeId: notice._id,
        title: shaped.event.title,
        startDate: shaped.event.startDate,
        endDate: shaped.event.endDate,
        start: shaped.event.start,
        end: shaped.event.end,
        alarm: true,
        notify: true,
        priority: shaped.priority,
        aiSummary: shaped.summary,
        sourceType: 'text',
        sourceContent: rawContent,
      });
      notifyEventCreated(savedEvent);
    }
    if (shaped.todo) {
      savedTodo = await Todo.create({
        noticeId: notice._id,
        title: shaped.todo.title,
        due: shaped.todo.due,
        done: false,
      });
    }

    // 단축어의 "알림 표시" 동작에서 바로 쓰기 좋게 사람이 읽을 수 있는 메시지도 같이 반환
    const message = savedEvent
      ? `"${savedEvent.title}" 일정이 추가됐어요.`
      : (savedTodo ? `"${savedTodo.title}" 할일이 추가됐어요.` : '분석은 했지만 캘린더에 추가할 일정/할일은 없었어요.');

    res.status(201).json({ message, notice, event: savedEvent, todo: savedTodo });
  } catch (err) {
    console.error('[POST /notices/quick-add]', err);
    res.status(500).json({ error: '자동 처리 중 오류 발생', detail: err.message });
  }
});

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
    await PushSubscription.findOneAndUpdate(
      { endpoint },
      { endpoint, keys },
      { upsert: true, new: true }
    );
    res.status(201).json({ ok: true });
  } catch (err) {
    console.error('[POST /push/subscribe]', err);
    res.status(500).json({ error: '구독 저장 오류', detail: err.message });
  }
});

module.exports = router;
