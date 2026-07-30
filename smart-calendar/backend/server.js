require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const path = require('path');

const apiRouter = require('./routes/api');
const { router: authRouter, ensureDemoAccount } = require('./routes/auth');
const { attachUser } = require('./middleware/auth');

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));
// Android Web Share Target의 POST 폼(application/x-www-form-urlencoded) 수신
app.use(express.urlencoded({ extended: false, limit: '64kb' }));

// 프론트엔드 정적 파일 서빙 (배포 시 별도 프론트 호스팅 없이 이 서버 하나로 시연 가능)
//
// index.html과 서비스워커는 캐시하지 않는다.
// 앱 코드가 전부 index.html 안에 들어있어서, 브라우저가 이 파일을 캐시해두면
// 새로 배포해도 예전 화면이 계속 뜬다. 특히 iOS는 홈 화면에 추가한 PWA의 캐시를
// 오래 붙들고 있어서, 이미 고친 버그가 그 기기에서만 계속 재현되는 일이 생긴다.
app.use(express.static(path.join(__dirname, '..', 'frontend'), {
  setHeaders: (res, filePath) => {
    if (/index\.html$|service-worker\.js$/.test(filePath)) {
      res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    }
  },
}));

// Authorization 헤더가 있으면 req.userId를 채운다. 없으면 null(게스트)로 두고 그대로 진행한다.
// 로그인하지 않아도 앱을 둘러보거나 공유 시트로 등록할 수 있어야 하므로 여기서 막지 않는다.
app.use('/api', attachUser);

app.use('/api/auth', authRouter);
app.use('/api', apiRouter);

// /api/* 로 온 요청인데 위에서 못 받은 경우 (오타난 경로, 서버 재시작 안 해서 새 라우트가
// 아직 없는 경우 등) HTML 에러 페이지 대신 JSON으로 응답 → 단축어(Shortcuts)가
// "리치 텍스트를 사전으로 변환할 수 없음" 에러 없이 정확한 에러 메시지를 받을 수 있음
app.use('/api', (req, res) => {
  res.status(404).json({ error: `해당 API 경로가 없음: ${req.method} ${req.originalUrl}` });
});

app.get('/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 4000;

mongoose
  .connect(process.env.MONGODB_URI)
  .then(async () => {
    console.log('MongoDB 연결 성공');
    // 심사위원이 바로 로그인할 수 있도록 시연용 계정을 준비해둔다 (없으면 생성, 있으면 유지)
    await ensureDemoAccount().catch((err) => console.error('[auth] 심사용 계정 준비 실패:', err.message));
    app.listen(PORT, () => console.log(`서버 실행중: http://localhost:${PORT}`));
  })
  .catch((err) => {
    console.error('MongoDB 연결 실패:', err.message);
    process.exit(1);
  });
