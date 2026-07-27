const { GoogleGenerativeAI } = require('@google/generative-ai');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// .env의 GEMINI_MODEL을 콤마로 여러 개 등록해두면, 앞에서부터 순서대로 시도하다가
// 하나라도 성공하면 그걸로 응답함 (특정 모델이 그날그날 불안정하거나 막혀도 자동으로 다음 걸로 넘어감)
// 예: GEMINI_MODEL=gemini-3.1-flash-lite,gemini-3.1-flash,gemini-2.5-flash
const MODEL_CANDIDATES = (process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite')
  .split(',')
  .map(m => m.trim())
  .filter(Boolean);

// 여러 모델을 순서대로 시도하는 공통 함수. callFn(modelName)이 모델 하나를 가지고
// 실제 API 호출을 수행하는 함수. 다 실패하면 마지막 에러를 그대로 던짐
async function withModelFallback(callFn) {
  let lastErr;
  for (const modelName of MODEL_CANDIDATES) {
    try {
      return await callFn(modelName);
    } catch (err) {
      console.error(`[Gemini] 모델 "${modelName}" 실패, 다음 모델로 넘어감:`, err.message);
      lastErr = err;
    }
  }
  throw lastErr;
}

// 오늘 날짜를 프롬프트에 박아줘야 "내일", "다음주 금요일" 같은
// 상대적 날짜 표현을 AI가 정확한 YYYY-MM-DD로 변환할 수 있음
function getTodayString() {
  const today = new Date();
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth() + 1).padStart(2, '0');
  const dd = String(today.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

const SYSTEM_INSTRUCTION = `
너는 학생/직장인을 위한 공지사항 분석 AI다.
카카오톡, 학교 홈페이지, LMS, 이메일, e알리미 등에서 온 공지 원문(텍스트 또는 이미지 속 텍스트)을 받아서
아래 JSON 스키마에 '정확히' 맞춰 분석 결과만 응답한다. 다른 설명, 마크다운 코드블록, 인사말은 절대 포함하지 않는다.

{
  "extractedText": "공지에서 읽은 원문을 그대로 옮겨적은 텍스트 (이미지인 경우 OCR 결과, 텍스트 입력이면 원문 그대로)",
  "summary": "핵심 내용을 2~3문장으로 요약",
  "priority": "high" | "medium" | "low",
  "category": "학사일정" | "과제" | "시험" | "행사" | "회의" | "기타" 중 하나,
  "scheduleItems": [
    {
      "title": "일정 제목",
      "startDate": "YYYY-MM-DD",
      "endDate": "YYYY-MM-DD (하루짜리 일정이면 startDate와 동일)",
      "startTime": "HH:mm (시간 정보 없으면 09:00)",
      "endTime": "HH:mm (시간 정보 없으면 startTime + 1시간)"
    }
  ],
  "todoItems": [
    { "title": "해야 할 일 설명", "due": "YYYY-MM-DD" }
  ]
}

규칙:
- "오늘", "내일", "이번 주 금요일" 같은 상대 날짜는 반드시 기준일(오늘 날짜)로 계산해서 절대 날짜(YYYY-MM-DD)로 변환한다.
- "기말고사 기간: 7/27~7/31" 처럼 기간이 있는 일정은 startDate/endDate를 다르게 설정해서 여러 날에 걸친 일정으로 표현한다.
- 날짜 정보가 전혀 없는 공지는 scheduleItems를 빈 배열로 둔다.
- 제출·준비가 필요한 항목(과제, 준비물, 신청 등)은 todoItems에 넣는다. 단순 안내성 공지는 todoItems를 빈 배열로 둔다. due가 없으면 scheduleItems의 날짜를 참고해서 채운다.
- priority가 "high"인 경우, 그 자체로 "오늘 안에 확인·처리해야 할 일"이 되므로 todoItems를 절대 빈 배열로 두지 말고 반드시 하나 포함시킨다. 예: "수강신청 정정기간 마감" 공지라면 todoItems에 { "title": "수강신청 정정 처리하기", "due": "오늘 날짜" }를 넣는다.
- priority는 마감이 임박하거나(3일 이내), 성적/출결/금전과 관련되면 "high", 단순 참고 공지는 "low"로 판단한다.
- 정확히 하나의 대표 scheduleItem과 하나의 대표 todoItem만 필요하다. 공지에 여러 일정이 섞여 있으면 가장 중요한 것 하나만 골라서 배열에 담는다 (배열 길이는 0 또는 1).
- 이미지에서 텍스트를 읽을 때 글자를 최대한 정확히 인식하고, 인식이 불확실한 부분은 문맥으로 보정한다.
`.trim();

function buildUserPrompt(rawText) {
  return `오늘 날짜: ${getTodayString()}\n\n분석할 공지 원문:\n"""\n${rawText}\n"""`;
}

function extractJson(text) {
  // 모델이 가끔 ```json ... ``` 코드블록을 붙이는 경우가 있어 안전하게 벗겨냄
  const cleaned = text.replace(/```json|```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) {
    throw new Error('AI 응답에서 JSON을 찾을 수 없음: ' + text.slice(0, 200));
  }
  return JSON.parse(cleaned.slice(start, end + 1));
}

/**
 * 텍스트 공지를 분석
 * @param {string} rawText
 */
async function analyzeTextNotice(rawText) {
  return withModelFallback(async (modelName) => {
    const model = genAI.getGenerativeModel({
      model: modelName,
      systemInstruction: SYSTEM_INSTRUCTION,
      generationConfig: {
        responseMimeType: 'application/json',
        maxOutputTokens: 1024,
      },
    });

    const result = await model.generateContent(buildUserPrompt(rawText));
    const responseText = result.response.text();
    const parsed = extractJson(responseText);
    return { parsed, rawContent: parsed.extractedText || rawText };
  });
}

/**
 * 이미지(스크린샷) 공지를 분석 - 먼저 OCR+구조화를 한 번에 처리
 * @param {string} base64Image - data URL 접두어(data:image/png;base64,) 제거된 순수 base64
 * @param {string} mimeType - 예: image/png, image/jpeg
 */
async function analyzeImageNotice(base64Image, mimeType) {
  return withModelFallback(async (modelName) => {
    const model = genAI.getGenerativeModel({
      model: modelName,
      systemInstruction: SYSTEM_INSTRUCTION,
      generationConfig: {
        responseMimeType: 'application/json',
        maxOutputTokens: 1024,
      },
    });

    // 이미지에서 먼저 원문 텍스트를 뽑아내고, 그 텍스트를 그대로 분석하도록
    // 프롬프트에 "이미지 속 텍스트를 읽고 분석" 지시를 포함시킴
    const prompt = `오늘 날짜: ${getTodayString()}\n\n첨부된 이미지는 카카오톡/학교 홈페이지/LMS 등의 공지 스크린샷이다. 이미지 속 텍스트를 읽어서 분석 결과를 위 JSON 스키마대로 응답하라.`;

    const result = await model.generateContent([
      { inlineData: { data: base64Image, mimeType } },
      { text: prompt },
    ]);

    const responseText = result.response.text();
    const parsed = extractJson(responseText);
    return { parsed, rawContent: parsed.extractedText || parsed.summary || '(이미지에서 추출된 내용)' };
  });
}

module.exports = { analyzeTextNotice, analyzeImageNotice, getTodayString };
