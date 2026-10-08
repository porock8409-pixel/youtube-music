const { ipcRenderer, contextBridge } = require('electron')

// YouTube 플레이어 API(#movie_player의 메서드)와 페이지 전역은 메인 월드에만 있다.
// preload는 격리 월드라 여기서 직접 만지면 YouTube 스크립트에 안 보인다 → executeInMainWorld로 실행
let callPlayerWarned = false
function callPlayer(func, ...args) {
  try {
    return contextBridge.executeInMainWorld({ func, args })
  } catch (e) {
    if (!callPlayerWarned) {
      callPlayerWarned = true
      console.warn('[ytm] 메인 월드 호출 실패:', e && e.message)
    }
    return null
  }
}

// ─── 음악 전용 모드: 영상 화질을 가장 낮게 고정 ────────────
// 화면에 안 보여도 영상은 계속 받고 디코딩된다 → 최저 화질로 디코딩·트래픽·버퍼 메모리를 줄인다
let audioOnly = ipcRenderer.sendSync('config:get-audio-only') !== false

// ─── AV1 차단 (document-start, 음악 전용 모드가 꺼져 있을 때만) ───
// 영상을 제대로 볼 때 AV1 하드웨어 디코딩이 없는 PC(예: Ryzen 7730U의 Vega)에선 CPU가 소프트웨어로 디코딩한다
// → VP9/H.264를 고르게 한다. 144p에선 소프트웨어 디코딩 비용이 무시할 수준이고 오히려 GPU 디코더 메모리(~70MB)를 아낀다(실측).
// ⚠️ visible 위장(document.hidden)은 여기서 하지 않는다 — 로드 전부터 visible로 속이면, 창이 숨겨져
//    렌더링이 멈춘 동안 YouTube가 다음 곡으로 넘어가지 못하고 끝에서 멈춘다(실측). 위장은 main.js의 did-finish-load에서.
if (!audioOnly) {
  callPlayer(() => {
    const isAv1 = (type) => typeof type === 'string' && /av01/i.test(type)
    if (window.MediaSource && MediaSource.isTypeSupported) {
      const isTypeSupported = MediaSource.isTypeSupported.bind(MediaSource)
      MediaSource.isTypeSupported = (type) => (isAv1(type) ? false : isTypeSupported(type))
    }
    const canPlayType = HTMLMediaElement.prototype.canPlayType
    HTMLMediaElement.prototype.canPlayType = function (type) {
      return isAv1(type) ? '' : canPlayType.call(this, type)
    }
    if (navigator.mediaCapabilities && navigator.mediaCapabilities.decodingInfo) {
      const caps = navigator.mediaCapabilities
      const decodingInfo = caps.decodingInfo.bind(caps)
      caps.decodingInfo = (config) => (isAv1(config && config.video && config.video.contentType)
        ? Promise.resolve({ supported: false, smooth: false, powerEfficient: false })
        : decodingInfo(config))
    }
  })
}

// 곡마다 몇 번만 시도 — 광고·버퍼링 중엔 끝내 최저 화질로 안 보일 수 있어 2초마다 계속 바꾸지 않게
const QUALITY_MAX_TRIES = 3
let qualityTries = { videoId: '', count: 0 }

function applyVideoQuality() {
  if (!audioOnly) return
  if (document.querySelector('.ad-showing, .ad-interrupting')) return // 광고 화질은 건드리지 않음 (시도 횟수도 아낌)
  const videoId = getVideoId()
  if (qualityTries.videoId !== videoId) qualityTries = { videoId, count: 0 }
  if (qualityTries.count >= QUALITY_MAX_TRIES) return
  const changed = callPlayer(() => {
    const p = document.getElementById('movie_player')
    if (!p || typeof p.getAvailableQualityLevels !== 'function') return false
    const lowest = p.getAvailableQualityLevels().filter(q => q !== 'auto').pop()
    if (!lowest || p.getPlaybackQuality() === lowest) return false
    p.setPlaybackQualityRange(lowest, lowest)
    return true
  })
  if (changed) qualityTries.count++
}

