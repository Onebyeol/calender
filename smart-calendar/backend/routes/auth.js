const express = require('express');

const User = require('../models/User');
const { signToken, requireUser } = require('../middleware/auth');
const { ensureDemoData } = require('../services/demoSeed');

const router = express.Router();

// 심사위원에게 알려줄 계정. 값은 .env로 바꿀 수 있게 해두되, 안 넣어도 바로 쓸 수 있게 기본값을 둔다.
const DEMO_EMAIL = (process.env.DEMO_EMAIL || 'demo@sinbak.app').toLowerCase();
const DEMO_PASSWORD = process.env.DEMO_PASSWORD || 'sinbak2026';
const DEMO_NAME = process.env.DEMO_NAME || '심사위원';

/**
 * 서버가 뜰 때 심사용 계정이 없으면 만들어둔다.
 * 이미 있으면 비밀번호만 .env 값에 맞춰 갱신한다 (비밀번호를 바꿨는데 로그인이 안 되는 상황 방지).
 */
async function ensureDemoAccount() {
  let user = await User.findOne({ email: DEMO_EMAIL });
  if (!user) {
    user = new User({ name: DEMO_NAME, email: DEMO_EMAIL, isDemo: true });
    await user.setPassword(DEMO_PASSWORD);
    await user.save();
    console.log(`[auth] 심사용 계정 생성: ${DEMO_EMAIL} / ${DEMO_PASSWORD}`);
    return user;
  }

  const samePassword = await user.checkPassword(DEMO_PASSWORD);
  if (!samePassword || !user.isDemo) {
    user.isDemo = true;
    await user.setPassword(DEMO_PASSWORD);
    await user.save();
    console.log(`[auth] 심사용 계정 정보 갱신: ${DEMO_EMAIL}`);
  }
  return user;
}

function cleanEmail(value) {
  return String(value ?? '').trim().toLowerCase();
}

router.post('/signup', async (req, res) => {
  try {
    const name = String(req.body.name ?? '').trim();
    const email = cleanEmail(req.body.email);
    const password = String(req.body.password ?? '');

    if (!name) return res.status(400).json({ error: '이름을 입력해주세요.' });
    if (!email) return res.status(400).json({ error: '이메일을 입력해주세요.' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: '이메일 형식이 올바르지 않아요.' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: '비밀번호는 6자 이상이어야 해요.' });
    }

    if (await User.exists({ email })) {
      return res.status(409).json({ error: '이미 가입된 이메일이에요.' });
    }

    const user = new User({ name, email });
    await user.setPassword(password);
    await user.save();

    res.status(201).json({ token: signToken(user), user: user.toPublic() });
  } catch (err) {
    console.error('[POST /auth/signup]', err);
    res.status(500).json({ error: '회원가입 중 오류 발생', detail: err.message });
  }
});

router.post('/login', async (req, res) => {
  try {
    const email = cleanEmail(req.body.email);
    const password = String(req.body.password ?? '');
    if (!email || !password) {
      return res.status(400).json({ error: '아이디와 비밀번호를 입력해주세요.' });
    }

    const user = await User.findOne({ email });
    // 존재하지 않는 계정과 비밀번호 오류를 같은 메시지로 처리한다 (어떤 이메일이 가입돼 있는지 노출 방지)
    if (!user || !(await user.checkPassword(password))) {
      return res.status(401).json({ error: '아이디 또는 비밀번호가 올바르지 않아요.' });
    }

    // 심사용 계정이면 샘플 일정을 오늘 날짜 기준으로 채워둔다
    const seeded = await ensureDemoData(user);

    res.json({ token: signToken(user), user: user.toPublic(), seeded });
  } catch (err) {
    console.error('[POST /auth/login]', err);
    res.status(500).json({ error: '로그인 중 오류 발생', detail: err.message });
  }
});

// 앱을 다시 열었을 때 저장된 토큰이 아직 유효한지 확인하고 사용자 정보를 돌려준다
router.get('/me', requireUser, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user) return res.status(401).json({ error: '로그인이 필요함' });
    res.json({ user: user.toPublic() });
  } catch (err) {
    console.error('[GET /auth/me]', err);
    res.status(500).json({ error: '사용자 조회 오류', detail: err.message });
  }
});

// 심사용 계정 안내를 로그인 화면에 그대로 띄우기 위한 정보 (비밀번호는 데모 계정 것만 노출)
router.get('/demo-account', (req, res) => {
  res.json({ email: DEMO_EMAIL, password: DEMO_PASSWORD });
});

module.exports = { router, ensureDemoAccount };
