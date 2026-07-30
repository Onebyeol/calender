const crypto = require('crypto');
const jwt = require('jsonwebtoken');

// JWT_SECRET이 없으면 부팅할 때마다 임시 키를 만든다.
// 이러면 서버가 재시작될 때 로그인이 전부 풀리므로, 배포 환경에서는 반드시 설정해야 한다.
// (render.yaml에는 generateValue: true로 걸어놔서 Render가 알아서 하나 만들어준다)
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.JWT_SECRET) {
  console.warn('[auth] JWT_SECRET이 .env에 없어서 임시 키를 씀 — 서버가 재시작되면 로그인이 풀립니다');
}

const TOKEN_TTL = '30d'; // 심사 기간 내내 다시 로그인하지 않아도 되게 넉넉히 잡는다

function signToken(user) {
  return jwt.sign({ sub: String(user._id) }, JWT_SECRET, { expiresIn: TOKEN_TTL });
}

function readToken(req) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice(7).trim();
  return null;
}

/**
 * 토큰이 있으면 req.userId를 채우고, 없으면 null로 둔다(에러를 내지 않는다).
 *
 * 로그인 없이도 쓸 수 있는 경로가 남아있기 때문이다:
 *   - "로그인 없이 둘러보기"
 *   - Android 공유 대상 / iOS 단축어 (헤더를 붙일 방법이 없음)
 * 이 요청들은 req.userId === null인 "게스트 데이터"를 보게 되고,
 * 로그인한 사용자의 일정과는 서로 보이지 않는다.
 */
function attachUser(req, res, next) {
  const token = readToken(req);
  req.userId = null;
  if (token) {
    try {
      req.userId = jwt.verify(token, JWT_SECRET).sub;
    } catch (err) {
      // 만료됐거나 위조된 토큰은 게스트로 취급한다 (401로 앱 전체를 막지 않음)
      req.userId = null;
    }
  }
  next();
}

// 로그인이 반드시 필요한 경로에서만 쓴다 (지금은 /api/auth/me)
function requireUser(req, res, next) {
  if (!req.userId) return res.status(401).json({ error: '로그인이 필요함' });
  next();
}

// 모든 DB 조회/생성에 붙일 소유자 조건.
// mongoose에서 { user: null }은 user 필드가 없는 예전 문서도 함께 매칭되므로,
// 로그인 기능을 붙이기 전에 쌓인 데이터는 자연스럽게 게스트 데이터가 된다.
function ownerScope(req) {
  return { user: req.userId };
}

module.exports = { signToken, attachUser, requireUser, ownerScope };
