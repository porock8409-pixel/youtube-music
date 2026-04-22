const { ipcRenderer } = require('electron')

// ─── Page Visibility API 우회 (최소화해도 재생 유지) ───

Object.defineProperty(document, 'hidden', { get: () => false })
Object.defineProperty(document, 'visibilityState', { get: () => 'visible' })
document.addEventListener('visibilitychange', (e) => {
  e.stopImmediatePropagation()
}, true)

// ─── 리사이즈 시 재생 상태 보호 ─────────────────────────
// HTMLMediaElement.prototype.pause를 글로벌 오버라이드
// → video 요소가 재생성되어도 보호됨
const _originalPause = HTMLMediaElement.prototype.pause
let _isResizing = false
let _resizeEndTimer = null

HTMLMediaElement.prototype.pause = function (...args) {
  if (_isResizing) return // 리사이즈 중 pause 차단
  return _originalPause.apply(this, args)
}

// main.js에서 setBounds 직전에 호출하는 리사이즈 신호
window._ytmResizing = () => {
  _isResizing = true
  if (_resizeEndTimer) clearTimeout(_resizeEndTimer)
  _resizeEndTimer = setTimeout(() => { _isResizing = false }, 3000)
}

window.addEventListener('resize', () => {
  _isResizing = true
  if (_resizeEndTimer) clearTimeout(_resizeEndTimer)
  _resizeEndTimer = setTimeout(() => { _isResizing = false }, 3000)
}, true)

// ─── 데스크톱 YouTube (www.youtube.com) DOM 감시 ───

let lastTitle = ''
let lastArtist = ''
let lastIsPlaying = null

// 데스크톱 YouTube 셀렉터
const SEL = {
  // 재생 페이지 제목
  title: [
    'h1.ytd-watch-metadata yt-formatted-string',     // 데스크톱 재생 페이지
    '#title h1 yt-formatted-string',
    'h1.title.ytd-video-primary-info-renderer',
    '#info-contents h1 yt-formatted-string',
    'ytd-watch-metadata h1',
  ],
  // 채널명/아티스트
  artist: [
    'ytd-channel-name#channel-name yt-formatted-string a',  // 데스크톱 채널명
    '#channel-name a',
    'ytd-video-owner-renderer #channel-name a',
    '#upload-info #channel-name a',
    '.ytd-channel-name a',
  ],
  // 썸네일
  thumbnail: [
    '#movie_player .ytp-cued-thumbnail-overlay-image',
  ],
  video: 'video',
}

function queryFirst(selectors) {
  if (typeof selectors === 'string') return document.querySelector(selectors)
  for (const sel of selectors) {
    const el = document.querySelector(sel)
    if (el) return el
  }
  return null
}

function getVideoId() {
  const url = window.location.href
  const match = url.match(/[?&]v=([^&]+)/) || url.match(/\/watch\/([^?&]+)/)
  return match ? match[1] : ''
}

function extractMetadata() {
  const titleEl = queryFirst(SEL.title)
  const artistEl = queryFirst(SEL.artist)

  const title = titleEl?.textContent?.trim() || ''
  const artist = artistEl?.textContent?.trim() || ''
  const videoId = getVideoId()

  // 썸네일: videoId 기반 URL이 가장 확실 (SPA 네비게이션에서 og:image가 갱신 안 될 수 있음)
  let thumbnail = ''
  if (videoId) {
    thumbnail = `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`
  }

  if (title && (title !== lastTitle || artist !== lastArtist)) {
    lastTitle = title
    lastArtist = artist
    autoplayChecked = false // 곡이 바뀌면 자동재생 재확인
    ipcRenderer.send('media:metadata-changed', { title, artist, thumbnail, videoId })
  }
}

let lastIsMuted = null
let lastVolume = null

function emitVolumeState(video) {
  const isMuted = video.muted || video.volume === 0
  if (isMuted !== lastIsMuted) {
    lastIsMuted = isMuted
    ipcRenderer.send('media:mute-changed', { isMuted })
  }
  const volume = Math.round(video.volume * 100)
  if (volume !== lastVolume) {
    lastVolume = volume
    ipcRenderer.send('media:volume-changed', { volume })
  }
}

function extractProgress() {
  const video = document.querySelector('video')
  if (!video || !video.duration || isNaN(video.duration)) return

  ipcRenderer.send('media:progress', {
    currentTime: video.currentTime,
    duration: video.duration,
    percent: (video.currentTime / video.duration) * 100
  })
}

// ─── 플레이리스트 감지 ────────────────────────────────────
let lastPlaylistInfo = ''

