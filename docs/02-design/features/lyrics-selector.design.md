# Design: 가사 후보 선택 기능 (Lyrics Selector + Netease)

> Plan 문서 참조: `docs/01-plan/features/lyrics-selector.plan.md`

---

## 1. Architecture Overview

```
[mini-lyrics-popup.html]
  │  "다른 가사" 버튼 클릭
  ▼
[preload-ui.js] → ipcRenderer.invoke('lyrics:get-candidates')
  ▼
[main.js]
  ├─ LRCLIB API (최대 10개)
  └─ Netease API (최대 8개, 중국어 필터링)
  ▼
[mini-lyrics-popup.html] 오버레이에 후보 표시
  │  사용자가 후보 클릭
  ▼
[main.js]
  ├─ currentLyrics 교체
  ├─ lyrics:update 이벤트 전송
  └─ lyrics-selection.json 저장
```

---

## 2. Detailed Design

### 2.1 `main.js` — Netease API 함수

#### `neteaseSearch(title, artist)` — 곡 검색
- **Endpoint**: `POST https://music.163.com/api/search/get/`
- **Parameters**: `s` (검색어), `limit` (10), `type` (1=곡), `offset` (0)
- **Headers**: Referer `music.163.com`, User-Agent
- **Returns**: `[{ id, name, artist, album }]`

#### `neteaseLyrics(songId)` — 가사 조회
- **Endpoint**: `GET https://music.163.com/api/song/lyric?os=osx&id={songId}&lv=-1&kv=-1&tv=-1`
- **Returns**: 파싱된 가사 객체 `{ plain, synced, source: 'netease' }`
- **중국어 필터링**: 중국어 포함 + 한국어 미포함 → `null` 반환

#### `fetchLyricsFromNetease(title, artist)` — 통합 검색
- `neteaseSearch()` → 상위 3곡 → `neteaseLyrics()` 시도
- 첫 번째 유효 가사 반환

### 2.2 `main.js` — 가사 선택 저장

#### `lyrics-selection.json`
```json
{ "videoId": { "source": "lrclib"|"netease", "id": 12345 } }
```
- 최대 500곡 제한 (초과 시 FIFO 삭제)
- `loadLyricsSelection()` — app.whenReady에서 호출
- `saveLyricsSelection(videoId, source, id)` — 후보 선택 시 호출
- `getSavedLyricsSelection(videoId)` — 곡 재생 시 확인

#### `fetchLyricsById(source, id)`
- source에 따라 LRCLIB `GET /api/get/{id}` 또는 `neteaseLyrics(id)` 호출
- 저장된 선택을 재생 시 복원하는 데 사용

### 2.3 `main.js` — IPC 핸들러

#### `lyrics:get-candidates` (invoke)
1. LRCLIB: `q` 파라미터로 검색 → 최대 10개 후보
2. Netease: `neteaseSearch()` → 각 곡 `neteaseLyrics()` → 중국어 필터링 → 최대 8개
3. 두 소스 합쳐서 반환 (renderer에는 `_raw` 제외)
4. `lastLyricsCandidates`에 캐싱

#### `lyrics:select-candidate` (invoke)
1. `lastLyricsCandidates[index]`에서 가사 추출
2. `currentLyrics` 갱신 → `lyrics:update` 전송
3. `saveLyricsSelection()` 저장
4. 싱크 오프셋 초기화

### 2.4 `main.js` — `searchAndSendLyrics()` 수정

```
1. getSavedLyricsSelection(videoId) → 있으면 fetchLyricsById()
2. fetchLyrics() (기존 LRCLIB 6단계)
3. LRCLIB 실패 → fetchLyricsFromNetease() 폴백
4. sendLyricsToAll() — 모든 윈도우에 전송
```

### 2.5 `preload-ui.js` — IPC expose

```javascript
getLyricsCandidates: () => ipcRenderer.invoke('lyrics:get-candidates'),
selectLyricsCandidate: (index) => ipcRenderer.invoke('lyrics:select-candidate', index),
```

### 2.6 `mini-lyrics-popup.html` — UI

#### sync-bar에 "다른 가사" 버튼 추가
- 위치: sync-bar 우측 (margin-left: auto)
- 스타일: 기존 sync-btn과 통일

#### 풀스크린 오버레이 (`lyrics-candidates`)
- `#tab-lyrics` 내부에 `position: absolute` 오버레이
- 헤더: "다른 가사 선택" + X 닫기 버튼
- 목록: 스크롤 가능
- 각 후보 항목:
  - 트랙명
  - 아티스트 · 앨범 `SYNC` `LRCLIB`|`Netease`
  - 가사 미리보기 (80자)

#### JavaScript
- 버튼 클릭 → "LRCLIB + Netease 검색 중..." 로딩
- 후보 클릭 → `selectLyricsCandidate(index)` → 오버레이 닫기
- X 클릭 → 오버레이 닫기

---

## 3. Implementation Order (구현 완료)

| 순서 | 작업 | 상태 |
|------|------|------|
| 1 | Netease API 함수 3개 (search, lyrics, fetchFrom) | ✅ |
| 2 | 가사 선택 저장/로드 (lyrics-selection.json) | ✅ |
| 3 | fetchLyricsById (source 분기) | ✅ |
| 4 | IPC 핸들러 (get-candidates, select-candidate) | ✅ |
| 5 | searchAndSendLyrics 수정 (저장된 선택 → LRCLIB → Netease 폴백) | ✅ |
| 6 | loadLyricsSelection() 호출 추가 | ✅ |
| 7 | preload-ui.js IPC expose | ✅ |
| 8 | mini-lyrics-popup.html CSS | ✅ |
| 9 | mini-lyrics-popup.html HTML (버튼 + 오버레이) | ✅ |
| 10 | mini-lyrics-popup.html JavaScript | ✅ |
| 11 | 중국어 가사 필터링 강화 | ✅ |

---

## 4. Known Issues / TODO

- [ ] Netease 중국어 필터링 추가 검증 필요 (중국어+한국어 없음 → 스킵)
- [ ] Netease API가 지역/IP에 따라 차단될 수 있음 — 에러 시 graceful 처리됨
- [ ] 후보 검색 시 Netease 각 곡마다 가사 API 호출 → 약간의 지연 (최대 8곡)

---

## 5. Requirement Traceability

| 요구사항 | 구현 위치 | 상태 |
|----------|-----------|------|
| R-01 후보 목록 API | `lyrics:get-candidates` IPC | ✅ |
| R-02 후보 정보 표시 | candidate-item 렌더링 | ✅ |
| R-04 "다른 가사" 버튼 | sync-bar 내 `lyrics-alt-btn` | ✅ |
| R-05 후보 목록 오버레이 | `lyrics-candidates` div | ✅ |
| R-06 후보 선택 | `lyrics:select-candidate` IPC | ✅ |
| R-07 목록 닫기 | X 버튼 + 선택 후 자동 닫기 | ✅ |
| R-08 곡별 저장 | `lyrics-selection.json` | ✅ |
| R-09 재생 시 자동 적용 | `searchAndSendLyrics()` 저장된 선택 우선 | ✅ |
| R-10 Netease 검색 | `neteaseSearch()` | ✅ |
| R-11 Netease 가사 조회 | `neteaseLyrics()` | ✅ |
| R-12 자동 폴백 | `searchAndSendLyrics()` LRCLIB → Netease | ✅ |
| R-13 중국어 필터링 | `neteaseLyrics()` 내 hasChinese && !hasKorean | ✅ |
