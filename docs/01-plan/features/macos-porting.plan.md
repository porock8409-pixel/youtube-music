# Plan: YouTube Music macOS Porting

> Windows 전용 Electron 유튜브 뮤직 앱을 macOS 네이티브 경험으로 포팅

---

## Executive Summary

| 관점 | 설명 |
|------|------|
| **Problem** | 현재 앱이 Windows 전용 빌드(NSIS, .ico, .bat)로만 구성되어 macOS에서 사용 불가 |
| **Solution** | electron-builder macOS 타겟 추가, macOS 네이티브 UX 패턴 적용, DMG 배포 |
| **기능/UX 효과** | macOS 사용자가 Dock, 메뉴바, 미디어키 등 네이티브 경험으로 유튜브 뮤직 사용 가능 |
| **Core Value** | 크로스 플랫폼 지원으로 사용자층 확대, 개인 생산성 도구 통합 |

---

## 1. Background & Problem

### 현재 상태
- Electron v40.8.0 기반 유튜브 뮤직 데스크톱 앱 (v3.3.0)
- Windows 전용: NSIS 인스톨러, `.ico` 아이콘, `.bat` 실행 스크립트
- `process.platform === 'win32'` 분기가 1곳 (AppUserModelId 설정)
- 핵심 로직(IPC, BrowserView, 미니플레이어, 가사)은 플랫폼 무관

### 문제점
- macOS 빌드 타겟 미설정 → 빌드 자체가 불가
- macOS 아이콘 파일(`.icns`) 부재
- macOS 특유의 UX 패턴 미적용 (Dock, 메뉴바, 창 닫기 동작 등)
- `.bat` 스크립트는 macOS에서 실행 불가

---

## 2. Goal & Scope

### Goal
macOS에서 네이티브 수준의 사용 경험을 제공하는 YouTube Music 앱 빌드

### In Scope
1. **빌드 설정**: electron-builder macOS 타겟 (DMG + zip)
2. **아이콘**: `.icns` 포맷 아이콘 생성
3. **macOS UX 적용**:
   - 창 닫기 시 앱 종료 대신 Dock 유지 (`app.on('window-all-closed')`)
   - macOS 메뉴바 (앱 메뉴, Edit 메뉴 with 복사/붙여넣기)
   - Dock 아이콘 바운스/뱃지
   - 미디어 키 지원 (재생/일시정지/다음/이전)
4. **개발 스크립트**: `.sh` 런처 또는 npm script로 통합
5. **코드 사이닝**: 기본 설정 (미서명 빌드 우선, 추후 서명 가능)

### Out of Scope
- Windows 기존 기능 변경 (기존 동작 유지)
- Mac App Store 배포 (직접 배포 우선)
- Linux 지원
- 새로운 기능 추가 (포팅에 집중)

---

## 3. Requirements

### 3.1 빌드 설정 (P0 - Must)

| ID | 요구사항 | 상세 |
|----|----------|------|
| R-01 | macOS 빌드 타겟 | `dmg` + `zip` for x64 & arm64 (Apple Silicon) |
| R-02 | `.icns` 아이콘 | 기존 `icon.png`에서 변환 |
| R-03 | 빌드 스크립트 | `npm run build:mac` 추가 |
| R-04 | Universal Binary | x64 + arm64 둘 다 지원 |

### 3.2 macOS UX (P0 - Must)

| ID | 요구사항 | 상세 |
|----|----------|------|
| R-05 | 창 닫기 동작 | 모든 창 닫아도 앱 종료 안 함 (Dock 유지) |
| R-06 | macOS 메뉴바 | 앱 메뉴 + Edit (복사/붙여넣기/전체선택) |
| R-07 | Dock 통합 | Dock 아이콘, 우클릭 메뉴 |
| R-08 | 트레이 → 메뉴바 | macOS에서는 상단 메뉴바 Tray 아이콘으로 동작 |

### 3.3 미디어 통합 (P1 - Should)

| ID | 요구사항 | 상세 |
|----|----------|------|
| R-09 | 미디어 키 | macOS 키보드 미디어 키 (F7/F8/F9) 지원 |
| R-10 | Now Playing | macOS 미디어 컨트롤 센터 연동 (가능한 범위) |

### 3.4 개발 환경 (P1 - Should)

