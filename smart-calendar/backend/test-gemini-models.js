// 지금 API 키로 어떤 Gemini 모델을 쓸 수 있는지 하나씩 테스트하는 스크립트
// 실행: cd backend && node test-gemini-models.js
require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// 테스트해볼 후보 모델들 (최신순 + 구버전 몇 개 섞어서)
const CANDIDATES = [
  'gemini-3.1-flash-lite',
  'gemini-3.1-flash',
  'gemini-2.5-flash-lite',
  'gemini-2.5-flash',
  'gemini-2.0-flash',
  'gemini-flash-latest',
];

async function testModel(modelName) {
  try {
    const model = genAI.getGenerativeModel({ model: modelName });
    const start = Date.now();
    const result = await model.generateContent('안녕이라고 한 단어로만 대답해줘');
    const ms = Date.now() - start;
    const text = result.response.text().trim();
    console.log(`✅ ${modelName.padEnd(24)} — 성공 (${ms}ms) 응답: "${text.slice(0, 30)}"`);
    return true;
  } catch (err) {
    const reason = err.status ? `${err.status} ${err.statusText || ''}` : err.message;
    console.log(`❌ ${modelName.padEnd(24)} — 실패: ${reason}`);
    return false;
  }
}

(async () => {
  if (!process.env.GEMINI_API_KEY) {
    console.log('GEMINI_API_KEY가 .env에 없음. 먼저 채워주세요.');
    process.exit(1);
  }
  console.log('--- Gemini 모델 테스트 시작 ---\n');
  const results = [];
  for (const m of CANDIDATES) {
    const ok = await testModel(m);
    if (ok) results.push(m);
  }
  console.log('\n--- 결과 ---');
  if (results.length === 0) {
    console.log('사용 가능한 모델이 하나도 없음. API 키나 네트워크(방화벽) 문제일 가능성이 높음.');
  } else {
    console.log('사용 가능한 모델 (성공한 순서대로):', results.join(', '));
    console.log('\n.env의 GEMINI_MODEL에 이렇게 콤마로 나열해서 넣으면 됨:');
    console.log(`GEMINI_MODEL=${results.join(',')}`);
  }
})();