function extractPlaylistInfo() {
  // URL에서 list 파라미터 확인
  const url = window.location.href
  const hasPlaylist = url.includes('list=')
  if (!hasPlaylist) {
    if (lastPlaylistInfo !== '') {
      lastPlaylistInfo = ''
      ipcRenderer.send('media:playlist', null)
    }
    return
  }

  // 데스크톱 YouTube 플레이리스트 카운터 셀렉터
  const counterSelectors = [
    '#publisher-container .index-message',             // "1 / 50" 형식
    'ytd-playlist-panel-renderer .index-message',
    '#playlist .index-message-wrapper',
    'yt-formatted-string.index-message',
  ]

  let current = 0, total = 0

  for (const sel of counterSelectors) {
    const el = document.querySelector(sel)
    if (el) {
      const text = el.textContent.trim()
      // "1/50", "1 / 50", "1 of 50" 등 파싱
      const match = text.match(/(\d+)\s*[\/of]\s*(\d+)/)
      if (match) {
        current = parseInt(match[1])
        total = parseInt(match[2])
        break
      }
    }
  }

  // DOM에서 못 찾으면 URL의 index 파라미터로 시도
  if (!current) {
    const indexMatch = url.match(/[?&]index=(\d+)/)
    if (indexMatch) current = parseInt(indexMatch[1])
  }

  // URL에서 playlistId 추출
  const listMatch = url.match(/[?&]list=([^&]+)/)
  const playlistId = listMatch ? listMatch[1] : ''

  const info = JSON.stringify({ current, total, playlistId })
  if (info !== lastPlaylistInfo) {
    lastPlaylistInfo = info
    ipcRenderer.send('media:playlist', { current, total, playlistId })
  }
}

// ─── DOM 감시 시작 ────────────────────────────────────────

function attachVideoListeners() {
  const video = document.querySelector('video')
  if (!video || video._ytmListenerAttached) return
  video._ytmListenerAttached = true

  video.addEventListener('play', () => {
    lastIsPlaying = true
    ipcRenderer.send('media:state-changed', { isPlaying: true })
  })
  video.addEventListener('pause', () => {
    lastIsPlaying = false
    ipcRenderer.send('media:state-changed', { isPlaying: false })
  })
  video.addEventListener('ended', () => {
    if (customQueueActive) {
      ipcRenderer.send('media:ended')
    }
  })
  video.addEventListener('volumechange', () => emitVolumeState(video))
  video.addEventListener('loadedmetadata', () => extractProgress())

  // 진행률: timeupdate 이벤트 기반 (500ms throttle — 기존 0.5초 폴링과 동일한 빈도이지만 DOM 재쿼리 없음)
  let lastProgressSent = 0
  video.addEventListener('timeupdate', () => {
    const now = Date.now()
    if (now - lastProgressSent < 500) return
    lastProgressSent = now
    extractProgress()
  })

  // 초기 상태 동기화 (이미 재생 중이거나 볼륨이 설정된 상태로 video가 생성된 경우)
  emitVolumeState(video)
  if (!video.paused && lastIsPlaying !== true) {
    lastIsPlaying = true
    ipcRenderer.send('media:state-changed', { isPlaying: true })
  }
}

// ─── 광고 자동 스킵 ──────────────────────────────────────

let lastAdState = false

function skipAds() {
  // 광고 상태 감지 → main으로 전달
  const adShowing = !!document.querySelector('.ad-showing, .ad-interrupting')
  if (adShowing !== lastAdState) {
    lastAdState = adShowing
    ipcRenderer.send('media:ad-state', { adShowing })
  }

  // 1) "광고 건너뛰기" 버튼 클릭
  const skipSelectors = [
    '.ytp-skip-ad-button',
    '.ytp-ad-skip-button',
    '.ytp-ad-skip-button-modern',
    'button.ytp-ad-skip-button',
    '.ytp-skip-ad button',
    '[id^="skip-button"]',
    '.ytp-ad-skip-button-container button',
  ]
  for (const sel of skipSelectors) {
    const btn = document.querySelector(sel)
    if (btn && btn.offsetParent !== null) {
      btn.click()
      return
    }
  }

  // 2) 광고 재생 중이면 video를 끝으로 보내서 스킵
  const adOverlay = document.querySelector('.ad-showing, .ad-interrupting')
  if (adOverlay) {
    const video = document.querySelector('video')
    if (video && video.duration && isFinite(video.duration)) {
      video.currentTime = video.duration
    }
  }
}

