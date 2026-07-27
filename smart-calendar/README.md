# 신박한 캘린더 — AI 공지 분석 캘린더

Claude Design으로 만든 목업을 그대로 실제 동작하는 앱으로 구현했어요.
공지(텍스트/이미지)를 넣으면 Gemini API가 요약·중요도·일정·할일을 자동으로 뽑아내고,
사용자가 "캘린더에 추가"/"할일에 추가"를 누른 것만 저장됩니다.

## 폴더 구조
```
smart-calendar/
├── backend/
│   ├── server.js                  # Express 진입점 (프론트 정적파일도 같이 서빙)
│   ├── routes/api.js              # 분석/확인/캘린더/할일 API
│   ├── services/geminiService.js  # 공지 분석 핵심 로직 (여기가 제일 중요)
│   └── models/                    # Notice, ScheduleEvent(멀티데이 지원), Todo
└── frontend/
    └── index.html                 # 알림/공지/캘린더/할일 4탭, 월 그리드 캘린더, 다크모드
                                    # (Claude Design 목업 구조를 그대로 vanilla JS로 구현)
```

## 1. 실행 방법

```bash
cd backend
npm install
cp .env.example .env
```

`.env` 파일 채우기:
- `GEMINI_API_KEY` — https://aistudio.google.com/apikey
- `MONGODB_URI` — MongoDB Atlas 연결 문자열 (Network Access에 0.0.0.0/0 등록 필요)
- `GEMINI_MODEL` — 기본값 `gemini-3.1-flash-lite` (2.5-flash-lite는 신규 키에서 404남)

```bash
npm start
```

`http://localhost:4000` 접속.

## 2. 핵심 플로우 (2단계: 분석 → 확인)

1. **분석 (미리보기, 저장 안 됨)**
   - 텍스트: `POST /api/notices/analyze-text { text }`
   - 이미지: `POST /api/notices/analyze-image` (multipart, field: `image`)
   - 응답: `{ sourceType, rawContent, result: { summary, priority, category, event, todo } }`
2. **확인 (사용자가 버튼을 눌러야 저장)**
   - `POST /api/notices/confirm { sourceType, rawContent, summary, priority, category, addEvent?, addTodo? }`
   - `addEvent`/`addTodo`를 보낸 것만 실제로 `ScheduleEvent`/`Todo`에 저장됨
   - "캘린더에 추가"와 "할일에 추가"는 각각 별도로 호출 (둘 다 누르면 Notice 레코드가 2번 생기지만, 상관없음 — 히스토리 겸용)

## 3. 캘린더/할일 CRUD
- `GET /api/schedule` — 전체 일정 (월 그리드 렌더링은 프론트에서 처리)
- `POST /api/schedule` / `PATCH /api/schedule/:id` / `DELETE /api/schedule/:id` — FAB(+) 버튼으로 수동 추가한 일정
- `GET /api/todos`, `PATCH /api/todos/:id` — 할일 조회/완료 토글

## 4. 디자인에서 가져온 기능
- 월 그리드 캘린더 + 여러 날짜에 걸친 일정(예: 기말고사 기간)을 레인에 배치하는 바 표시
- 다크모드 토글
- 알림(전체 일정 피드) / 공지(AI 분석) / 캘린더 / 할일 4탭
- 일정 상세보기에서 AI 요약 + 원본 자료(텍스트/이미지) 확인
- 로그인/회원가입/프로필 화면 — **주의: 현재는 UI만 있고 실제 인증 백엔드는 없음(클라이언트 상태로만 존재)**.
  실제 계정 시스템이 필요하면 알려주면 JWT 인증 붙여줄게.

## 5. 지금 범위에서 빠진 것 (시간 남으면 붙일 것들)
- 실제 알림 발송 (지금은 `alarm`/`notify` 토글 값만 저장, 실제 푸시는 미구현)
- 변경 공지 자동 반영 (신청서 6번 기능) — 난이도 대비 시간 리스크가 커서 제외 추천
- 로그인 실제 백엔드 연동 (현재 목업)

