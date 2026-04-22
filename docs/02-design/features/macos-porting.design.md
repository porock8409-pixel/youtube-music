# Design: YouTube Music macOS Porting

> Plan 문서 참조: `docs/01-plan/features/macos-porting.plan.md`

---

## 1. Architecture Overview

현재 앱은 Electron 멀티 윈도우 아키텍처로, 핵심 로직이 플랫폼 무관하게 작성되어 있음.
macOS 포팅은 **빌드 설정 + 플랫폼 분기 추가**로 완료 가능.

```
┌─────────────────────────────────────────────┐
│                  main.js                     │
│  ┌──────────┐  ┌──────────┐  ┌───────────┐ │
│  │MainWindow│  │MiniPlayer│  │LyricsPopup│ │
│  │(hidden)  │  │(floating)│  │(auxiliary) │ │
│  └──────────┘  └──────────┘  └───────────┘ │
│       │                                      │
│  ┌──────────┐                               │
│  │BrowserView│ ← YouTube 로드               │
│  └──────────┘                               │
│                                              │
│  ┌─────────────────────────────────────┐    │
│  │ Platform Layer (NEW)                 │    │
│  │  ├─ win32: AppUserModelId, NSIS     │    │
│  │  └─ darwin: Menu, Dock, activate    │    │
│  └─────────────────────────────────────┘    │
└─────────────────────────────────────────────┘
```

---

## 2. Detailed Design

### 2.1 `package.json` 변경

#### 2.1.1 빌드 스크립트 추가

```json
"scripts": {
  "start": "electron .",
  "build": "electron-builder",
  "build:win": "electron-builder --win",
  "build:mac": "electron-builder --mac",
  "build:dir": "electron-builder --dir"
}
```

#### 2.1.2 macOS 빌드 타겟 추가 (`build` 섹션 내)

```json
"mac": {
  "icon": "assets/icon.icns",
  "category": "public.app-category.music",
  "target": [
    { "target": "dmg", "arch": ["x64", "arm64"] },
    { "target": "zip", "arch": ["x64", "arm64"] }
  ],
  "darkModeSupport": true,
  "hardenedRuntime": false,
  "gatekeeperAssess": false
},
"dmg": {
  "title": "YouTube Music",
  "artifactName": "YouTube-Music-${version}-${arch}.dmg",
  "contents": [
    { "x": 130, "y": 220 },
    { "x": 410, "y": 220, "type": "link", "path": "/Applications" }
  ]
}
```

#### 2.1.3 files 배열에 icns 추가

```json
"files": [
  "main.js",
  "preload.js",
  "preload-ui.js",
  "renderer/**/*",
  "assets/icon.png",
  "assets/icon.ico",
  "assets/icon.icns",
  "assets/tray.png",
  "!node_modules",
  "!dist",
  "!.git"
]
```

---

### 2.2 `main.js` 변경

#### 2.2.1 macOS `window-all-closed` 동작 변경

**현재 코드** (line 606):
```javascript
app.on('window-all-closed', () => { /* 트레이 상주 */ })
```

**변경**: 그대로 유지. 현재 이미 빈 핸들러로 앱 종료를 방지하고 있어 macOS에서도 정상 동작.

#### 2.2.2 macOS `activate` 이벤트 추가

**위치**: `app.whenReady().then(...)` 블록 내부, `createMainWindow()` 호출 이후

```javascript
// macOS: Dock 아이콘 클릭 시 메인 창 복원
app.on('activate', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show()
  }
})
```

**설계 근거**: 새 창을 만들지 않고 기존 숨겨진 창을 show() — 기존 BrowserView(YouTube 세션)를 유지하기 위함.

#### 2.2.3 macOS 앱 메뉴 설정

**위치**: `app.whenReady().then(...)` 내부, `createTray()` 이후

```javascript
if (process.platform === 'darwin') {
  const menuTemplate = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        { role: 'front' }
      ]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate))
}
```

