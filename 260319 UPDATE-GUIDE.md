# YouTube Music Desktop App - 업데이트 배포 가이드

## 사전 준비

- Node.js + npm 설치 (`brew install node`)
- GitHub CLI 인증 완료 (`gh auth login`)
- Repo: `porock8409-pixel/youtube-music` (Private)

---

## 업데이트 배포 순서

### 1. 코드 수정

원하는 기능 추가/버그 수정 후 저장.

### 2. 버전 올리기

`package.json`의 `"version"` 수정:

```json
"version": "3.5.0"
```

**버전 규칙:**
| 변경 유형 | 예시 | 설명 |
|-----------|------|------|
| 버그 수정 | 3.4.0 → 3.4.1 | patch |
| 기능 추가 | 3.4.0 → 3.5.0 | minor |
| 대규모 변경 | 3.4.0 → 4.0.0 | major |

### 3. 빌드

```bash
cd "4. Projects/youtube-music"
npm run build
```

빌드 완료 후 `dist/` 폴더에 DMG, ZIP, blockmap, `latest-mac.yml` 생성됨.

### 4. Git 커밋 & 푸시

```bash
git add -A
git commit -m "feat: v3.5.0 변경내용 요약"
git push origin main
```

### 5. GitHub Release 생성

```bash
VERSION=3.5.0

gh release create v$VERSION \
  "dist/YouTube-Music-$VERSION-arm64.dmg" \
  "dist/YouTube Music-$VERSION-arm64-mac.zip" \
  "dist/YouTube Music-$VERSION-arm64-mac.zip.blockmap" \
  "dist/YouTube-Music-$VERSION-arm64.dmg.blockmap" \
  "dist/YouTube-Music-$VERSION-x64.dmg" \
  "dist/YouTube Music-$VERSION-mac.zip" \
  "dist/YouTube Music-$VERSION-mac.zip.blockmap" \
  "dist/YouTube-Music-$VERSION-x64.dmg.blockmap" \
  "dist/latest-mac.yml" \
  --title "v$VERSION" \
  --notes "변경 내용을 여기에 작성"
```

> Intel Mac 빌드가 필요 없으면 x64 관련 4줄 제거 가능.

---

## Release 생성 후 동작

1. 설치된 앱이 **1시간마다** 자동으로 GitHub Release 확인
2. 새 버전 발견 시 **"업데이트 가능"** 알림 표시
3. 사용자가 확인 → 백그라운드 다운로드 → 자동 설치 & 재시작
4. 트레이 메뉴 → **"업데이트 확인"** 으로 수동 확인도 가능

---

## 원라인 배포 (숙련자용)

```bash
VERSION=3.5.0 && \
npm run build && \
git add -A && git commit -m "v$VERSION" && git push origin main && \
gh release create v$VERSION dist/YouTube-Music-$VERSION-arm64.dmg "dist/YouTube Music-$VERSION-arm64-mac.zip" "dist/YouTube Music-$VERSION-arm64-mac.zip.blockmap" "dist/YouTube-Music-$VERSION-arm64.dmg.blockmap" dist/latest-mac.yml --title "v$VERSION" --notes "업데이트"
```

---

## 문제 해결

### DMG 빌드 실패 (hdiutil 에러)
이전 DMG가 마운트되어 있을 때 발생:
```bash
hdiutil detach "/Volumes/YouTube Music" -force
rm -rf dist/
npm run build
```

### gh 인증 만료
```bash
gh auth login
# GitHub.com → HTTPS → Login with a web browser
```

### 자동 업데이트 토큰 갱신
Fine-grained PAT 만료 시 새 토큰 생성 후 `main.js`의 토큰 교체 → 리빌드 & Release.