// ─── 커스텀 큐 모드 (자동재생 제어) ─────────────────────────
let customQueueActive = false
ipcRenderer.on('set-custom-queue', (_, active) => { customQueueActive = active })

// ─── YouTube 자동재생 강제 활성화 ─────────────────────────
let autoplayChecked = false

function ensureAutoplay() {
  if (customQueueActive) return  // 커스텀 큐 활성 시 YouTube 자동재생 비활성화
  if (autoplayChecked) return
  // 데스크톱 YouTube 자동재생 토글 버튼
  const toggleBtn = document.querySelector('.ytp-autonav-toggle-button')
  if (toggleBtn) {
    const isOn = toggleBtn.getAttribute('aria-checked') === 'true'
    if (!isOn) {
      toggleBtn.click()
    }
    autoplayChecked = true
  }
}

function startObserving() {
  // 재생상태/볼륨/진행률은 video element 이벤트로 이동 → 더 이상 폴링 대상 아님
  // 메타/플레이리스트/광고/자동재생은 2초 폴링 유지 (1초 → 2초)
  //  · YouTube SPA는 DOM mutation을 초당 수백 번 발생시켜 MutationObserver가 오히려 CPU를 더 쓸 수 있음
  //  · attachVideoListeners는 여기서도 호출 — video 요소가 SPA 전환으로 재생성되면 새 요소에 리스너 재부착
  setInterval(() => {
    attachVideoListeners()
    extractMetadata()
    extractPlaylistInfo()
    skipAds()
    ensureAutoplay()
  }, 2000)

  // SPA 네비게이션 즉시 반응 — URL 변경 시 자동재생 플래그 리셋 + 메타 재검사
  const onLocationChange = () => {
    autoplayChecked = false
    setTimeout(() => {
      attachVideoListeners()
      extractMetadata()
      extractPlaylistInfo()
      ensureAutoplay()
    }, 300)
  }
  const origPushState = history.pushState
  history.pushState = function (...args) {
    const result = origPushState.apply(this, args)
    onLocationChange()
    return result
  }
  const origReplaceState = history.replaceState
  history.replaceState = function (...args) {
    const result = origReplaceState.apply(this, args)
    onLocationChange()
    return result
  }
  window.addEventListener('popstate', onLocationChange)

  // 첫 실행 즉시 1회
  attachVideoListeners()
  extractMetadata()
  extractPlaylistInfo()
}

// 페이지 로드 후 시작 (SPA 네비게이션 고려하여 지연)
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => setTimeout(startObserving, 2000))
} else {
  setTimeout(startObserving, 2000)
}

// ─── Main → YouTube 명령 수신 ─────────────────────────────

ipcRenderer.on('control:play-pause', () => {
  const video = document.querySelector('video')
  if (video) {
    video.paused ? video.play() : video.pause()
  }
})

ipcRenderer.on('control:next', () => {
  // 데스크톱 YouTube "다음" 버튼 직접 클릭 (즉시 전환)
  const nextSelectors = [
    '.ytp-next-button',
    'a.ytp-next-button',
    'button[aria-label="Next"]',
    'button[aria-label="다음"]',
  ]
  for (const sel of nextSelectors) {
    const btn = document.querySelector(sel)
    if (btn && btn.offsetParent !== null) { btn.click(); return }
  }
  // 폴백: 비디오 끝으로 보내기
  const video = document.querySelector('video')
  if (video && video.duration) {
    video.currentTime = video.duration
  }
})

ipcRenderer.on('control:mute-toggle', () => {
  const video = document.querySelector('video')
  if (video) {
    if (video.volume === 0) {
      video.volume = 1
    }
    video.muted = !video.muted
  }
})

ipcRenderer.on('control:volume', (_, vol) => {
  const video = document.querySelector('video')
  if (video) {
    video.volume = vol / 100
    if (vol > 0 && video.muted) video.muted = false
  }
})

ipcRenderer.on('control:prev', () => {
  const selectors = [
    '.ytp-prev-button',                              // 데스크톱 이전 버튼
    'a.ytp-prev-button',
    'button[aria-label="Previous"]',
    'button[aria-label="이전"]',
    '.ytp-left-controls .ytp-prev-button',
  ]
  let clicked = false
  for (const sel of selectors) {
    const btn = document.querySelector(sel)
    if (btn) { btn.click(); clicked = true; break }
  }
  // 폴백: 영상 처음으로 되감기
  if (!clicked) {
    const video = document.querySelector('video')
    if (video) video.currentTime = 0
  }
})