**설계 근거**: macOS는 앱 메뉴바가 필수. Edit 메뉴 없으면 Cmd+C/V가 BrowserView 안에서 동작하지 않을 수 있음.

#### 2.2.4 Tray 아이콘 macOS 대응

**현재 코드** (line 1187-1189):
```javascript
function createTray() {
  const icon = nativeImage.createFromPath(getIconPath())
  tray = new Tray(icon.resize({ width: 16, height: 16 }))
```

**변경**: macOS에서는 Template Image 사용 (메뉴바 다크/라이트 모드 자동 대응)

```javascript
function createTray() {
  let icon
  if (process.platform === 'darwin') {
    // macOS: 16x16 Template Image (메뉴바 자동 색상 대응)
    icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray.png'))
    icon = icon.resize({ width: 16, height: 16 })
    icon.setTemplateImage(true)
  } else {
    icon = nativeImage.createFromPath(getIconPath())
    icon = icon.resize({ width: 16, height: 16 })
  }
  tray = new Tray(icon)
```

**설계 근거**: macOS 메뉴바 아이콘은 `setTemplateImage(true)`를 사용해야 다크모드에서 흰색, 라이트모드에서 검정색으로 자동 전환됨.

#### 2.2.5 Tray 클릭 이벤트 macOS 분기

**현재 코드** (line 1193-1201):
```javascript
tray.on('click', () => { createMiniPlayer() })
tray.on('right-click', () => { tray.popUpContextMenu() })
```

**변경**: macOS에서는 click/right-click 구분 없이 메뉴 표시가 표준

```javascript
if (process.platform === 'darwin') {
  // macOS: 좌클릭도 컨텍스트 메뉴 (표준 동작)
  // 미니플레이어 토글은 메뉴 항목으로 제공
  tray.on('click', () => {
    tray.popUpContextMenu()
  })
} else {
  tray.on('click', () => { createMiniPlayer() })
  tray.on('right-click', () => { tray.popUpContextMenu() })
}
```

#### 2.2.6 GPU 플래그 macOS 분기

**현재 코드** (line 10):
```javascript
app.commandLine.appendSwitch('disable-gpu-compositing')
```

**변경**: macOS에서는 GPU 컴포지팅 비활성화 제거 (Metal 렌더링 활용)

```javascript
if (process.platform !== 'darwin') {
  app.commandLine.appendSwitch('disable-gpu-compositing')
}
app.commandLine.appendSwitch('disable-software-rasterizer')
```

#### 2.2.7 글로벌 단축키 macOS 호환

**현재 코드** (line 2576-2590): `CommandOrControl` 이미 사용 중 — 추가 변경 불필요.

단, `Ctrl+W`는 macOS에서 `Cmd+W`가 되므로 기존 동작(창 숨기기)이 macOS 표준(창 닫기)과 일치 — 문제 없음.

---

### 2.3 아이콘 파일 생성 (`assets/icon.icns`)

**방법**: 기존 `assets/icon.png`에서 macOS `iconutil` 도구로 변환

```bash
# icon.png → iconset → icns
mkdir icon.iconset
sips -z 16 16     icon.png --out icon.iconset/icon_16x16.png
sips -z 32 32     icon.png --out icon.iconset/icon_16x16@2x.png
sips -z 32 32     icon.png --out icon.iconset/icon_32x32.png
sips -z 64 64     icon.png --out icon.iconset/icon_32x32@2x.png
sips -z 128 128   icon.png --out icon.iconset/icon_128x128.png
sips -z 256 256   icon.png --out icon.iconset/icon_128x128@2x.png
sips -z 256 256   icon.png --out icon.iconset/icon_256x256.png
sips -z 512 512   icon.png --out icon.iconset/icon_256x256@2x.png
sips -z 512 512   icon.png --out icon.iconset/icon_512x512.png
sips -z 1024 1024 icon.png --out icon.iconset/icon_512x512@2x.png
iconutil -c icns icon.iconset -o assets/icon.icns
rm -rf icon.iconset
```