ipcRenderer.on('set-audio-only', (_, active) => {
  audioOnly = active
  qualityTries = { videoId: '', count: 0 }
  if (active) {
    applyVideoQuality()
  } else {
    callPlayer(() => {
      const p = document.getElementById('movie_player')
      if (p && typeof p.setPlaybackQualityRange === 'function') p.setPlaybackQualityRange('auto', 'auto')
    })
  }
})

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
let lastVideoId = ''
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
  const match = url.match(/[?&]v=([^&#]+)/) || url.match(/\/watch\/([^?&#]+)/)
  return match ? match[1] : ''
}

// 플레이어가 아는 현재 영상 정보. 숨긴 창에선 YouTube가 제목 DOM을 다시 그리지 않으므로 이쪽이 우선
function readPlayerVideoData() {
  return callPlayer(() => {
    const p = document.getElementById('movie_player')
    if (!p || typeof p.getVideoData !== 'function') return null
    const d = p.getVideoData()
    return d ? { videoId: d.video_id || '', title: d.title || '', author: d.author || '' } : null
  })
}

function extractMetadata() {
  const videoId = getVideoId()
  let title, artist
  const playerData = videoId ? readPlayerVideoData() : null
  // 곡 전환 중(URL과 플레이어가 아직 다른 영상)이면 다음 주기에 다시 본다
  if (playerData && playerData.videoId && playerData.videoId !== videoId) return
  if (playerData && playerData.title) {
    title = playerData.title.trim()
    artist = playerData.author.trim()
  } else {
    title = queryFirst(SEL.title)?.textContent?.trim() || ''
    artist = queryFirst(SEL.artist)?.textContent?.trim() || ''
  }

  // 썸네일: videoId 기반 URL이 가장 확실 (SPA 네비게이션에서 og:image가 갱신 안 될 수 있음)
  let thumbnail = ''
  if (videoId) {
    thumbnail = `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`
  }

  if (title && (title !== lastTitle || artist !== lastArtist || videoId !== lastVideoId)) {
    lastTitle = title
    lastArtist = artist
    lastVideoId = videoId
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
    } else {
      watchStuckAtEnd(video)
    }
  })
  video.addEventListener('volumechange', () => emitVolumeState(video))
  video.addEventListener('loadedmetadata', () => {
    extractProgress()
    applyVideoQuality()
  })

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

// ─── 곡 끝 안전망 ────────────────────────────────────────
// 숨긴 창에서 YouTube가 곡 끝에서 다음 곡으로 못 넘어가는 경우가 있다 (한 번도 그려지지 않은 페이지).
// 정상이면 끝나고 1초 안에 넘어가므로, 3초째 그대로면 main에 알려 페이지를 한 번 그리게 한다.
// (YouTube가 끝난 영상을 0초로 되돌려 ended가 풀리기도 해서 paused로 본다 — 잘못 걸려도 3초 그리는 게 전부)
let stuckAtEndTimer = null

function watchStuckAtEnd(video) {
  const endedUrl = location.href
  clearTimeout(stuckAtEndTimer)
  stuckAtEndTimer = setTimeout(() => {
    if (customQueueActive || location.href !== endedUrl || !video.paused) return
    ipcRenderer.send('media:stuck-at-end')
  }, 3000)
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
// 숨겨진(안 그려진) 페이지에선 토글을 눌러도 aria-checked가 안 바뀐다 → 상태만 보고 계속 누르면
// YouTube 자동재생이 켜짐/꺼짐을 오가다 켜진 채 곡 끝을 가로채 큐가 멈춘다(실측). 페이지당 한 번만 끈다
let autonavOffClicked = false
ipcRenderer.on('set-custom-queue', (_, active) => {
  if (active !== customQueueActive) autonavOffClicked = false
  customQueueActive = active
})

// ─── YouTube 자동재생 강제 활성화 ─────────────────────────
let autoplayChecked = false

function ensureAutoplay() {
  // 데스크톱 YouTube 자동재생 토글 버튼
  const toggleBtn = document.querySelector('.ytp-autonav-toggle-button')
  if (!toggleBtn) return
  const isOn = toggleBtn.getAttribute('aria-checked') === 'true'

  if (customQueueActive) {
    // 커스텀 큐 활성 시 YouTube 자동재생 강제 OFF — 우리 큐가 다음 곡 결정
    if (isOn && !autonavOffClicked) {
      toggleBtn.click()
      autonavOffClicked = true
    }
    return
  }

  if (autoplayChecked) return
  if (!isOn) toggleBtn.click()
  autoplayChecked = true
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
    applyVideoQuality()
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