| ID | 요구사항 | 상세 |
|----|----------|------|
| R-11 | 실행 스크립트 | `run.sh` 또는 npm script 통합 |
| R-12 | `.gitignore` 업데이트 | macOS 빌드 아티팩트, `.DS_Store` 추가 |

---

## 4. Technical Approach

### 4.1 변경 파일 목록

| 파일 | 변경 유형 | 설명 |
|------|-----------|------|
| `package.json` | 수정 | macOS 빌드 타겟, 스크립트 추가 |
| `main.js` | 수정 | macOS 플랫폼 분기 추가 (메뉴, 창 동작) |
| `assets/icon.icns` | 신규 | macOS 아이콘 |
| `run.sh` | 신규 | macOS 개발 실행 스크립트 |
| `.gitignore` | 수정 | macOS 관련 항목 추가 |

### 4.2 핵심 변경 사항

#### package.json - macOS 빌드 설정
```json
{
  "mac": {
    "icon": "assets/icon.icns",
    "category": "public.app-category.music",
    "target": [
      { "target": "dmg", "arch": ["x64", "arm64"] },
      { "target": "zip", "arch": ["x64", "arm64"] }
    ],
    "darkModeSupport": true
  },
  "dmg": {
    "title": "YouTube Music",
    "artifactName": "YouTube-Music-${version}-${arch}.dmg"
  }
}
```

#### main.js - macOS 플랫폼 처리
```javascript
// 창 모두 닫혀도 macOS에서는 앱 유지
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// macOS Dock에서 앱 아이콘 클릭 시 창 재생성
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})

// macOS 메뉴바
if (process.platform === 'darwin') {
  const template = [
    { role: 'appMenu' },
    { role: 'editMenu' },
    { role: 'windowMenu' }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
```

### 4.3 구현 순서

1. **Phase 1**: 아이콘 변환 (`icon.png` → `icon.icns`)
2. **Phase 2**: `package.json` macOS 빌드 설정 추가
3. **Phase 3**: `main.js` macOS 플랫폼 분기 추가
4. **Phase 4**: 개발 스크립트 + `.gitignore` 업데이트
5. **Phase 5**: 빌드 테스트 및 동작 확인

---

## 5. Risk & Mitigation

| 리스크 | 영향 | 대응 |
|--------|------|------|
| Apple Silicon 호환성 | arm64 빌드 실패 가능 | Universal Binary로 x64/arm64 둘 다 빌드 |
| 코드 사이닝 미적용 | "확인되지 않은 개발자" 경고 | 최초 실행 시 우클릭→열기로 우회, 추후 서명 |
| GPU 관련 플래그 | macOS에서 다르게 동작 가능 | `disable-gpu-compositing` macOS 분기 제거 검토 |
| Tray 아이콘 크기 | macOS 메뉴바는 작은 아이콘 필요 | 16x16 / 18x18 `@2x` 템플릿 이미지 준비 |

---

## 6. Success Criteria

- [ ] `npm run build:mac`으로 DMG 파일 정상 생성 (Node.js 설치 후 테스트 필요)
- [ ] macOS에서 앱 실행 시 YouTube 로드 및 음악 재생 정상
- [ ] 미니 플레이어 정상 동작
- [ ] 가사 팝업 정상 동작
- [ ] 창 닫기 시 Dock에 앱 유지
- [ ] 메뉴바 Tray 아이콘 정상 표시
- [ ] 기존 Windows 빌드에 영향 없음

## 7. Implementation Status

- [x] `.icns` 아이콘 생성 (icon.png → iconutil)
- [x] `package.json` macOS 빌드 설정 (DMG + zip, x64/arm64)
- [x] `main.js` GPU 플래그 darwin 분기
- [x] `main.js` activate 이벤트 (Dock 클릭 시 복원)
- [x] `main.js` macOS 앱 메뉴 (앱/Edit/Window)
- [x] `main.js` Tray Template Image + macOS 클릭 분기
- [x] `main.js` 트레이 메뉴에 "미니플레이어 열기/닫기" 추가
- [x] `.gitignore` macOS 항목 추가
- [x] `run.sh` 생성
- [ ] 빌드 테스트 (Node.js 설치 필요)

### 추가 변경 (macOS porting 과정에서)
- 미니 플레이어 드래그: Alt(Option)+드래그로 변경 (의도치 않은 이동 방지)