---

### 2.4 `.gitignore` 업데이트

추가할 항목:
```
# macOS
.DS_Store
*.dmg
*.app
```

---

### 2.5 `run.sh` (macOS 개발 실행 스크립트)

```bash
#!/bin/bash
cd "$(dirname "$0")"
npx electron .
```

---

## 3. Implementation Order

| 순서 | 작업 | 파일 | 요구사항 ID |
|------|------|------|-------------|
| 1 | `.icns` 아이콘 생성 | `assets/icon.icns` | R-02 |
| 2 | `package.json` macOS 빌드 설정 | `package.json` | R-01, R-03, R-04 |
| 3 | `main.js` GPU 플래그 분기 | `main.js:10` | - |
| 4 | `main.js` activate 이벤트 | `main.js:~603` | R-05 |
| 5 | `main.js` macOS 앱 메뉴 | `main.js:~594` | R-06 |
| 6 | `main.js` Tray macOS 대응 | `main.js:1187-1201` | R-07, R-08 |
| 7 | `.gitignore` 업데이트 | `.gitignore` | R-12 |
| 8 | `run.sh` 생성 | `run.sh` | R-11 |
| 9 | 빌드 테스트 (`npm run build:mac`) | - | 전체 검증 |

---

## 4. Data Flow (변경 없음)

기존 IPC 통신, 데이터 저장 경로(`app.getPath('userData')`)는 플랫폼 무관.
macOS에서는 `~/Library/Application Support/YouTube Music/`에 자동 저장.

---

## 5. Testing Strategy

| 테스트 항목 | 방법 | 예상 결과 |
|-------------|------|-----------|
| DMG 빌드 | `npm run build:mac` | `dist/` 에 `.dmg` 파일 생성 |
| 앱 실행 | DMG 설치 후 실행 | YouTube 로드, 음악 재생 |
| 미니 플레이어 | Cmd+M | 플로팅 윈도우 표시 |
| 가사 팝업 | Cmd+L | 가사 팝업 표시 |
| Dock 동작 | 창 닫기 → Dock 클릭 | 창 복원 |
| 메뉴바 Tray | 상단바 아이콘 확인 | 아이콘 표시, 클릭 시 메뉴 |
| 앱 메뉴 | Cmd+C/V in YouTube | 복사/붙여넣기 동작 |
| 다크모드 | 시스템 다크모드 전환 | Tray 아이콘 색상 변경 |
| Windows 회귀 | `npm run build:win` | 기존 동일하게 동작 |

---

## 6. Dependency Changes

없음. 기존 `electron` + `electron-builder`만으로 macOS 빌드 가능.

---

## 7. Requirement Traceability

| 요구사항 | Design Section | 구현 위치 |
|----------|----------------|-----------|
| R-01 macOS 빌드 타겟 | 2.1.2 | `package.json` build.mac |
| R-02 .icns 아이콘 | 2.3 | `assets/icon.icns` |
| R-03 빌드 스크립트 | 2.1.1 | `package.json` scripts |
| R-04 Universal Binary | 2.1.2 | arch: ["x64", "arm64"] |
| R-05 창 닫기 동작 | 2.2.1, 2.2.2 | `main.js` window-all-closed + activate |
| R-06 macOS 메뉴바 | 2.2.3 | `main.js` Menu.setApplicationMenu |
| R-07 Dock 통합 | 2.2.2 | `main.js` app.on('activate') |
| R-08 트레이→메뉴바 | 2.2.4, 2.2.5 | `main.js` createTray() |
| R-09 미디어 키 | 2.2.7 | CommandOrControl 이미 호환 |
| R-11 실행 스크립트 | 2.5 | `run.sh` |
| R-12 .gitignore | 2.4 | `.gitignore` |
