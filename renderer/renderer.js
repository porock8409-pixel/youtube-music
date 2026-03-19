// ─── 플랫폼 감지 ─────────────────────────────
const isMac = navigator.platform.includes('Mac') || navigator.userAgent.includes('Macintosh')
if (isMac) {
  document.body.classList.add('platform-darwin')
  // macOS 단축키 레이블
  const lyricsBtn = document.getElementById('btn-lyrics')
  if (lyricsBtn) lyricsBtn.title = '가사 (⌘L)'
}

// ─── 타이틀바 컨트롤 ──────────────────────────
document.getElementById('btn-back')?.addEventListener('click', () => window.electronAPI.goBack())
document.getElementById('btn-forward')?.addEventListener('click', () => window.electronAPI.goForward())
document.getElementById('btn-home')?.addEventListener('click', () => window.electronAPI.goHome())
document.getElementById('btn-lyrics')?.addEventListener('click', () => window.electronAPI.toggleLyrics())

document.getElementById('btn-minimize')?.addEventListener('click', () => window.electronAPI.minimize())
document.getElementById('btn-maximize')?.addEventListener('click', () => window.electronAPI.maximize())
document.getElementById('btn-close')?.addEventListener('click', () => window.electronAPI.close())

// 최대화 상태 시 버튼 아이콘 변경
window.electronAPI.onMaximized?.((isMax) => {
  const btn = document.getElementById('btn-maximize')
  if (!btn) return
  if (isMax) {
    btn.innerHTML = `<svg viewBox="0 0 12 12" width="12" height="12" fill="currentColor">
      <rect x="2.5" y="0" width="9" height="9" stroke="currentColor" stroke-width="1.2" fill="none"/>
      <rect x="0" y="2.5" width="9" height="9" stroke="currentColor" stroke-width="1.2" fill="#212121"/>
    </svg>`
    btn.title = '이전 크기로 복원'
  } else {
    btn.innerHTML = `<svg viewBox="0 0 12 12" width="12" height="12" fill="currentColor">
      <rect x="1" y="1" width="10" height="10" stroke="currentColor" stroke-width="1.5" fill="none"/>
    </svg>`
    btn.title = '최대화'
  }
})

// ─── 가사 패널 ──────────────────────────────────
const lyricsPanel = document.getElementById('lyrics-panel')
const lyricsBody = document.getElementById('lyrics-body')
const lyricsSource = document.getElementById('lyrics-source')
const btnLyrics = document.getElementById('btn-lyrics')
let currentSyncedLyrics = null

window.electronAPI.onLyricsVisibility?.((visible) => {
  if (visible) {
    lyricsPanel.classList.remove('hidden')
    btnLyrics?.classList.add('active')
  } else {
    lyricsPanel.classList.add('hidden')
    btnLyrics?.classList.remove('active')
  }
})

window.electronAPI.onLyricsUpdate?.((data) => {
  if (!data) {
    lyricsBody.innerHTML = '<div class="lyrics-placeholder">가사를 찾을 수 없습니다</div>'
    lyricsSource.textContent = ''
    currentSyncedLyrics = null
    return
  }

  lyricsSource.textContent = data.source || ''
  currentSyncedLyrics = data.synced || null

  if (data.synced) {
    lyricsBody.innerHTML = data.synced
      .map((line, i) => `<div class="lyrics-line" data-index="${i}" data-time="${line.time}">${line.text}</div>`)
      .join('')
  } else if (data.plain) {
    lyricsBody.innerHTML = data.plain
      .split('\n')
      .filter(l => l.trim())
      .map(l => `<div class="lyrics-line past">${l}</div>`)
      .join('')
    currentSyncedLyrics = null
  } else {
    lyricsBody.innerHTML = '<div class="lyrics-placeholder">가사를 찾을 수 없습니다</div>'
    currentSyncedLyrics = null
  }
})

// 가사 클릭 시 해당 시점으로 이동
lyricsBody.addEventListener('click', (e) => {
  const line = e.target.closest('.lyrics-line[data-time]')
  if (!line) return
  const time = parseFloat(line.dataset.time)
  if (!isNaN(time)) window.electronAPI.seekTo(time)
})

window.electronAPI.onMediaProgress?.((data) => {
  if (!currentSyncedLyrics) return

  const currentTime = data.currentTime
  let activeIndex = -1

  for (let i = currentSyncedLyrics.length - 1; i >= 0; i--) {
    if (currentTime >= currentSyncedLyrics[i].time) {
      activeIndex = i
      break
    }
  }

  const lines = lyricsBody.querySelectorAll('.lyrics-line')
  lines.forEach((el, i) => {
    el.classList.remove('active', 'past')
    if (i === activeIndex) {
      el.classList.add('active')
    } else if (i < activeIndex) {
      el.classList.add('past')
    }
  })

  // 현재 가사 라인 자동 스크롤
  if (activeIndex >= 0 && lines[activeIndex]) {
    const line = lines[activeIndex]
    const container = lyricsBody
    const lineTop = line.offsetTop - container.offsetTop
    const scrollTo = lineTop - container.clientHeight / 3
    container.scrollTo({ top: scrollTo, behavior: 'smooth' })
  }
})

// [DEBUG] 타이틀바에 창 크기 표시
const winSizeEl = document.getElementById('win-size')
function updateWinSize() {
  if (winSizeEl) winSizeEl.textContent = `${window.outerWidth}×${window.outerHeight}`
}
window.addEventListener('resize', updateWinSize)
updateWinSize()
