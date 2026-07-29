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
//
// 주의: 배포 서버는 보통 타임존이 UTC라서 그냥 new Date()를 쓰면
// 한국 시각 오전 9시 이전에 날짜가 하루 밀린다 → 반드시 KST 기준으로 계산해야 함
const { todayIso: getTodayString } = require('./leadTimeService');

// 사용자가 "일정 종류" 이름을 바꿀 수 있으므로(예: 회의 → 동아리), 프롬프트의 분류 후보도
// 그 이름으로 바꿔서 보낸다. 내부 슬롯 키는 그대로라서 리드타임 규칙표·단계 템플릿은 영향받지 않는다.
const DEFAULT_CATEGORY_LABELS = ['학사일정', '과제', '시험', '행사', '회의', '기타'];

const SYSTEM_INSTRUCTION_TEMPLATE = `
너는 학생/직장인을 위한 공지사항 분석 AI다.
카카오톡, 학교 홈페이지, LMS, 이메일, e알리미 등에서 온 공지 원문(텍스트 또는 이미지 속 텍스트)을 받아서
아래 JSON 스키마에 '정확히' 맞춰 분석 결과만 응답한다. 다른 설명, 마크다운 코드블록, 인사말은 절대 포함하지 않는다.

{
  "extractedText": "공지에서 읽은 원문을 그대로 옮겨적은 텍스트 (이미지인 경우 OCR 결과, 텍스트 입력이면 원문 그대로)",
  "summary": "핵심 내용을 2~3문장으로 요약",
  "priority": "high" | "medium" | "low",
  "category": {{CATEGORY_ENUM}} 중 하나,
  "needsPrep": true | false,
  "suggestedLeadDays": 정수(준비에 필요한 날수),
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
- category는 위에 나열된 값 중 하나를 '그대로' 써야 한다. 목록에 없는 이름을 새로 만들지 않는다.
  어느 것에도 뚜렷이 해당하지 않으면 "{{CATEGORY_FALLBACK}}"으로 분류한다.
- "오늘", "내일", "이번 주 금요일" 같은 상대 날짜는 반드시 기준일(오늘 날짜)로 계산해서 절대 날짜(YYYY-MM-DD)로 변환한다.
- "기말고사 기간: 7/27~7/31" 처럼 기간이 있는 일정은 startDate/endDate를 다르게 설정해서 여러 날에 걸친 일정으로 표현한다.
- 날짜 정보가 전혀 없는 공지는 scheduleItems를 빈 배열로 둔다.
- 제출·준비가 필요한 항목(과제, 준비물, 신청 등)은 todoItems에 넣는다. 단순 안내성 공지는 todoItems를 빈 배열로 둔다. due가 없으면 scheduleItems의 날짜를 참고해서 채운다.
- priority가 "high"인 경우, 그 자체로 "오늘 안에 확인·처리해야 할 일"이 되므로 todoItems를 절대 빈 배열로 두지 말고 반드시 하나 포함시킨다. 예: "수강신청 정정기간 마감" 공지라면 todoItems에 { "title": "수강신청 정정 처리하기", "due": "오늘 날짜" }를 넣는다.
- priority는 마감이 임박하거나(3일 이내), 성적/출결/금전과 관련되면 "high", 단순 참고 공지는 "low"로 판단한다.
- 정확히 하나의 대표 scheduleItem과 하나의 대표 todoItem만 필요하다. 공지에 여러 일정이 섞여 있으면 가장 중요한 것 하나만 골라서 배열에 담는다 (배열 길이는 0 또는 1).
- 이미지에서 텍스트를 읽을 때 글자를 최대한 정확히 인식하고, 인식이 불확실한 부분은 문맥으로 보정한다.

needsPrep / suggestedLeadDays 판단 규칙 (이 서비스의 핵심):
- needsPrep은 "그 날 가서 참석하기만 하면 되는 일"이면 false, "그 날 전에 미리 시간을 들여 준비해야 하는 일"이면 true다.
  - false 예시: 학부모 총회 안내, 급식 메뉴 변경, 동아리 모임 공지, 방학식 일정 안내
  - true 예시: 수행평가, 보고서 제출, 발표, 시험, 공모전 응모, 독후감 제출
- suggestedLeadDays는 공지 "내용의 분량과 난이도"를 읽고 판단한다. 카테고리만 보고 기계적으로 정하지 말 것.
  같은 과제라도 분량에 따라 값이 달라야 한다:
  - "설문 응답 제출", "동의서 회신" → 1
  - "독후감 A4 1장" → 2~3
  - "조사 보고서 A4 5장 이상", "팀 프로젝트 발표 준비" → 5~7
  - "시험 범위가 여러 단원인 지필평가" → 7~10
- 판단 근거가 되는 단서: 요구 분량(장수/글자수), 조사·자료수집 필요 여부, 팀 작업 여부, 발표·실기 포함 여부, 시험 범위의 크기.
- needsPrep이 false면 suggestedLeadDays는 0으로 둔다.
`.trim();

// 사용자가 종류를 추가/삭제/이름변경할 수 있으므로, 분류 후보 목록을 그때그때 만들어 넣는다.
// 개수가 6개로 고정돼 있지 않다는 점이 중요하다 — 목록 길이에 맞춰 프롬프트가 달라진다.
function buildSystemInstruction(labels) {
  const list = (Array.isArray(labels) && labels.length ? labels : DEFAULT_CATEGORY_LABELS)
    .map((l) => String(l).trim())
    .filter(Boolean);
  const use = list.length ? list : DEFAULT_CATEGORY_LABELS;
  const enumText = use.map((l) => `"${l}"`).join(' | ');
  const last = use[use.length - 1];
  return SYSTEM_INSTRUCTION_TEMPLATE
    .replace('{{CATEGORY_ENUM}}', enumText)
    .replace('{{CATEGORY_FALLBACK}}', last);
}

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
 * @param {string[]} [categoryLabels] 사용자가 설정한 일정 종류 이름 목록 (없으면 기본 6종)
 */
async function analyzeTextNotice(rawText, categoryLabels) {
  return withModelFallback(async (modelName) => {
    const model = genAI.getGenerativeModel({
      model: modelName,
      systemInstruction: buildSystemInstruction(categoryLabels),
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
async function analyzeImageNotice(base64Image, mimeType, categoryLabels) {
  return withModelFallback(async (modelName) => {
    const model = genAI.getGenerativeModel({
      model: modelName,
      systemInstruction: buildSystemInstruction(categoryLabels),
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

module.exports = { analyzeTextNotice, analyzeImageNotice, getTodayString, buildSystemInstruction, DEFAULT_CATEGORY_LABELS };
