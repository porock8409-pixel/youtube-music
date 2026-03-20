const { app, BrowserWindow, BrowserView, Tray, Menu, ipcMain, globalShortcut, nativeImage, session, net, clipboard, dialog } = require('electron')
const crypto = require('crypto')
const path = require('path')
const fs = require('fs')
const https = require('https')
const http = require('http')

// ─── Performance: V8 메모리 제한 & GPU 최적화 ────────────
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=128')
app.commandLine.appendSwitch('disable-gpu-compositing')        // GPU 메모리 절약
app.commandLine.appendSwitch('disable-software-rasterizer')    // 소프트웨어 래스터라이저 비활성
app.commandLine.appendSwitch('disable-background-timer-throttling') // 백그라운드 타이머 유지 (음악 재생)
app.commandLine.appendSwitch('disable-renderer-backgrounding')      // 렌더러 백그라운드 제한 해제

// ─── Simple Config Store ──────────────────────────────────

const DEFAULTS = {
  window: { width: 380, height: 500 },
  miniPlayer: { visible: false, position: 'bottom-left', marquee: true, marqueeSpeed: 20, opacity: 1.0 },
  startUrl: 'https://www.youtube.com',
  closeToTray: true
}

let configPath
let config = { ...DEFAULTS }

function loadConfig() {
  configPath = path.join(app.getPath('userData'), 'config.json')
  try {
    if (fs.existsSync(configPath)) {
      config = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(configPath, 'utf8')) }
    }
  } catch {
    config = { ...DEFAULTS }
  }
  // 모바일 → 데스크톱 URL 마이그레이션
  if (config.startUrl?.includes('m.youtube.com')) {
    config.startUrl = 'https://www.youtube.com'
    saveConfig()
  }
}

function saveConfig() {
  try {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8')
  } catch { /* ignore */ }
}

function getConfig(key) {
  return key.split('.').reduce((obj, k) => obj?.[k], config)
}

function setConfig(key, value) {
  const keys = key.split('.')
  let obj = config
  for (let i = 0; i < keys.length - 1; i++) {
    if (!obj[keys[i]]) obj[keys[i]] = {}
    obj = obj[keys[i]]
  }
  obj[keys[keys.length - 1]] = value
  saveConfig()
}

// ─── Lyrics Sync Offset (곡별 가사 싱크 보정) ────────────

let lyricsSyncPath
let lyricsSync = {} // { [videoId]: offsetSeconds }

function loadLyricsSync() {
  lyricsSyncPath = path.join(app.getPath('userData'), 'lyrics-sync.json')
  try {
    if (fs.existsSync(lyricsSyncPath)) {
      lyricsSync = JSON.parse(fs.readFileSync(lyricsSyncPath, 'utf8'))
    }
  } catch { lyricsSync = {} }
}

function saveLyricsSync() {
  try {
    fs.writeFileSync(lyricsSyncPath, JSON.stringify(lyricsSync), 'utf8')
  } catch {}
}

function getSyncOffset(videoId) {
  return lyricsSync[videoId] || 0
}

function setSyncOffset(videoId, offset) {
  if (offset === 0) {
    delete lyricsSync[videoId]
  } else {
    lyricsSync[videoId] = Math.round(offset * 10) / 10 // 0.1초 단위
  }
  saveLyricsSync()
}

// ─── Lyrics Selection Memory (곡별 가사 선택 기억) ────────

let lyricsSelectionPath
let lyricsSelections = {} // { [videoId]: { source: 'lrclib'|'netease', id: number|string } }

function loadLyricsSelection() {
  lyricsSelectionPath = path.join(app.getPath('userData'), 'lyrics-selection.json')
  try {
    if (fs.existsSync(lyricsSelectionPath)) {
      lyricsSelections = JSON.parse(fs.readFileSync(lyricsSelectionPath, 'utf8'))
    }
  } catch { lyricsSelections = {} }
}

function saveLyricsSelection(videoId, source, id) {
  lyricsSelections[videoId] = { source, id }
  // 최대 500개 유지 (FIFO 제거)
  const keys = Object.keys(lyricsSelections)
  if (keys.length > 500) {
    delete lyricsSelections[keys[0]]
  }
  try {
    fs.writeFileSync(lyricsSelectionPath, JSON.stringify(lyricsSelections), 'utf8')
  } catch {}
}

function getSavedLyricsSelection(videoId) {
  return lyricsSelections[videoId] || null
}

async function fetchLyricsById(source, id) {
  try {
    if (source === 'lrclib') {
      const res = await net.fetch(`https://lrclib.net/api/get/${id}`, {
        headers: { 'User-Agent': 'YouTubeMusic Desktop App/1.0' }
      })
      const r = await res.json()
      const lyrics = { plain: r.plainLyrics || '', synced: null, source: 'lrclib' }
      if (r.syncedLyrics) lyrics.synced = parseLRC(r.syncedLyrics)
      return lyrics
    }
    if (source === 'netease') {
      return await neteaseLyrics(id)
    }
  } catch {}
  return null
}

// ─── Song History ─────────────────────────────────────────

let historyPath
let songHistory = []
const MAX_HISTORY = 50

function loadHistory() {
  historyPath = path.join(app.getPath('userData'), 'history.json')
  try {
    if (fs.existsSync(historyPath)) {
      songHistory = JSON.parse(fs.readFileSync(historyPath, 'utf8'))
    }
  } catch { songHistory = [] }
}

function saveHistory() {
  try {
    fs.writeFileSync(historyPath, JSON.stringify(songHistory), 'utf8')
  } catch {}
}

function addToHistory(song) {
  if (!song.videoId || !song.title) return
  songHistory = songHistory.filter(s => s.videoId !== song.videoId)
  // 플레이리스트 재생 중이면 list= 파라미터 포함
  let url = `https://www.youtube.com/watch?v=${song.videoId}`
  if (currentPlaylist?.playlistId) {
    url += `&list=${currentPlaylist.playlistId}`
  }
  songHistory.unshift({
    title: song.title,
    artist: song.artist || '',
    thumbnail: song.thumbnail || '',
    videoId: song.videoId,
    url,
    playedAt: Date.now()
  })
  if (songHistory.length > MAX_HISTORY) songHistory = songHistory.slice(0, MAX_HISTORY)
  saveHistory()
  // 확장 모드 미니플레이어에 전송
  if (miniPlayerWindow && !miniPlayerWindow.isDestroyed() && miniPlayerMode === 'expanded') {
    miniPlayerWindow.webContents.send('mini:history', songHistory.slice(0, 8))
  }
}

// ─── Multi-Playlist Manager ──────────────────────────────

let playlistsPath
let playlists = []              // Playlist[]
let activePlaylistId = null     // 현재 선택된 재생목록 ID
let activePlaylistIndex = -1    // 현재 재생 중인 곡 인덱스
let playlistQueueActive = false // 재생목록 모드 활성 여부

function loadPlaylists() {
  playlistsPath = path.join(app.getPath('userData'), 'playlists.json')
  try {
    if (fs.existsSync(playlistsPath)) {
      const data = JSON.parse(fs.readFileSync(playlistsPath, 'utf8'))
      playlists = data.playlists || []
      activePlaylistId = data.activePlaylistId || null
    } else {
      // 마이그레이션: 기존 queue.json → playlists.json
      migrateQueueToPlaylists()
    }
  } catch {
    playlists = []
    activePlaylistId = null
  }
}

function savePlaylists() {
  try {
    const data = { version: 1, activePlaylistId, playlists }
    fs.writeFileSync(playlistsPath, JSON.stringify(data, null, 2), 'utf8')
  } catch {}
}

function migrateQueueToPlaylists() {
  const queuePath = path.join(app.getPath('userData'), 'queue.json')
  try {
    if (fs.existsSync(queuePath)) {
      const queue = JSON.parse(fs.readFileSync(queuePath, 'utf8'))
      if (Array.isArray(queue) && queue.length > 0) {
        const id = crypto.randomUUID()
        playlists = [{
          id,
          name: '내 재생목록',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          songs: queue.map(s => ({
            videoId: s.videoId,
            title: s.title,
            artist: s.artist || '',
            thumbnail: s.thumbnail || '',
            url: s.url || `https://www.youtube.com/watch?v=${s.videoId}`
          }))
        }]
        activePlaylistId = id
      }
      // 백업
      fs.renameSync(queuePath, queuePath + '.bak')
    }
  } catch {}
  savePlaylists()
}

function getActivePlaylist() {
  if (!activePlaylistId) return null
  return playlists.find(p => p.id === activePlaylistId) || null
}

function getActivePlaylistSongs() {
  return getActivePlaylist()?.songs || []
}

function setPlaylistQueueActive(active) {
  playlistQueueActive = active
  if (youtubeView && !youtubeView.webContents.isDestroyed()) {
    youtubeView.webContents.send('set-custom-queue', active)
  }
}

// ─── Playlist CRUD ───

function createPlaylist(name) {
  const pl = {
    id: crypto.randomUUID(),
    name: (name || '').trim().slice(0, 50) || `새 재생목록 ${playlists.length + 1}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    songs: []
  }
  playlists.push(pl)
  if (!activePlaylistId) activePlaylistId = pl.id
  savePlaylists()
  broadcastPlaylistUpdate()
  return pl
}

function renamePlaylist(id, newName) {
  const pl = playlists.find(p => p.id === id)
  if (!pl) return
  pl.name = (newName || '').trim().slice(0, 50) || pl.name
  pl.updatedAt = new Date().toISOString()
  savePlaylists()
  broadcastPlaylistUpdate()
  updateTrayMenu()
}

function deletePlaylist(id) {
  const idx = playlists.findIndex(p => p.id === id)
  if (idx < 0) return
  playlists.splice(idx, 1)
  if (activePlaylistId === id) {
    activePlaylistId = playlists.length > 0 ? playlists[0].id : null
    activePlaylistIndex = -1
    setPlaylistQueueActive(false)
  }
  savePlaylists()
  broadcastPlaylistUpdate()
  updateTrayMenu()
}

function duplicatePlaylist(id, newName) {
  const src = playlists.find(p => p.id === id)
  if (!src) return
  const pl = {
    id: crypto.randomUUID(),
    name: (newName || '').trim().slice(0, 50) || `${src.name} (복사)`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    songs: src.songs.map(s => ({ ...s }))
  }
  playlists.push(pl)
  savePlaylists()
  broadcastPlaylistUpdate()
}

// ─── Song Management ───

function addSongToPlaylist(playlistId, song) {
  const pl = playlists.find(p => p.id === playlistId)
  if (!pl || !song.videoId || !song.title) return
  if (pl.songs.length >= 500) return
  if (pl.songs.some(s => s.videoId === song.videoId)) return
  const url = song.url || `https://www.youtube.com/watch?v=${song.videoId}`
  pl.songs.push({
    videoId: song.videoId,
    title: song.title,
    artist: song.artist || '',
    thumbnail: song.thumbnail || `https://i.ytimg.com/vi/${song.videoId}/mqdefault.jpg`,
    url
  })
  pl.updatedAt = new Date().toISOString()
  savePlaylists()
  // 활성 재생목록에 추가 시 자동 활성화
  if (playlistId === activePlaylistId && !playlistQueueActive) {
    setPlaylistQueueActive(true)
  }
  broadcastPlaylistUpdate()
}

function addBulkSongsToPlaylist(playlistId, songs) {
  const pl = playlists.find(p => p.id === playlistId)
  if (!pl || !Array.isArray(songs)) return
  let added = 0
  for (const song of songs) {
    if (!song.videoId || !song.title) continue
    if (pl.songs.length >= 500) break
    if (pl.songs.some(s => s.videoId === song.videoId)) continue
    const url = song.url || `https://www.youtube.com/watch?v=${song.videoId}`
    pl.songs.push({
      videoId: song.videoId,
      title: song.title,
      artist: song.artist || '',
      thumbnail: song.thumbnail || `https://i.ytimg.com/vi/${song.videoId}/mqdefault.jpg`,
      url
    })
    added++
  }
  if (added > 0) {
    pl.updatedAt = new Date().toISOString()
    savePlaylists()
    if (playlistId === activePlaylistId && !playlistQueueActive) {
      setPlaylistQueueActive(true)
    }
    broadcastPlaylistUpdate()
  }
}

function removeSongFromPlaylist(playlistId, videoId) {
  const pl = playlists.find(p => p.id === playlistId)
  if (!pl) return
  const idx = pl.songs.findIndex(s => s.videoId === videoId)
  if (idx < 0) return
  pl.songs.splice(idx, 1)
  pl.updatedAt = new Date().toISOString()
  // 활성 재생목록이면 인덱스 조정
  if (playlistId === activePlaylistId) {
    if (idx < activePlaylistIndex) activePlaylistIndex--
    else if (idx === activePlaylistIndex) activePlaylistIndex = Math.min(activePlaylistIndex, pl.songs.length - 1)
    if (pl.songs.length === 0) {
      setPlaylistQueueActive(false)
      activePlaylistIndex = -1
    }
  }
  savePlaylists()
  broadcastPlaylistUpdate()
}

function reorderSong(playlistId, fromIdx, toIdx) {
  const pl = playlists.find(p => p.id === playlistId)
  if (!pl) return
  if (fromIdx < 0 || fromIdx >= pl.songs.length) return
  if (toIdx < 0 || toIdx >= pl.songs.length) return
  const [song] = pl.songs.splice(fromIdx, 1)
  pl.songs.splice(toIdx, 0, song)
  pl.updatedAt = new Date().toISOString()
  // 인덱스 조정
  if (playlistId === activePlaylistId && activePlaylistIndex >= 0) {
    if (activePlaylistIndex === fromIdx) activePlaylistIndex = toIdx
    else if (fromIdx < activePlaylistIndex && toIdx >= activePlaylistIndex) activePlaylistIndex--
    else if (fromIdx > activePlaylistIndex && toIdx <= activePlaylistIndex) activePlaylistIndex++
  }
  savePlaylists()
  broadcastPlaylistUpdate()
}

function clearPlaylistSongs(playlistId) {
  const pl = playlists.find(p => p.id === playlistId)
  if (!pl) return
  pl.songs = []
  pl.updatedAt = new Date().toISOString()
  if (playlistId === activePlaylistId) {
    activePlaylistIndex = -1
    setPlaylistQueueActive(false)
  }
  savePlaylists()
  broadcastPlaylistUpdate()
}

// ─── Playlist Playback ───

function selectPlaylist(id) {
  if (!playlists.some(p => p.id === id)) return
  activePlaylistId = id
  activePlaylistIndex = -1
  savePlaylists()
  broadcastPlaylistUpdate()
  updateTrayMenu()
}

function playFromPlaylist(index) {
  const pl = getActivePlaylist()
  if (!pl || index < 0 || index >= pl.songs.length) return
  activePlaylistIndex = index
  const song = pl.songs[index]
  if (!playlistQueueActive) setPlaylistQueueActive(true)
  currentMedia = {
    ...currentMedia,
    title: song.title,
    artist: song.artist || '',
    thumbnail: song.thumbnail || '',
    videoId: song.videoId,
    isPlaying: true
  }
  updateTrayMenu()
  if (miniPlayerWindow && !miniPlayerWindow.isDestroyed()) {
    miniPlayerWindow.webContents.send('media:update', currentMedia)
  }
  if (miniLyricsPopup && !miniLyricsPopup.isDestroyed()) {
    miniLyricsPopup.webContents.send('media:update', currentMedia)
  }
  searchAndSendLyrics(song.title, song.artist || '')
  addToHistory(song)
  sendFavoriteState(song.videoId)
  navigateToUrl(song.url)
  broadcastPlaylistUpdate()
}

function playNextInPlaylist() {
  const pl = getActivePlaylist()
  if (!pl || !pl.songs.length) return
  const nextIdx = activePlaylistIndex + 1
  playFromPlaylist(nextIdx >= pl.songs.length ? 0 : nextIdx)
}

function playPrevInPlaylist() {
  const pl = getActivePlaylist()
  if (!pl || !pl.songs.length) return
  const prevIdx = activePlaylistIndex - 1
  playFromPlaylist(prevIdx < 0 ? pl.songs.length - 1 : prevIdx)
}

// ─── Export / Import ───

async function exportPlaylist(id) {
  const pl = playlists.find(p => p.id === id)
  if (!pl) return
  const result = await dialog.showSaveDialog({
    defaultPath: `${pl.name}.ytpl.json`,
    filters: [{ name: 'Playlist', extensions: ['ytpl.json', 'json'] }]
  })
  if (result.canceled || !result.filePath) return
  const exportData = {
    format: 'ytm-playlist',
    version: 1,
    exportedAt: new Date().toISOString(),
    playlist: {
      name: pl.name,
      songs: pl.songs.map(s => ({
        videoId: s.videoId, title: s.title, artist: s.artist, url: s.url
      }))
    }
  }
  try {
    fs.writeFileSync(result.filePath, JSON.stringify(exportData, null, 2), 'utf8')
  } catch {}
}

async function importPlaylist() {
  const result = await dialog.showOpenDialog({
    filters: [{ name: 'Playlist', extensions: ['json'] }],
    properties: ['openFile']
  })
  if (result.canceled || !result.filePaths?.length) return
  try {
    const raw = fs.readFileSync(result.filePaths[0], 'utf8')
    const data = JSON.parse(raw)
    if (data.format !== 'ytm-playlist' || !data.playlist) return
    const imported = data.playlist
    const pl = {
      id: crypto.randomUUID(),
      name: (imported.name || '가져온 재생목록').slice(0, 50),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      songs: (imported.songs || []).filter(s => s.videoId && s.title).map(s => ({
        videoId: s.videoId,
        title: s.title,
        artist: s.artist || '',
        thumbnail: `https://i.ytimg.com/vi/${s.videoId}/mqdefault.jpg`,
        url: s.url || `https://www.youtube.com/watch?v=${s.videoId}`
      }))
    }
    playlists.push(pl)
    if (!activePlaylistId) activePlaylistId = pl.id
    savePlaylists()
    broadcastPlaylistUpdate()
    updateTrayMenu()
  } catch {}
}

// ─── Broadcast ───

function broadcastPlaylistUpdate() {
  const activePl = getActivePlaylist()
  const data = {
    playlists: playlists.map(p => ({ id: p.id, name: p.name, songCount: p.songs.length })),
    activePlaylistId,
    activePlaylist: activePl || null,
    currentIndex: activePlaylistIndex,
    active: playlistQueueActive
  }
  if (miniLyricsPopup && !miniLyricsPopup.isDestroyed()) {
    miniLyricsPopup.webContents.send('playlist:update', data)
  }
  if (miniPlayerWindow && !miniPlayerWindow.isDestroyed()) {
    miniPlayerWindow.webContents.send('playlist:update', data)
  }
  // 하위 호환: queue:update도 함께 전송
  const queueCompat = {
    queue: activePl?.songs || [],
    index: activePlaylistIndex,
    active: playlistQueueActive
  }
  if (miniLyricsPopup && !miniLyricsPopup.isDestroyed()) {
    miniLyricsPopup.webContents.send('queue:update', queueCompat)
  }
  if (miniPlayerWindow && !miniPlayerWindow.isDestroyed()) {
    miniPlayerWindow.webContents.send('queue:update', queueCompat)
  }
}

// 현재 곡이 활성 재생목록에 있으면 인덱스 자동 추적
function syncQueueIndex(videoId) {
  if (!playlistQueueActive) return
  const songs = getActivePlaylistSongs()
  if (!songs.length) return
  const idx = songs.findIndex(s => s.videoId === videoId)
  if (idx >= 0 && idx !== activePlaylistIndex) {
    activePlaylistIndex = idx
    broadcastPlaylistUpdate()
  }
}

// ─── State ────────────────────────────────────────────────

let mainWindow = null
let youtubeView = null
let miniPlayerWindow = null
let miniLyricsPopup = null
let tray = null
let currentMedia = { title: '', artist: '', thumbnail: '', isPlaying: false, isMuted: false, videoId: '' }
let currentLyrics = null // { synced: [{time, text}], plain: string, source: string }
let currentPlaylist = null // { current: number, total: number } | null
let currentUrl = ''
let lyricsVisible = false
let miniLyricsVisible = false
let miniOpacity = 1.0
let miniPlayerMode = 'expanded' // 'compact' | 'expanded'
let currentVolume = 100
const MINI_SIZES = {
  compact: { w: 360, h: 72 },
  expanded: { w: 360, h: 300 }
}

// ─── App Setup ────────────────────────────────────────────

app.setName('YouTube Music')

if (process.platform === 'win32') {
  app.setAppUserModelId('com.iloom.youtube-music')
}

// ─── 싱글 인스턴스 잠금 (중복 실행 방지) ─────────────────
const gotTheLock = app.requestSingleInstanceLock()

if (!gotTheLock) {
  // 이미 실행 중인 인스턴스가 있으면 즉시 종료
  app.quit()
} else {
  // 두 번째 실행 시도 시 미니플레이어 표시
  app.on('second-instance', () => {
    createMiniPlayer()
  })

  app.whenReady().then(() => {
    loadConfig()
    loadHistory()
    loadLyricsSync()
    loadLyricsSelection()
    loadPlaylists()
    miniOpacity = getConfig('miniPlayer.opacity') ?? 1.0
    miniPlayerMode = getConfig('miniPlayer.mode') || 'expanded'

    // 세션 캐시 크기 제한 (50MB) — 메모리 절약
    const ses = session.defaultSession
    ses.setStoragePath?.(path.join(app.getPath('userData'), 'session'))

    // 불필요한 권한 요청 자동 거부 (카메라, 마이크 등)
    ses.setPermissionRequestHandler((webContents, permission, callback) => {
      const allowed = ['media', 'notifications']
      callback(allowed.includes(permission))
    })

    createMainWindow()
    createTray()
    registerShortcuts()

    // 해상도/모니터 변경 시 위젯 위치 재조정
    const { screen } = require('electron')
    screen.on('display-metrics-changed', repositionWidget)

    // 온보딩 (첫 실행)
    if (!getConfig('onboardingComplete')) {
      showOnboarding()
    }

    // 자동 업데이터 설정
    setupAutoUpdater()
    // 첫 업데이트 체크 (30초 후), 이후 6시간마다
    setTimeout(checkForUpdates, 30 * 1000)
    setInterval(checkForUpdates, 6 * 60 * 60 * 1000)

    // 주기적 메모리 정리 (5분마다)
    setInterval(() => {
      if (global.gc) global.gc()
    }, 5 * 60 * 1000)
  })
}

app.on('window-all-closed', () => { /* 트레이 상주 */ })

app.on('before-quit', () => {
  app.isQuitting = true
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
})

// ─── Main Window ──────────────────────────────────────────

function createMainWindow() {
  const wb = getConfig('window') || DEFAULTS.window
  // 숨김 창이므로 YouTube 데스크톱이 풀 레이아웃(자동재생 사이드바 포함)으로 렌더링되도록 충분히 크게
  const winWidth = 1280
  const winHeight = 720

  // 저장된 위치가 화면 안에 있는지 검증
  const { screen } = require('electron')
  let winX = wb.x
  let winY = wb.y
  if (winX !== undefined && winY !== undefined) {
    const displays = screen.getAllDisplays()
    const visible = displays.some(d => {
      const b = d.bounds
      return winX >= b.x - 100 && winX < b.x + b.width &&
             winY >= b.y - 100 && winY < b.y + b.height
    })
    if (!visible) { winX = undefined; winY = undefined }
  }

  mainWindow = new BrowserWindow({
    width: winWidth,
    height: winHeight,
    x: winX,
    y: winY,
    minWidth: 1280,
    minHeight: 720,
    frame: false,
    icon: getIconPath(),
    backgroundColor: '#0f0f0f',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload-ui.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      spellcheck: false,
      enableWebSQL: false,
      v8CacheOptions: 'bypassHeatCheck'
    }
  })

  mainWindow.loadFile('renderer/index.html')

  mainWindow.once('ready-to-show', () => {
    createYoutubeView()
    createMiniPlayer()
  })

  mainWindow.on('close', (e) => {
    if (!app.isQuitting && getConfig('closeToTray')) {
      e.preventDefault()
      mainWindow.hide()
    }
  })

  // 최소화 시 자동으로 미니 플레이어 표시 + 작업표시줄에서 숨기기
  mainWindow.on('minimize', () => {
    if (currentMedia.title) {
      mainWindow.hide()
      createMiniPlayer()
    }
  })

  // 메인 창 복원 시 미니 플레이어 숨기기
  mainWindow.on('restore', () => {
    if (miniPlayerWindow && miniPlayerWindow.isVisible()) {
      miniPlayerWindow.hide()
      setConfig('miniPlayer.visible', false)
    }
  })

  mainWindow.on('resized', saveWindowBounds)
  mainWindow.on('moved', saveWindowBounds)

  mainWindow.on('maximize', () => {
    mainWindow.webContents.send('window:maximized', true)
    adjustYoutubeViewBoundsImmediate()
  })
  mainWindow.on('unmaximize', () => {
    mainWindow.webContents.send('window:maximized', false)
    adjustYoutubeViewBoundsImmediate()
  })
  // resize 이벤트에서 BrowserView 크기 조정 (디바운스)
  let _resizeDebounce = null
  mainWindow.on('resize', () => {
    sendResizeSignal()
    if (_resizeDebounce) clearTimeout(_resizeDebounce)
    _resizeDebounce = setTimeout(() => {
      adjustYoutubeViewBoundsImmediate()
      _resizeDebounce = null
    }, 150)
  })
}

function saveWindowBounds() {
  if (!mainWindow) return
  const isMaximized = mainWindow.isMaximized()
  setConfig('window.isMaximized', isMaximized)
  if (!isMaximized) {
    setConfig('window', { ...mainWindow.getBounds(), isMaximized: false })
  }
}

// ─── YouTube BrowserView ──────────────────────────────────

function createYoutubeView() {
  youtubeView = new BrowserView({
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      spellcheck: false,
      enableWebSQL: false,
      v8CacheOptions: 'bypassHeatCheck'
    }
  })

  // 백그라운드 오디오 유지
  youtubeView.webContents.setAudioMuted(false)
  youtubeView.webContents.setMaxListeners(20)

  mainWindow.setBrowserView(youtubeView)
  adjustYoutubeViewBoundsImmediate()

  // 마지막 재생 곡이 있으면 해당 곡으로 시작, 없으면 홈
  const lastSong = songHistory[0]
  const initialUrl = lastSong?.url ? `${lastSong.url}&autoplay=1` : getConfig('startUrl')
  youtubeView.webContents.loadURL(initialUrl)

  // 마지막 곡 메타데이터를 즉시 currentMedia에 반영 (미니플레이어에 표시)
  if (lastSong) {
    currentMedia = {
      ...currentMedia,
      title: lastSong.title || '',
      artist: lastSong.artist || '',
      thumbnail: lastSong.thumbnail || '',
      videoId: lastSong.videoId || '',
      isPlaying: false
    }
    // 시작 시 가사 미리 검색
    if (lastSong.title) {
      searchAndSendLyrics(lastSong.title, lastSong.artist || '')
    }
  }

  // 페이지 로드 후 inject
  youtubeView.webContents.on('did-finish-load', () => {
    // Visibility API 우회
    youtubeView.webContents.executeJavaScript(`
      Object.defineProperty(document, 'hidden', { get: () => false, configurable: true });
      Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    `).catch(() => {})

    // Fullscreen API 무력화 (BrowserView에서 미지원, 좁은 창에서 pause 유발 방지)
    youtubeView.webContents.executeJavaScript(`
      Element.prototype.requestFullscreen = function() { return Promise.resolve(); };
      Element.prototype.webkitRequestFullScreen = function() {};
      Element.prototype.webkitRequestFullscreen = function() {};
      Document.prototype.exitFullscreen = function() { return Promise.resolve(); };
      Document.prototype.webkitExitFullscreen = function() {};
      Object.defineProperty(document, 'fullscreenEnabled', { get: () => false, configurable: true });
      Object.defineProperty(document, 'webkitFullscreenEnabled', { get: () => false, configurable: true });
    `).catch(() => {})

    // YouTube 확장(풀스크린) 버튼 숨기기
    youtubeView.webContents.insertCSS(`
      button.fullscreen-icon,
      .fullscreen-icon,
      [aria-label="Full screen"],
      [aria-label="전체화면"],
      .ytp-fullscreen-button { display: none !important; }
    `).catch(() => {})

    // 오버레이 스크롤바 (평소 숨김, 스크롤 시만 표시)
    youtubeView.webContents.insertCSS(`
      ::-webkit-scrollbar { width: 6px; height: 6px; }
      ::-webkit-scrollbar-track { background: transparent; }
      ::-webkit-scrollbar-thumb {
        background: rgba(255,255,255,0);
        border-radius: 3px;
        transition: background 0.3s;
      }
      *:hover::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.2); }
      *:hover::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.4); }
      * { scrollbar-width: thin; scrollbar-color: transparent transparent; }
      *:hover { scrollbar-color: rgba(255,255,255,0.2) transparent; }
    `).catch(() => {})
  })

  // SPA 페이지 전환 시에도 재주입
  youtubeView.webContents.on('did-navigate-in-page', () => {
    youtubeView.webContents.executeJavaScript(`
      Object.defineProperty(document, 'hidden', { get: () => false, configurable: true });
      Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true });
    `).catch(() => {})
  })

  // URL 추적
  youtubeView.webContents.on('did-navigate', (_, url) => { currentUrl = url })
  youtubeView.webContents.on('did-navigate-in-page', (_, url) => { currentUrl = url })

  youtubeView.webContents.on('will-navigate', (e, url) => {
    if (!url.includes('youtube.com') && !url.includes('google.com')) {
      e.preventDefault()
    }
  })

  youtubeView.webContents.setWindowOpenHandler(({ url }) => {
    if (url.includes('youtube.com') || url.includes('google.com')) {
      youtubeView.webContents.loadURL(url)
    }
    return { action: 'deny' }
  })

}

let _resizeRestoreTimer = null

function sendResizeSignal() {
  if (youtubeView && !youtubeView.webContents.isDestroyed()) {
    youtubeView.webContents.executeJavaScript('window._ytmResizing && window._ytmResizing()').catch(() => {})
  }
}

function adjustYoutubeViewBoundsImmediate() {
  if (!youtubeView || !mainWindow) return
  const [width, height] = mainWindow.getContentSize()

  // 리사이즈 시작 전 preload에 리사이즈 신호 보내기 (pause 차단 강화)
  sendResizeSignal()

  const titleBarHeight = 36
  const lyricsWidth = lyricsVisible ? 320 : 0
  const MIN_YT_WIDTH = 400  // YouTube 모바일이 멈추지 않는 최소 폭

  youtubeView.setBounds({
    x: 0,
    y: titleBarHeight,
    width: Math.max(width - lyricsWidth, MIN_YT_WIDTH),
    height: Math.max(height - titleBarHeight, 1)
  })

  // BrowserView setBounds가 YouTube pause를 유발하므로, 재생 중이었으면 복원
  if (currentMedia.isPlaying) {
    if (_resizeRestoreTimer) clearTimeout(_resizeRestoreTimer)
    _resizeRestoreTimer = setTimeout(() => {
      restorePlayback()
      _resizeRestoreTimer = null
    }, 300)
  }
}

// ─── Mini Player ──────────────────────────────────────────

function getWidgetPosition(width, height, margin = 12) {
  const { screen } = require('electron')
  const display = screen.getPrimaryDisplay()
  const workArea = display.workArea
  const position = getConfig('miniPlayer.position') || 'bottom-left'

  const isRight = position.includes('right')
  const isBottom = position.includes('bottom')

  return {
    x: isRight ? workArea.x + workArea.width - width - margin : workArea.x + margin,
    y: isBottom ? workArea.y + workArea.height - height - margin : workArea.y + margin
  }
}

function createMiniPlayer() {
  if (miniPlayerWindow && !miniPlayerWindow.isDestroyed()) {
    miniPlayerWindow.show()
    miniPlayerWindow.setAlwaysOnTop(true) // Windows에서 투명 창이 뒤에 숨는 문제 방지
    // 페이드아웃 후 다시 표시될 때 opacity 복원
    miniPlayerWindow.webContents.send('mini:fadein')
    return
  }
  miniPlayerWindow = null // destroyed된 경우 정리

  const size = MINI_SIZES[miniPlayerMode]
  const pos = getWidgetPosition(size.w, size.h)

  miniPlayerWindow = new BrowserWindow({
    width: size.w,
    height: size.h,
    x: pos.x,
    y: pos.y,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    focusable: true,
    icon: getIconPath(),
    webPreferences: {
      preload: path.join(__dirname, 'preload-ui.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      enableWebSQL: false
    }
  })

  miniPlayerWindow.loadFile('renderer/mini-player.html')

  // 드래그로 위치 이동해도 저장하지 않음 — 트레이 메뉴로 위치 변경
  miniPlayerWindow.on('closed', () => {
    miniPlayerWindow = null
    miniLyricsVisible = false
    closeMiniLyricsPopup()
    setConfig('miniPlayer.visible', false)
  })

  setConfig('miniPlayer.visible', true)

  miniPlayerWindow.webContents.once('did-finish-load', () => {
    if (miniPlayerWindow) {
      miniPlayerWindow.webContents.send('media:update', currentMedia)
      if (currentLyrics) {
        miniPlayerWindow.webContents.send('lyrics:update', currentLyrics)
      }
      if (currentPlaylist) {
        miniPlayerWindow.webContents.send('media:playlist', currentPlaylist)
      }
      miniPlayerWindow.webContents.send('mini:marquee', getConfig('miniPlayer.marquee') !== false)
      miniPlayerWindow.webContents.send('mini:marquee-speed', getConfig('miniPlayer.marqueeSpeed') || 20)
      if (miniOpacity < 1) {
        miniPlayerWindow.webContents.send('mini:opacity-changed', miniOpacity)
      }
      // 즐겨찾기 상태
      if (currentMedia.videoId) {
        miniPlayerWindow.webContents.send('favorite:state', isFavorite(currentMedia.videoId))
      }
      // 확장 모드 초기화
      miniPlayerWindow.webContents.send('mini:mode', miniPlayerMode)
      if (miniPlayerMode === 'expanded') {
        miniPlayerWindow.webContents.send('mini:history', songHistory.slice(0, 8))
        miniPlayerWindow.webContents.send('media:volume-changed', currentVolume)
        if (miniLyricsVisible && currentLyrics) {
          miniPlayerWindow.webContents.send('lyrics:update', currentLyrics)
          miniPlayerWindow.webContents.send('lyrics:mini-visibility', true)
        }
      }
    }
  })

}

function toggleMiniPlayerMode() {
  miniPlayerMode = miniPlayerMode === 'compact' ? 'expanded' : 'compact'
  setConfig('miniPlayer.mode', miniPlayerMode)

  if (miniPlayerWindow && !miniPlayerWindow.isDestroyed()) {
    // 리사이즈 중 YouTube pause 차단
    sendResizeSignal()
    const size = MINI_SIZES[miniPlayerMode]
    const bounds = miniPlayerWindow.getBounds()
    // 하단 기준으로 확장/축소 (아래쪽 고정)
    const newY = bounds.y + bounds.height - size.h
    miniPlayerWindow.setBounds({ x: bounds.x, y: newY, width: size.w, height: size.h })
    miniPlayerWindow.webContents.send('mini:mode', miniPlayerMode)

    if (miniPlayerMode === 'expanded') {
      miniPlayerWindow.webContents.send('mini:history', songHistory.slice(0, 8))
    }

    // 가사 팝업이 열려있으면 위치 재조정
    repositionLyricsPopup()
  }
  updateTrayMenu()
}

// ─── Mute Toggle ──────────────────────────────────────────

function toggleMute() {
  sendToYoutube('control:mute-toggle')
}

// ─── Favorites ────────────────────────────────────────────

function addFavorite() {
  if (!currentMedia.videoId || !currentMedia.title) return
  const favorites = getConfig('favorites') || []
  const url = `https://www.youtube.com/watch?v=${currentMedia.videoId}`
  if (favorites.some(f => f.videoId === currentMedia.videoId)) return
  favorites.unshift({
    title: currentMedia.title,
    artist: currentMedia.artist || '',
    thumbnail: currentMedia.thumbnail || '',
    videoId: currentMedia.videoId,
    url,
    addedAt: Date.now()
  })
  setConfig('favorites', favorites)
  updateTrayMenu()
  sendFavoriteState(currentMedia.videoId)
}

function removeFavorite(videoId) {
  const favorites = (getConfig('favorites') || []).filter(f => f.videoId !== videoId)
  setConfig('favorites', favorites)
  updateTrayMenu()
  sendFavoriteState(currentMedia.videoId)
}

function toggleFavorite() {
  if (!currentMedia.videoId || !currentMedia.title) return
  const favorites = getConfig('favorites') || []
  const isFav = favorites.some(f => f.videoId === currentMedia.videoId)
  if (isFav) {
    removeFavorite(currentMedia.videoId)
  } else {
    addFavorite()
  }
}

function isFavorite(videoId) {
  const favorites = getConfig('favorites') || []
  return favorites.some(f => f.videoId === videoId)
}

function sendFavoriteState(videoId) {
  const fav = isFavorite(videoId)
  if (miniPlayerWindow && !miniPlayerWindow.isDestroyed()) {
    miniPlayerWindow.webContents.send('favorite:state', fav)
  }
  if (miniLyricsPopup && !miniLyricsPopup.isDestroyed()) {
    miniLyricsPopup.webContents.send('favorite:state', fav)
  }
}

function navigateToUrl(url) {
  if (!youtubeView || youtubeView.webContents.isDestroyed()) return
  // autoplay 파라미터 추가
  const playUrl = url.includes('?') ? `${url}&autoplay=1` : `${url}?autoplay=1`
  youtubeView.webContents.loadURL(playUrl)
  // 로드 후 강제 재생 (YouTube가 autoplay를 무시하는 경우 대비)
  youtubeView.webContents.once('did-finish-load', () => {
    const forcePlay = `
      (() => {
        const v = document.querySelector('video');
        if (v && v.paused) v.play().catch(() => {});
      })()
    `
    // 데스크톱 YouTube는 SPA라 video 요소가 늦게 뜰 수 있음 → 여러 번 시도
    setTimeout(() => youtubeView.webContents.executeJavaScript(forcePlay).catch(() => {}), 1500)
    setTimeout(() => youtubeView.webContents.executeJavaScript(forcePlay).catch(() => {}), 3000)
  })
}

function createMiniLyricsPopup(initialTab) {
  if (miniLyricsPopup && !miniLyricsPopup.isDestroyed()) {
    miniLyricsPopup.show()
    if (initialTab) miniLyricsPopup.webContents.send('popup:tab', initialTab)
    return
  }

  // 미니플레이어 위치 기준으로 바로 위에 배치
  const POPUP_W = 360
  const POPUP_H = 320
  const GAP = 8
  let popupX, popupY

  if (miniPlayerWindow && !miniPlayerWindow.isDestroyed()) {
    const mpBounds = miniPlayerWindow.getBounds()
    popupX = mpBounds.x
    popupY = mpBounds.y - POPUP_H - GAP
  } else {
    const pos = getWidgetPosition(POPUP_W, POPUP_H)
    popupX = pos.x
    popupY = pos.y
  }

  miniLyricsPopup = new BrowserWindow({
    width: POPUP_W,
    height: POPUP_H,
    x: popupX,
    y: popupY,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    focusable: true,
    icon: getIconPath(),
    webPreferences: {
      preload: path.join(__dirname, 'preload-ui.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  miniLyricsPopup.loadFile('renderer/mini-lyrics-popup.html')

  miniLyricsPopup.on('closed', () => {
    miniLyricsPopup = null
    miniLyricsVisible = false
    if (miniPlayerWindow && !miniPlayerWindow.isDestroyed()) {
      miniPlayerWindow.webContents.send('lyrics:mini-visibility', false)
    }
  })

  miniLyricsPopup.webContents.once('did-finish-load', () => {
    if (miniLyricsPopup) {
      if (currentLyrics) miniLyricsPopup.webContents.send('lyrics:update', currentLyrics)
      if (miniOpacity < 1) miniLyricsPopup.webContents.send('mini:opacity-changed', miniOpacity)
      if (initialTab) miniLyricsPopup.webContents.send('popup:tab', initialTab)
      // 히스토리 탭이면 데이터 전송
      if (initialTab === 'history') {
        miniLyricsPopup.webContents.send('mini:history', songHistory.slice(0, 20))
      }
      // 현재 재생 정보 + 큐 데이터 전송
      miniLyricsPopup.webContents.send('media:update', currentMedia)
      broadcastPlaylistUpdate()
    }
  })
}

function closeMiniLyricsPopup() {
  if (miniLyricsPopup && !miniLyricsPopup.isDestroyed()) {
    miniLyricsPopup.close()
    miniLyricsPopup = null
  }
}

function repositionLyricsPopup() {
  if (!miniLyricsPopup || miniLyricsPopup.isDestroyed()) return
  if (!miniPlayerWindow || miniPlayerWindow.isDestroyed()) return
  const mpBounds = miniPlayerWindow.getBounds()
  const popupBounds = miniLyricsPopup.getBounds()
  miniLyricsPopup.setBounds({
    x: mpBounds.x,
    y: mpBounds.y - popupBounds.height - 8,
    width: popupBounds.width,
    height: popupBounds.height
  })
}

function repositionWidget() {
  if (!miniPlayerWindow) return
  const bounds = miniPlayerWindow.getBounds()
  const pos = getWidgetPosition(bounds.width, bounds.height)
  miniPlayerWindow.setBounds({ ...bounds, x: pos.x, y: pos.y })
}

function setWidgetPosition(position) {
  setConfig('miniPlayer.position', position)
  repositionWidget()
  updateTrayMenu()
}

function toggleMiniPlayer() {
  if (miniPlayerWindow && miniPlayerWindow.isVisible()) {
    miniPlayerWindow.hide()
    setConfig('miniPlayer.visible', false)
  } else {
    createMiniPlayer()
  }
}

// ─── System Tray ──────────────────────────────────────────

function createTray() {
  const icon = nativeImage.createFromPath(getIconPath())
  tray = new Tray(icon.resize({ width: 16, height: 16 }))
  tray.setToolTip('YouTube Music')
  updateTrayMenu()

  // 좌클릭 → 미니플레이어 토글 (메뉴 안 뜸)
  tray.on('click', () => {
    createMiniPlayer()
  })

  // 우클릭 → 컨텍스트 메뉴
  tray.on('right-click', () => {
    tray.popUpContextMenu()
  })
}

function truncate(str, max) {
  return str.length > max ? str.slice(0, max - 1) + '…' : str
}

function updateTrayMenu() {
  const MAX_LEN = 24
  const hasMedia = !!currentMedia.title
  const songTitle = hasMedia ? truncate(currentMedia.title, MAX_LEN) : '재생 중인 곡 없음'
  const songArtist = hasMedia && currentMedia.artist ? truncate(currentMedia.artist, MAX_LEN) : ''
  const tooltip = hasMedia ? `${currentMedia.title} - ${currentMedia.artist}` : 'YouTube Music'

  const template = []

  // 곡 정보
  template.push({ label: songTitle, enabled: false })
  if (songArtist) {
    template.push({ label: songArtist, enabled: false })
  }
  template.push({ type: 'separator' })

  template.push({ type: 'separator' })

  // 즐겨찾기
  const favorites = getConfig('favorites') || []
  const favSubmenu = []
  favSubmenu.push({
    label: '현재 곡 추가',
    click: addFavorite,
    enabled: hasMedia && !favorites.some(f => f.videoId === currentMedia.videoId)
  })
  if (favorites.length > 0) {
    favSubmenu.push({ type: 'separator' })
    favorites.slice(0, 15).forEach(fav => {
      favSubmenu.push({
        label: truncate(`${fav.title} — ${fav.artist}`, MAX_LEN + 10),
        click: () => navigateToUrl(fav.url),
        submenu: [{
          label: '삭제',
          click: () => removeFavorite(fav.videoId)
        }]
      })
    })
    favSubmenu.push({ type: 'separator' })
    favSubmenu.push({
      label: '전체 삭제',
      click: () => { setConfig('favorites', []); updateTrayMenu() }
    })
  }
  template.push({ label: '즐겨찾기', submenu: favSubmenu })

  // 최근 재생
  const historySubmenu = []
  if (songHistory.length > 0) {
    songHistory.slice(0, 10).forEach(song => {
      const ago = getTimeAgo(song.playedAt)
      historySubmenu.push({
        label: truncate(`${song.title} — ${song.artist}`, MAX_LEN + 10),
        sublabel: ago,
        click: () => navigateToUrl(song.url)
      })
    })
    historySubmenu.push({ type: 'separator' })
    historySubmenu.push({
      label: '기록 삭제',
      click: () => { songHistory = []; saveHistory(); updateTrayMenu() }
    })
  } else {
    historySubmenu.push({ label: '(없음)', enabled: false })
  }
  template.push({ label: '최근 재생', submenu: historySubmenu })

  // 재생목록
  const plSubmenu = []
  if (playlists.length > 0) {
    playlists.forEach(pl => {
      plSubmenu.push({
        label: truncate(`${pl.name} (${pl.songs.length}곡)`, MAX_LEN + 10),
        type: 'radio',
        checked: pl.id === activePlaylistId,
        click: () => selectPlaylist(pl.id)
      })
    })
    plSubmenu.push({ type: 'separator' })
  }
  plSubmenu.push({
    label: '새 재생목록...',
    click: () => createPlaylist(`새 재생목록 ${playlists.length + 1}`)
  })
  template.push({ label: '재생목록', submenu: plSubmenu })
  template.push({ type: 'separator' })

  // 설정 서브메뉴
  template.push({ label: '설정', submenu: buildSettingsSubmenu() })

  template.push({ type: 'separator' })
  template.push({
    label: '종료',
    click: () => { app.isQuitting = true; app.quit() }
  })

  tray.setContextMenu(Menu.buildFromTemplate(template))
  tray.setToolTip(tooltip)
}

function buildSettingsSubmenu() {
  const currentSpeed = getConfig('miniPlayer.marqueeSpeed') || 12
  return [
    {
      label: '제목 흐르기',
      type: 'checkbox',
      checked: getConfig('miniPlayer.marquee') !== false,
      click: () => {
        const val = !(getConfig('miniPlayer.marquee') !== false)
        setConfig('miniPlayer.marquee', val)
        if (miniPlayerWindow && !miniPlayerWindow.isDestroyed()) {
          miniPlayerWindow.webContents.send('mini:marquee', val)
        }
      }
    },
    {
      label: '흐르기 속도',
      submenu: [
        { label: '느리게', type: 'radio', checked: currentSpeed <= 12, click: () => setMarqueeSpeed(10) },
        { label: '보통', type: 'radio', checked: currentSpeed > 12 && currentSpeed <= 25, click: () => setMarqueeSpeed(20) },
        { label: '빠르게', type: 'radio', checked: currentSpeed > 25 && currentSpeed <= 45, click: () => setMarqueeSpeed(35) },
        { label: '매우 빠르게', type: 'radio', checked: currentSpeed > 45, click: () => setMarqueeSpeed(55) }
      ]
    },
    {
      label: '투명도',
      submenu: [
        { label: '100%', type: 'radio', checked: miniOpacity > 0.95, click: () => setMiniOpacity(1.0) },
        { label: '80%', type: 'radio', checked: miniOpacity > 0.7 && miniOpacity <= 0.95, click: () => setMiniOpacity(0.8) },
        { label: '60%', type: 'radio', checked: miniOpacity > 0.5 && miniOpacity <= 0.7, click: () => setMiniOpacity(0.6) },
        { label: '40%', type: 'radio', checked: miniOpacity > 0.25 && miniOpacity <= 0.5, click: () => setMiniOpacity(0.4) },
        { label: '15%', type: 'radio', checked: miniOpacity <= 0.25, click: () => setMiniOpacity(0.15) }
      ]
    },
    {
      label: '볼륨',
      submenu: [
        { label: '100%', type: 'radio', checked: currentVolume > 90, click: () => sendToYoutube('control:volume', 100) },
        { label: '75%', type: 'radio', checked: currentVolume > 60 && currentVolume <= 90, click: () => sendToYoutube('control:volume', 75) },
        { label: '50%', type: 'radio', checked: currentVolume > 30 && currentVolume <= 60, click: () => sendToYoutube('control:volume', 50) },
        { label: '25%', type: 'radio', checked: currentVolume > 5 && currentVolume <= 30, click: () => sendToYoutube('control:volume', 25) },
        { label: '무음', type: 'radio', checked: currentVolume <= 5, click: () => sendToYoutube('control:volume', 0) }
      ]
    },
    { type: 'separator' },
    {
      label: '미니플레이어 크기',
      submenu: [
        { label: '컴팩트', type: 'radio', checked: miniPlayerMode === 'compact', click: () => { if (miniPlayerMode !== 'compact') toggleMiniPlayerMode() } },
        { label: '확장', type: 'radio', checked: miniPlayerMode === 'expanded', click: () => { if (miniPlayerMode !== 'expanded') toggleMiniPlayerMode() } }
      ]
    },
    {
      label: '위젯 위치',
      submenu: [
        { label: '좌측 상단', type: 'radio', checked: getConfig('miniPlayer.position') === 'top-left',     click: () => setWidgetPosition('top-left') },
        { label: '우측 상단', type: 'radio', checked: getConfig('miniPlayer.position') === 'top-right',    click: () => setWidgetPosition('top-right') },
        { label: '좌측 하단', type: 'radio', checked: getConfig('miniPlayer.position') === 'bottom-left',  click: () => setWidgetPosition('bottom-left') },
        { label: '우측 하단', type: 'radio', checked: getConfig('miniPlayer.position') === 'bottom-right', click: () => setWidgetPosition('bottom-right') }
      ]
    },
    { type: 'separator' },
    {
      label: '실험적 기능',
      submenu: [
        {
          label: 'MV → 음원 자동 전환',
          type: 'checkbox',
          checked: getConfig('autoAudioRedirect') === true,
          click: () => {
            const val = !getConfig('autoAudioRedirect')
            setConfig('autoAudioRedirect', val)
          }
        },
        {
          label: '메인창 열기',
          click: () => {
            if (mainWindow) {
              mainWindow.show()
              if (mainWindow.isMinimized()) mainWindow.restore()
              mainWindow.focus()
            }
          }
        }
      ]
    },
    { type: 'separator' },
    {
      label: 'YouTube 로그인 상태 확인',
      click: async () => {
        const loggedIn = await checkYoutubeLogin()
        dialog.showMessageBox({
          type: 'info',
          title: 'YouTube 로그인',
          message: loggedIn ? '✅ YouTube에 로그인되어 있습니다.' : '❌ YouTube에 로그인되어 있지 않습니다.\n메인창에서 로그인하세요.',
          buttons: loggedIn ? ['확인'] : ['메인창 열기', '취소']
        }).then(({ response }) => {
          if (!loggedIn && response === 0 && mainWindow) {
            mainWindow.show()
            mainWindow.focus()
          }
        })
      }
    },
    {
      label: '온보딩 다시 보기',
      click: () => showOnboarding()
    },
    {
      label: '업데이트 확인',
      click: () => {
        if (autoUpdater) {
          checkForUpdates()
        } else {
          dialog.showMessageBox({ type: 'info', message: 'electron-updater가 설치되지 않았습니다.' })
        }
      }
    }
  ]
}

function setMarqueeSpeed(seconds) {
  setConfig('miniPlayer.marqueeSpeed', seconds)
  if (miniPlayerWindow && !miniPlayerWindow.isDestroyed()) {
    miniPlayerWindow.webContents.send('mini:marquee-speed', seconds)
  }
}

function setMiniOpacity(val) {
  miniOpacity = val
  setConfig('miniPlayer.opacity', val)
  if (miniPlayerWindow && !miniPlayerWindow.isDestroyed()) {
    miniPlayerWindow.webContents.send('mini:opacity-changed', miniOpacity)
  }
  if (miniLyricsPopup && !miniLyricsPopup.isDestroyed()) {
    miniLyricsPopup.webContents.send('mini:opacity-changed', miniOpacity)
  }
}

// ─── IPC Handlers ─────────────────────────────────────────

// ─── MV → 음원 자동 전환 ─────────────────────────────────
const MV_RE = /\b(m\/v|mv|music\s*video)\b|official\s*video/i
const AUDIO_RE = /official\s*audio|audio/i
let mvRedirectId = ''  // 무한루프 방지: 방금 리다이렉트한 videoId

function isMvTitle(title) {
  return MV_RE.test(title)
}

async function tryRedirectToAudio(title, artist, currentVideoId) {
  // 이미 리다이렉트한 곡이면 스킵
  if (mvRedirectId === currentVideoId) return
  mvRedirectId = currentVideoId

  const cleanTitle = title
    .replace(/\s*[\(\[].*?(?:MV|M\/V|Official|Music Video).*?[\)\]]/gi, '')
    .replace(/\s*[-|]?\s*(?:Official|Music)\s*(?:Video|MV)/gi, '')
    .trim()
  const cleanArtist = artist
    .replace(/\s*[-–]\s*Topic$/i, '')
    .replace(/VEVO$/i, '')
    .replace(/\s*Official$/i, '')
    .trim()

  const query = `${cleanArtist} ${cleanTitle} official audio`
  console.log(`[MV→Audio] MV 감지! 음원 검색: "${query}"`)

  try {
    const results = await searchYoutubeVideo(query)
    // 동일 곡이면서 MV가 아닌 결과 찾기
    const match = results.find(r => {
      if (r.videoId === currentVideoId) return false  // 같은 영상 제외
      if (MV_RE.test(r.title)) return false           // MV 결과 제외
      // 제목 유사도 확인
      const sim = titleMatch(cleanTitle, cleanTrackTitle(r.title))
      return sim >= 0.5
    })

    if (match) {
      console.log(`[MV→Audio] 음원 발견: "${match.title}" (${match.videoId})`)
      mvRedirectId = match.videoId  // 전환 대상도 기록 (전환 후 다시 감지 방지)
      navigateToUrl(match.url)
    } else {
      console.log(`[MV→Audio] 적합한 음원 없음, MV 유지`)
    }
  } catch (e) {
    console.log(`[MV→Audio] 검색 실패:`, e.message)
  }
}

ipcMain.on('media:metadata-changed', async (_, data) => {
  // 아티스트가 비어있으면 oEmbed API로 채널명 가져오기
  if (!data.artist && data.videoId) {
    data.artist = await fetchArtistFromOembed(data.videoId)
  }

  const titleChanged = data.title !== currentMedia.title || data.artist !== currentMedia.artist
  currentMedia = { ...currentMedia, ...data }
  if (data.videoId) syncQueueIndex(data.videoId)
  updateTrayMenu()
  if (miniPlayerWindow) {
    miniPlayerWindow.webContents.send('media:update', currentMedia)
  }
  if (miniLyricsPopup && !miniLyricsPopup.isDestroyed()) {
    miniLyricsPopup.webContents.send('media:update', currentMedia)
  }
  // 곡이 바뀌면 가사 검색 + 히스토리 기록 + 즐겨찾기 상태 + MV 감지
  if (titleChanged && data.title) {
    console.log(`[Lyrics] 검색: "${data.title}" — "${data.artist}"`)
    searchAndSendLyrics(data.title, data.artist)
    addToHistory(data)
    if (data.videoId) sendFavoriteState(data.videoId)

    // MV 감지 → 음원 버전 자동 전환
    if (getConfig('autoAudioRedirect') === true && isMvTitle(data.title) && data.videoId) {
      tryRedirectToAudio(data.title, data.artist, data.videoId)
    } else {
      mvRedirectId = ''  // MV가 아니면 리다이렉트 기록 초기화
    }
  }
})

let rendererActivated = false

ipcMain.on('media:state-changed', (_, data) => {
  currentMedia.isPlaying = data.isPlaying
  updateTrayMenu()
  if (miniPlayerWindow) {
    miniPlayerWindow.webContents.send('media:update', currentMedia)
  }
  // 첫 재생 시 메인창을 투명하게 잠깐 표시 → BrowserView 렌더러 완전 활성화
  if (data.isPlaying && !rendererActivated && mainWindow && !mainWindow.isDestroyed()) {
    rendererActivated = true
    mainWindow.setOpacity(0)
    mainWindow.showInactive()
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.hide()
        mainWindow.setOpacity(1)
      }
    }, 300)
  }
})

ipcMain.on('media:ad-state', (_, data) => {
  currentMedia.adShowing = data.adShowing
  if (miniPlayerWindow && !miniPlayerWindow.isDestroyed()) {
    miniPlayerWindow.webContents.send('media:update', currentMedia)
  }
})

ipcMain.on('media:mute-changed', (_, data) => {
  currentMedia.isMuted = data.isMuted
  updateTrayMenu()
  if (miniPlayerWindow && !miniPlayerWindow.isDestroyed()) {
    miniPlayerWindow.webContents.send('media:mute-changed', data.isMuted)
  }
})

ipcMain.on('media:volume-changed', (_, data) => {
  currentVolume = data.volume
  if (miniPlayerWindow && !miniPlayerWindow.isDestroyed()) {
    miniPlayerWindow.webContents.send('media:volume-changed', data.volume)
  }
})

ipcMain.on('media:progress', (_, data) => {
  if (miniPlayerWindow && !miniPlayerWindow.isDestroyed()) {
    miniPlayerWindow.webContents.send('media:progress', data)
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('media:progress', data)
  }
  if (miniLyricsPopup && !miniLyricsPopup.isDestroyed()) {
    miniLyricsPopup.webContents.send('media:progress', data)
  }
})

ipcMain.on('media:playlist', (_, data) => {
  currentPlaylist = data
  if (miniPlayerWindow && !miniPlayerWindow.isDestroyed()) {
    miniPlayerWindow.webContents.send('media:playlist', data)
  }
  if (miniLyricsPopup && !miniLyricsPopup.isDestroyed()) {
    miniLyricsPopup.webContents.send('media:playlist', data)
  }
})

// 팝업에서 현재 재생 정보 요청
ipcMain.on('popup:request-media', (event) => {
  event.sender.send('media:update', currentMedia)
  if (currentPlaylist) event.sender.send('media:playlist', currentPlaylist)
})

ipcMain.on('control:play-pause', () => sendToYoutube('control:play-pause'))
ipcMain.on('control:next', () => {
  if (playlistQueueActive && getActivePlaylistSongs().length > 0) {
    playNextInPlaylist()
  } else {
    sendToYoutube('control:next')
  }
})
function playPrevFromHistory() {
  if (currentMedia.videoId && songHistory.length > 1) {
    const currentIdx = songHistory.findIndex(s => s.videoId === currentMedia.videoId)
    const prevSong = currentIdx >= 0 ? songHistory[currentIdx + 1] : songHistory[1]
    if (prevSong) {
      const url = prevSong.url || `https://www.youtube.com/watch?v=${prevSong.videoId}`
      currentMedia = {
        ...currentMedia,
        title: prevSong.title,
        artist: prevSong.artist || '',
        thumbnail: prevSong.thumbnail || '',
        videoId: prevSong.videoId,
        isPlaying: true
      }
      if (miniPlayerWindow && !miniPlayerWindow.isDestroyed()) {
        miniPlayerWindow.webContents.send('media:update', currentMedia)
      }
      searchAndSendLyrics(prevSong.title, prevSong.artist || '')
      navigateToUrl(url)
      return
    }
  }
  sendToYoutube('control:prev')
}

ipcMain.on('control:prev', () => {
  if (playlistQueueActive && getActivePlaylistSongs().length > 0) {
    playPrevInPlaylist()
  } else {
    playPrevFromHistory()
  }
})
ipcMain.on('control:seek', (_, time) => {
  if (!youtubeView || youtubeView.webContents.isDestroyed()) return
  youtubeView.webContents.executeJavaScript(`
    (() => { const v = document.querySelector('video'); if (v) v.currentTime = ${Number(time)}; })()
  `).catch(() => {})
})

// ─── 가사 싱크 오프셋 조절 ───────────────────────────────
ipcMain.on('lyrics:adjust-sync', (_, delta) => {
  const videoId = currentMedia.videoId
  if (!videoId) return
  const current = getSyncOffset(videoId)
  const newOffset = Math.round((current + delta) * 10) / 10
  setSyncOffset(videoId, newOffset)
  // 팝업에 오프셋 전달
  if (miniLyricsPopup && !miniLyricsPopup.isDestroyed()) {
    miniLyricsPopup.webContents.send('lyrics:sync-offset', newOffset)
  }
})

ipcMain.on('lyrics:reset-sync', () => {
  const videoId = currentMedia.videoId
  if (!videoId) return
  setSyncOffset(videoId, 0)
  if (miniLyricsPopup && !miniLyricsPopup.isDestroyed()) {
    miniLyricsPopup.webContents.send('lyrics:sync-offset', 0)
  }
})

ipcMain.on('window:minimize', () => mainWindow?.minimize())
ipcMain.on('window:maximize', () => {
  if (mainWindow?.isMaximized()) mainWindow.unmaximize()
  else mainWindow?.maximize()
})
ipcMain.on('window:close', () => mainWindow?.close())
ipcMain.on('window:toggle-mini', () => toggleMiniPlayer())

// ─── 가사 관련 IPC ───
ipcMain.on('lyrics:toggle', () => {
  lyricsVisible = !lyricsVisible
  if (mainWindow && !mainWindow.isDestroyed()) {
    const wasPlaying = currentMedia.isPlaying
    const LYRICS_W = 320

    // 최대화 상태가 아닐 때만 창 폭 자동 조절
    if (!mainWindow.isMaximized()) {
      const bounds = mainWindow.getBounds()
      if (lyricsVisible) {
        mainWindow.setBounds({ ...bounds, width: bounds.width + LYRICS_W })
      } else {
        mainWindow.setBounds({ ...bounds, width: Math.max(bounds.width - LYRICS_W, 520) })
      }
    }

    mainWindow.webContents.send('lyrics:visibility', lyricsVisible)
    adjustYoutubeViewBoundsImmediate()
    if (wasPlaying) restorePlayback()
  }
})

ipcMain.on('lyrics:toggle-mini', () => {
  miniLyricsVisible = !miniLyricsVisible

  if (miniLyricsVisible) {
    createMiniLyricsPopup('lyrics')
  } else {
    closeMiniLyricsPopup()
  }
  if (miniPlayerWindow && !miniPlayerWindow.isDestroyed()) {
    miniPlayerWindow.webContents.send('lyrics:mini-visibility', miniLyricsVisible)
  }
})

ipcMain.on('mini:opacity', (_, delta) => {
  miniOpacity = Math.min(1, Math.max(0.15, miniOpacity + delta))
  setConfig('miniPlayer.opacity', miniOpacity)
  // 미니플레이어에 전달
  if (miniPlayerWindow && !miniPlayerWindow.isDestroyed()) {
    miniPlayerWindow.webContents.send('mini:opacity-changed', miniOpacity)
  }
  // 가사 팝업에도 전달
  if (miniLyricsPopup && !miniLyricsPopup.isDestroyed()) {
    miniLyricsPopup.webContents.send('mini:opacity-changed', miniOpacity)
  }
})

// 미니 플레이어/가사 팝업 JS 드래그 이동
ipcMain.on('mini:move', (event, dx, dy) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (win && !win.isDestroyed()) {
    const [x, y] = win.getPosition()
    win.setPosition(x + dx, y + dy)
  }
})

// 무음 토글
ipcMain.on('control:mute-toggle', () => toggleMute())

// 볼륨 조절
ipcMain.on('control:volume', (_, vol) => {
  sendToYoutube('control:volume', vol)
})

// 미니플레이어 모드 전환
ipcMain.on('mini:toggle-expanded', () => toggleMiniPlayerMode())

// URL 네비게이션 (히스토리/즐겨찾기 재생)
ipcMain.on('navigate:url', (_, url, meta) => {
  // 검색 결과에서 메타데이터가 함께 오면 즉시 미니 플레이어에 반영
  if (meta && meta.title) {
    const videoId = meta.videoId || url.match(/[?&]v=([^&]+)/)?.[1] || ''
    currentMedia = {
      ...currentMedia,
      title: meta.title,
      artist: meta.artist || '',
      thumbnail: meta.thumbnail || '',
      videoId,
      isPlaying: true
    }
    updateTrayMenu()
    if (miniPlayerWindow && !miniPlayerWindow.isDestroyed()) {
      miniPlayerWindow.webContents.send('media:update', currentMedia)
    }
    if (meta.title) {
      searchAndSendLyrics(meta.title, meta.artist || '')
      addToHistory({ ...meta, videoId })
      sendFavoriteState(videoId)
    }
  }
  navigateToUrl(url)
})

// 히스토리 요청
ipcMain.on('history:get', (event) => {
  event.sender.send('mini:history', songHistory.slice(0, 20))
})

// 보조 팝업 열기 (가사/히스토리/검색 탭)
ipcMain.on('popup:open', (_, tab) => {
  if (miniLyricsPopup && !miniLyricsPopup.isDestroyed()) {
    miniLyricsPopup.show()
    miniLyricsPopup.webContents.send('popup:tab', tab)
    if (tab === 'history') {
      miniLyricsPopup.webContents.send('mini:history', songHistory.slice(0, 20))
    }
    if (tab === 'queue') {
      miniLyricsPopup.webContents.send('media:update', currentMedia)
      // 재생목록 데이터 전송
      broadcastPlaylistUpdate()
    }
  } else {
    miniLyricsVisible = true
    createMiniLyricsPopup(tab)
    if (miniPlayerWindow && !miniPlayerWindow.isDestroyed()) {
      miniPlayerWindow.webContents.send('lyrics:mini-visibility', true)
    }
  }
})

// ─── YouTube 검색 (InnerTube API) ────────────────────────
ipcMain.handle('search:youtube', async (_, query, mode) => {
  if (mode === 'audio') {
    return searchYoutubeMusic(query)
  }
  if (mode === 'playlist') {
    return searchYoutubePlaylist(query)
  }
  if (mode === 'playlist-detail') {
    return fetchPlaylistDetail(query)  // query = playlistId
  }
  return searchYoutubeVideo(query)
})

async function fetchPlaylistDetail(playlistId) {
  try {
    const body = JSON.stringify({
      context: {
        client: { clientName: 'WEB', clientVersion: '2.20240101.00.00', hl: 'ko', gl: 'KR' }
      },
      browseId: `VL${playlistId}`
    })

    const res = await net.fetch('https://www.youtube.com/youtubei/v1/browse?prettyPrint=false', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      body
    })
    const json = await res.json()
    return parsePlaylistDetail(json, playlistId)
  } catch {
    return { title: '', videos: [] }
  }
}

function parsePlaylistDetail(json, playlistId) {
  const videos = []
  let playlistTitle = ''

  try {
    // 플레이리스트 제목
    playlistTitle = json?.metadata?.playlistMetadataRenderer?.title
      || json?.header?.playlistHeaderRenderer?.title?.simpleText || ''

    // 곡 목록
    const tabs = json?.contents?.twoColumnBrowseResultsRenderer?.tabs || []
    for (const tab of tabs) {
      const sectionContents = tab?.tabRenderer?.content?.sectionListRenderer?.contents || []
      for (const section of sectionContents) {
        const items = section?.itemSectionRenderer?.contents?.[0]?.playlistVideoListRenderer?.contents || []
        for (const item of items) {
          const v = item?.playlistVideoRenderer
          if (!v || !v.videoId) continue

          let title = ''
          if (v.title?.runs) title = v.title.runs.map(r => r.text).join('')
          else if (v.title?.simpleText) title = v.title.simpleText

          let artist = ''
          if (v.shortBylineText?.runs) artist = v.shortBylineText.runs.map(r => r.text).join('')

          let duration = ''
          if (v.lengthText?.simpleText) duration = v.lengthText.simpleText

          let thumbnail = ''
          const thumbs = v.thumbnail?.thumbnails
          if (thumbs?.length) thumbnail = thumbs[thumbs.length - 1].url

          videos.push({
            type: 'video',
            title,
            artist,
            duration,
            videoId: v.videoId,
            thumbnail,
            url: `https://www.youtube.com/watch?v=${v.videoId}&list=${playlistId}`
          })
        }
      }
    }
  } catch {}

  return { title: playlistTitle, videos }
}

async function searchYoutubeVideo(query) {
  try {
    const body = JSON.stringify({
      context: {
        client: { clientName: 'WEB', clientVersion: '2.20240101.00.00', hl: 'ko', gl: 'KR' }
      },
      query,
      params: 'EgWKAQIIAQ%3D%3D'  // 음악 필터
    })

    const res = await net.fetch('https://www.youtube.com/youtubei/v1/search?prettyPrint=false', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      body
    })
    const json = await res.json()
    return parseInnerTubeResults(json)
  } catch {
    return []
  }
}

async function searchYoutubePlaylist(query) {
  try {
    const body = JSON.stringify({
      context: {
        client: { clientName: 'WEB', clientVersion: '2.20240101.00.00', hl: 'ko', gl: 'KR' }
      },
      query,
      params: 'EgIQAw=='  // 플레이리스트 필터
    })

    const res = await net.fetch('https://www.youtube.com/youtubei/v1/search?prettyPrint=false', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      body
    })
    const json = await res.json()
    return parsePlaylistResults(json)
  } catch {
    return []
  }
}

function parsePlaylistResults(json) {
  const results = []
  try {
    const primary = json?.contents?.twoColumnSearchResultsRenderer?.primaryContents
    const sections = primary?.sectionListRenderer?.contents
      || json?.contents?.sectionListRenderer?.contents || []
    for (const section of sections) {
      const items = section?.itemSectionRenderer?.contents || []
      for (const item of items) {
        // 새 형식: lockupViewModel (2025~)
        const lvm = item?.lockupViewModel
        if (lvm) {
          const playlistId = lvm.contentId
          if (!playlistId) continue

          // 제목
          const title = lvm.metadata?.lockupMetadataViewModel?.title?.content || ''

          // 채널명 (metadataRows 첫 번째 행)
          let artist = ''
          const rows = lvm.metadata?.lockupMetadataViewModel?.metadata?.contentMetadataViewModel?.metadataRows
          if (rows?.[0]?.metadataParts?.[0]?.text?.content) {
            artist = rows[0].metadataParts[0].text.content
          }

          // 곡 수 (배지 텍스트에서 추출)
          let videoCount = ''
          const overlays = lvm.contentImage?.collectionThumbnailViewModel?.primaryThumbnail?.thumbnailViewModel?.overlays
          if (overlays) {
            for (const ov of overlays) {
              const badges = ov?.thumbnailOverlayBadgeViewModel?.thumbnailBadges
              if (badges?.[0]?.thumbnailBadgeViewModel?.text) {
                videoCount = badges[0].thumbnailBadgeViewModel.text
                // "동영상 54개" → "54" 추출
                const countMatch = videoCount.match(/(\d+)/)
                if (countMatch) videoCount = countMatch[1]
                break
              }
            }
          }

          // 썸네일
          let thumbnail = ''
          const sources = lvm.contentImage?.collectionThumbnailViewModel?.primaryThumbnail?.thumbnailViewModel?.image?.sources
          if (sources?.length) thumbnail = sources[sources.length - 1].url

          // 첫 영상 videoId: 썸네일 URL에서 추출
          let firstVideoId = ''
          if (thumbnail) {
            const vidMatch = thumbnail.match(/\/vi\/([^/]+)\//)
            if (vidMatch) firstVideoId = vidMatch[1]
          }
          // rendererContext에서도 시도
          if (!firstVideoId) {
            const watchEp = lvm.rendererContext?.commandContext?.onTap?.innertubeCommand?.watchEndpoint
            if (watchEp?.videoId) firstVideoId = watchEp.videoId
          }

          if (title) {
            results.push({
              type: 'playlist',
              title,
              artist,
              videoCount,
              thumbnail,
              playlistId,
              url: firstVideoId
                ? `https://www.youtube.com/watch?v=${firstVideoId}&list=${playlistId}`
                : `https://www.youtube.com/playlist?list=${playlistId}`
            })
          }
          if (results.length >= 15) break
          continue
        }

        // 구 형식: playlistRenderer (레거시 호환)
        const pl = item?.playlistRenderer
        if (!pl) continue

        const playlistId = pl.playlistId
        if (!playlistId) continue

        let title = ''
        if (pl.title?.simpleText) title = pl.title.simpleText
        else if (pl.title?.runs) title = pl.title.runs.map(r => r.text).join('')

        let artist = ''
        if (pl.shortBylineText?.runs) artist = pl.shortBylineText.runs.map(r => r.text).join('')
        else if (pl.longBylineText?.runs) artist = pl.longBylineText.runs.map(r => r.text).join('')

        let videoCount = ''
        if (pl.videoCount) videoCount = pl.videoCount
        else if (pl.videoCountText?.simpleText) videoCount = pl.videoCountText.simpleText

        let thumbnail = ''
        const thumbs = pl.thumbnails?.[0]?.thumbnails || pl.thumbnail?.thumbnails
        if (thumbs && thumbs.length) thumbnail = thumbs[thumbs.length - 1].url

        let firstVideoId = ''
        const nav = pl.navigationEndpoint?.watchEndpoint
        if (nav?.videoId) firstVideoId = nav.videoId

        if (title) {
          results.push({
            type: 'playlist',
            title,
            artist,
            videoCount,
            thumbnail,
            playlistId,
            url: firstVideoId
              ? `https://www.youtube.com/watch?v=${firstVideoId}&list=${playlistId}`
              : `https://www.youtube.com/playlist?list=${playlistId}`
          })
        }
        if (results.length >= 15) break
      }
      if (results.length >= 15) break
    }
  } catch {}
  return results
}

function searchYoutubeMusic(query) {
  // 음원 모드: 같은 WEB InnerTube API를 사용하되 "official audio"를 붙여서 검색
  const audioQuery = `${query} official audio`
  return searchYoutubeVideo(audioQuery)
}

function parseInnerTubeResults(json) {
  const results = []
  try {
    // WEB client: twoColumnSearchResultsRenderer → primaryContents → sectionListRenderer
    const primary = json?.contents?.twoColumnSearchResultsRenderer?.primaryContents
    const sections = primary?.sectionListRenderer?.contents
      || json?.contents?.sectionListRenderer?.contents || []
    for (const section of sections) {
      const items = section?.itemSectionRenderer?.contents || []
      for (const item of items) {
        const video = item?.videoRenderer || item?.compactVideoRenderer || item?.videoWithContextRenderer
        if (!video) continue

        const videoId = video.videoId || video.navigationEndpoint?.watchEndpoint?.videoId
        if (!videoId) continue

        // 제목 추출
        let title = ''
        const titleRuns = video.title?.runs || video.headline?.runs
        if (titleRuns) title = titleRuns.map(r => r.text).join('')
        else if (video.title?.text) title = video.title.text

        // 아티스트/채널명 추출
        let artist = ''
        if (video.ownerText?.runs) artist = video.ownerText.runs.map(r => r.text).join('')
        else if (video.shortBylineText?.runs) artist = video.shortBylineText.runs.map(r => r.text).join('')
        else if (video.longBylineText?.runs) artist = video.longBylineText.runs.map(r => r.text).join('')

        // 공식 채널 여부 판별
        const hasBadge = video.ownerBadges?.some(b =>
          b.metadataBadgeRenderer?.style === 'BADGE_STYLE_TYPE_VERIFIED_ARTIST' ||
          b.metadataBadgeRenderer?.style === 'BADGE_STYLE_TYPE_VERIFIED'
        ) || false
        const isOfficial = hasBadge ||
          /VEVO$/i.test(artist) ||
          /Official/i.test(artist) ||
          /- Topic$/i.test(artist) ||
          /official\s*(m\/v|mv|music\s*video|video|audio)/i.test(title)

        // 길이 추출
        let duration = ''
        if (video.lengthText?.simpleText) duration = video.lengthText.simpleText
        else if (video.lengthText?.runs) duration = video.lengthText.runs.map(r => r.text).join('')
        else if (video.lengthText?.text) duration = video.lengthText.text

        // 썸네일
        let thumbnail = ''
        const thumbs = video.thumbnail?.thumbnails
        if (thumbs && thumbs.length) thumbnail = thumbs[thumbs.length - 1].url

        // 조회수 추출 (정렬용)
        let viewCount = 0
        const viewText = video.viewCountText?.simpleText || video.viewCountText?.runs?.map(r => r.text).join('') || ''
        const viewMatch = viewText.replace(/,/g, '').match(/([\d.]+)\s*(억|만|천|[BMKbmk])?/)
        if (viewMatch) {
          viewCount = parseFloat(viewMatch[1])
          const unit = viewMatch[2]
          if (unit === '억' || unit === 'B' || unit === 'b') viewCount *= 100000000
          else if (unit === '만') viewCount *= 10000
          else if (unit === '천') viewCount *= 1000
          else if (unit === 'M' || unit === 'm') viewCount *= 1000000
          else if (unit === 'K' || unit === 'k') viewCount *= 1000
        }

        if (title) {
          results.push({
            title,
            artist,
            duration,
            videoId,
            thumbnail,
            url: `https://www.youtube.com/watch?v=${videoId}`,
            _isOfficial: isOfficial,
            _viewCount: viewCount
          })
        }
        if (results.length >= 20) break
      }
      if (results.length >= 20) break
    }
  } catch {}

  // 오디오 우선 정렬: audio > 일반 > MV
  const audioRe = /official\s*audio|audio|가사|lyrics/i
  const mvRe = /\b(m\/v|mv|music\s*video)\b|official\s*video/i
  function audioScore(item) {
    if (audioRe.test(item.title)) return 2   // audio → 최상위
    if (mvRe.test(item.title)) return 0      // MV → 최하위
    return 1                                  // 일반
  }
  results.sort((a, b) => {
    const as = audioScore(a), bs = audioScore(b)
    if (as !== bs) return bs - as
    if (a._isOfficial !== b._isOfficial) return b._isOfficial ? 1 : -1
    return b._viewCount - a._viewCount
  })

  // 내부 정렬 필드 제거 후 15개만 반환
  return results.slice(0, 15).map(({ _isOfficial, _viewCount, ...rest }) => rest)
}

// ─── 가사 후보 선택 ───────────────────────────────────────

ipcMain.handle('lyrics:get-candidates', async () => {
  const title = currentMedia.title
  const artist = currentMedia.artist || ''
  if (!title) return []

  const candidates = []
  const cleanedTitle = cleanTrackTitle(title)
  const cleanedArtist = cleanArtistName(artist)

  // LRCLIB 후보
  try {
    const params = new URLSearchParams({ track_name: cleanedTitle, artist_name: cleanedArtist })
    const url = `https://lrclib.net/api/search?${params.toString()}`
    const res = await net.fetch(url, { headers: { 'User-Agent': 'YouTubeMusic Desktop App/1.0' } })
    const results = await res.json()
    for (const r of results.slice(0, 10)) {
      candidates.push({
        source: 'lrclib',
        id: r.id,
        trackName: r.trackName,
        artistName: r.artistName,
        albumName: r.albumName || '',
        hasSynced: !!r.syncedLyrics,
        isChineseOnly: false
      })
    }
  } catch {}

  // Netease 후보
  try {
    const results = await neteaseSearch(cleanedTitle, cleanedArtist)
    for (const r of results.slice(0, 10)) {
      const lyrics = await neteaseLyrics(r.id)
      candidates.push({
        source: 'netease',
        id: r.id,
        trackName: r.name,
        artistName: r.artist,
        albumName: r.album,
        hasSynced: !!lyrics?.synced,
        isChineseOnly: lyrics?.isChineseOnly || false
      })
    }
  } catch {}

  // 중국어 전용 결과를 뒤로 정렬
  candidates.sort((a, b) => (a.isChineseOnly ? 1 : 0) - (b.isChineseOnly ? 1 : 0))

  return candidates
})

ipcMain.on('lyrics:select-candidate', async (_, { source, id }) => {
  const videoId = currentMedia.videoId
  if (!videoId) return

  const lyrics = await fetchLyricsById(source, id)
  if (lyrics) {
    currentLyrics = lyrics
    saveLyricsSelection(videoId, source, id)
    setSyncOffset(videoId, 0)
    sendLyricsToAll()
  }
})

// ─── 코너 스내핑 ──────────────────────────────────────────

ipcMain.on('mini:snap-check', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win || win.isDestroyed()) return

  const { screen } = require('electron')
  const display = screen.getPrimaryDisplay()
  const workArea = display.workArea
  const bounds = win.getBounds()
  const margin = 12

  // 4개 코너 위치 계산
  const corners = {
    'top-left': { x: workArea.x + margin, y: workArea.y + margin },
    'top-right': { x: workArea.x + workArea.width - bounds.width - margin, y: workArea.y + margin },
    'bottom-left': { x: workArea.x + margin, y: workArea.y + workArea.height - bounds.height - margin },
    'bottom-right': { x: workArea.x + workArea.width - bounds.width - margin, y: workArea.y + workArea.height - bounds.height - margin }
  }

  // 가장 가까운 코너 찾기
  let nearest = null
  let minDist = Infinity
  for (const [name, pos] of Object.entries(corners)) {
    const dist = Math.sqrt(Math.pow(bounds.x - pos.x, 2) + Math.pow(bounds.y - pos.y, 2))
    if (dist < minDist) {
      minDist = dist
      nearest = { name, ...pos }
    }
  }

  // 60px 이내면 스냅
  if (nearest && minDist <= 60) {
    win.setPosition(nearest.x, nearest.y)
    setConfig('miniPlayer.position', nearest.name)
    // 가사 팝업도 함께 이동
    repositionLyricsPopup()
  }
})

ipcMain.on('mini:reset-position', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win || win.isDestroyed()) return
  const bounds = win.getBounds()
  const pos = getWidgetPosition(bounds.width, bounds.height)
  win.setPosition(pos.x, pos.y)
  repositionLyricsPopup()
})

// 즐겨찾기 추가
ipcMain.on('favorite:add', () => addFavorite())
ipcMain.on('favorite:toggle', () => toggleFavorite())
ipcMain.on('favorite:get', (event) => {
  const favorites = getConfig('favorites') || []
  event.sender.send('favorite:list', favorites)
})

// ─── 재생목록 IPC ──────────────────────────────────────────

// CRUD
ipcMain.on('playlist:create', (_, { name }) => createPlaylist(name))
ipcMain.on('playlist:rename', (_, { id, name }) => renamePlaylist(id, name))
ipcMain.on('playlist:delete', (_, { id }) => deletePlaylist(id))
ipcMain.on('playlist:duplicate', (_, { id, newName }) => duplicatePlaylist(id, newName))

// 선택 / 재생
ipcMain.on('playlist:select', (_, { id }) => selectPlaylist(id))
ipcMain.on('playlist:play', (_, index) => playFromPlaylist(index))

// 곡 관리
ipcMain.on('playlist:add-song', (_, { playlistId, song }) => addSongToPlaylist(playlistId, song))
ipcMain.on('playlist:add-bulk', (_, { playlistId, songs }) => addBulkSongsToPlaylist(playlistId, songs))
ipcMain.on('playlist:remove-song', (_, { playlistId, videoId }) => removeSongFromPlaylist(playlistId, videoId))
ipcMain.on('playlist:reorder', (_, { playlistId, fromIdx, toIdx }) => reorderSong(playlistId, fromIdx, toIdx))
ipcMain.on('playlist:clear', (_, { playlistId }) => clearPlaylistSongs(playlistId))

// 내보내기/가져오기
ipcMain.on('playlist:export', (_, { id }) => exportPlaylist(id))
ipcMain.on('playlist:import', () => importPlaylist())

// 상태 요청
ipcMain.on('playlist:get', () => broadcastPlaylistUpdate())

// 하위 호환: 기존 queue:* → playlist:* 라우팅
ipcMain.on('queue:add', (_, song) => {
  if (!activePlaylistId && playlists.length === 0) createPlaylist('내 재생목록')
  addSongToPlaylist(activePlaylistId || playlists[0]?.id, song)
})
ipcMain.on('queue:add-bulk', (_, songs) => {
  if (!activePlaylistId && playlists.length === 0) createPlaylist('내 재생목록')
  addBulkSongsToPlaylist(activePlaylistId || playlists[0]?.id, songs)
})
ipcMain.on('queue:remove', (_, videoId) => {
  if (activePlaylistId) removeSongFromPlaylist(activePlaylistId, videoId)
})
ipcMain.on('queue:clear', () => {
  if (activePlaylistId) clearPlaylistSongs(activePlaylistId)
})
ipcMain.on('queue:play', (_, index) => playFromPlaylist(index))
ipcMain.on('queue:get', (event) => {
  const songs = getActivePlaylistSongs()
  event.sender.send('queue:update', { queue: songs, index: activePlaylistIndex, active: playlistQueueActive })
})
ipcMain.on('queue:toggle', () => {
  if (getActivePlaylistSongs().length === 0) return
  setPlaylistQueueActive(!playlistQueueActive)
  broadcastPlaylistUpdate()
})

// 곡 종료 → 재생목록에서 다음 곡 재생
ipcMain.on('media:ended', () => {
  if (playlistQueueActive && getActivePlaylistSongs().length > 0) {
    playNextInPlaylist()
  }
})

ipcMain.on('nav:back', () => youtubeView?.webContents.goBack())
ipcMain.on('nav:forward', () => youtubeView?.webContents.goForward())
ipcMain.on('nav:home', () => {
  youtubeView?.webContents.loadURL(getConfig('startUrl'))
})

ipcMain.on('mini:close', () => {
  miniPlayerWindow?.hide()
  closeMiniLyricsPopup()
  miniLyricsVisible = false
  setConfig('miniPlayer.visible', false)
  // 미니플레이어만 숨김 (음악은 계속 재생, 트레이에서 다시 열 수 있음)
})

// 미니 플레이어 우클릭 → 페이드아웃 후 숨기기 (음악 계속 재생)
ipcMain.on('mini:hide', () => {
  // 가사 팝업도 함께 숨기기
  if (miniLyricsPopup && !miniLyricsPopup.isDestroyed()) {
    miniLyricsPopup.webContents.send('mini:fadeout')
    setTimeout(() => {
      if (miniLyricsPopup && !miniLyricsPopup.isDestroyed()) miniLyricsPopup.hide()
    }, 300)
  }
  if (miniPlayerWindow && !miniPlayerWindow.isDestroyed()) {
    miniPlayerWindow.webContents.send('mini:fadeout')
    setTimeout(() => {
      if (miniPlayerWindow && !miniPlayerWindow.isDestroyed()) miniPlayerWindow.hide()
    }, 300)
  }
  miniLyricsVisible = false
  setConfig('miniPlayer.visible', false)
})

// 미니 플레이어 컨텍스트 메뉴
ipcMain.on('mini:context-menu', () => {
  if (!miniPlayerWindow || miniPlayerWindow.isDestroyed()) return
  const hasMedia = !!currentMedia.videoId
  const videoUrl = hasMedia ? `https://www.youtube.com/watch?v=${currentMedia.videoId}` : ''
  const songLabel = hasMedia ? truncate(currentMedia.title, 24) : '재생 중인 곡 없음'

  const menu = Menu.buildFromTemplate([
    { label: songLabel, enabled: false },
    { type: 'separator' },
    {
      label: '곡 링크 복사',
      enabled: hasMedia,
      click: () => clipboard.writeText(videoUrl)
    },
    {
      label: '곡 제목 복사',
      enabled: hasMedia,
      click: () => {
        const text = currentMedia.artist
          ? `${currentMedia.artist} - ${currentMedia.title}`
          : currentMedia.title
        clipboard.writeText(text)
      }
    },
    { type: 'separator' },
    {
      label: '가사 팝업',
      type: 'checkbox',
      checked: miniLyricsVisible,
      click: () => {
        miniLyricsVisible = !miniLyricsVisible
        if (miniLyricsVisible) createMiniLyricsPopup('lyrics')
        else closeMiniLyricsPopup()
        if (miniPlayerWindow && !miniPlayerWindow.isDestroyed())
          miniPlayerWindow.webContents.send('lyrics:mini-visibility', miniLyricsVisible)
      }
    },
    { label: '설정', submenu: buildSettingsSubmenu() },
    { type: 'separator' },
    {
      label: '미니플레이어 닫기',
      click: () => {
        miniPlayerWindow?.hide()
        closeMiniLyricsPopup()
        miniLyricsVisible = false
        setConfig('miniPlayer.visible', false)
      }
    }
  ])
  menu.popup({ window: miniPlayerWindow })
})

// 미니 가사 팝업만 우클릭 → 페이드아웃 후 닫기
ipcMain.on('mini:hide-lyrics', () => {
  miniLyricsVisible = false
  if (miniPlayerWindow && !miniPlayerWindow.isDestroyed()) {
    miniPlayerWindow.webContents.send('lyrics:mini-visibility', false)
  }
  if (miniLyricsPopup && !miniLyricsPopup.isDestroyed()) {
    miniLyricsPopup.webContents.send('mini:fadeout')
    setTimeout(() => {
      closeMiniLyricsPopup()
    }, 300)
  }
})

// ─── Artist Lookup (YouTube oEmbed) ──────────────────────

async function fetchArtistFromOembed(videoId) {
  try {
    const url = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`
    const res = await net.fetch(url)
    const json = await res.json()
    return json.author_name || ''
  } catch {
    return ''
  }
}

// ─── Lyrics (LRCLIB API) ─────────────────────────────────

function cleanTrackTitle(title) {
  return title
    // 괄호/대괄호 안의 불필요한 태그 제거
    .replace(/\s*[\(\[].*?(?:MV|M\/V|Official|Music Video|Lyrics?|Lyric|Live|Audio|HD|4K|Ver\.|Version|Remix|Remaster|from\s|Soundtrack|OST|Visualizer|Performance|Teaser|Preview|Short|Clip|Full|Extended).*?[\)\]]/gi, '')
    // 괄호 없이 붙은 태그
    .replace(/\s*[-|]?\s*(?:Official|Music)\s*(?:Video|MV|M\/V|Audio)/gi, '')
    // 단독 M/V, MV (끝에 붙은 경우)
    .replace(/\s+(?:M\/V|MV)$/i, '')
    // feat/ft/prod 등
    .replace(/\s*[\(\[]?\s*(?:feat\.?|ft\.?|prod\.?|with)\s+[^)\]]*[\)\]]?/gi, '')
    // 앞뒤 특수문자 정리
    .replace(/^\s*[-–—|:]+\s*/, '')
    .replace(/\s*[-–—|:]+\s*$/, '')
    .trim()
}

function cleanArtistName(artist) {
  return artist
    .replace(/^OFFICIAL[_\s-]+/i, '')        // "OFFICIAL_NELL" → "NELL"
    .replace(/\s*[-–]\s*Topic$/i, '')        // "Artist - Topic" → "Artist"
    .replace(/VEVO$/i, '')                    // "ArtistVEVO" → "Artist"
    .replace(/\s*Official$/i, '')             // "Artist Official" → "Artist"
    .replace(/\s*[\(\[]Official[)\]]/gi, '')  // "Artist (Official)" → "Artist"
    .replace(/[_]+/g, ' ')                    // 남은 언더스코어 → 공백
    .trim()
}

// 문자열 유사도 (단어 단위 포함 비율)
function titleMatch(a, b) {
  if (!a || !b) return 0
  const na = a.toLowerCase().replace(/[^\w\s\uAC00-\uD7AF]/g, '').trim()
  const nb = b.toLowerCase().replace(/[^\w\s\uAC00-\uD7AF]/g, '').trim()
  if (na === nb) return 1
  // b의 단어가 a에 포함되는 비율
  const wordsB = nb.split(/\s+/).filter(w => w.length > 1)
  if (!wordsB.length) return 0
  const matched = wordsB.filter(w => na.includes(w)).length
  return matched / wordsB.length
}

async function lrclibSearch(params, expectedTrack, expectedArtist) {
  try {
    const url = `https://lrclib.net/api/search?${params.toString()}`
    const res = await net.fetch(url, {
      headers: { 'User-Agent': 'YouTubeMusic Desktop App/1.0' }
    })
    let results = await res.json()
    if (!results.length) return null

    // 결과 검증: 예상 트랙명이 있으면 관련 없는 결과 필터링
    if (expectedTrack) {
      const filtered = results.filter(r =>
        titleMatch(r.trackName, expectedTrack) >= 0.5 ||
        titleMatch(expectedTrack, r.trackName) >= 0.5
      )
      if (filtered.length) {
        results = filtered
      } else if (expectedArtist) {
        const loose = results.filter(r =>
          titleMatch(r.artistName, expectedArtist) >= 0.5 ||
          titleMatch(expectedArtist, r.artistName) >= 0.5
        )
        if (loose.length) {
          results = loose
        } else {
          return null
        }
      }
    }

    // 언어 판별
    const hasKorean = (text) => /[\uAC00-\uD7AF\u1100-\u11FF]/.test(text || '')
    const hasJapanese = (text) => /[\u3040-\u309F\u30A0-\u30FF]/.test(text || '')
    const getLyricsText = (r) => r.syncedLyrics || r.plainLyrics || ''

    const syncedResults = results.filter(r => r.syncedLyrics)

    // 우선순위: 한글싱크 > 한글일반 > 비일본어싱크 > 아무싱크 > 아무거나
    const koreanSynced = syncedResults.find(r => hasKorean(getLyricsText(r)))
    const koreanAny = results.find(r => hasKorean(getLyricsText(r)))
    const nonJpSynced = syncedResults.find(r => !hasJapanese(getLyricsText(r)))

    const best = koreanSynced || koreanAny || nonJpSynced || syncedResults[0] || results[0]
    const lyrics = { plain: best.plainLyrics || '', synced: null, source: 'lrclib' }
    if (best.syncedLyrics) {
      lyrics.synced = parseLRC(best.syncedLyrics)
    }
    return lyrics
  } catch {
    return null
  }
}

// 제목에서 "아티스트 - 제목" 또는 "제목 - 아티스트" 패턴 추출
function extractArtistFromTitle(title) {
  // 구분자: " - ", " – ", " — ", " | "
  const sep = /\s+[-–—|]\s+/
  const match = title.match(sep)
  if (!match) return null

  const parts = title.split(sep, 2).map(s => s.trim())
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null

  return [
    { artist: parts[0], track: parts[1] },  // "아티스트 - 제목"
    { artist: parts[1], track: parts[0] }   // "제목 - 아티스트"
  ]
}

async function fetchLyrics(title, artist) {
  const cleanedArtist = cleanArtistName(artist)

  // 원본 제목에서 먼저 아티스트-제목 분리 (cleanTrackTitle 전에)
  const lightCleaned = title
    .replace(/\s*\[.*?\]/g, '')   // [Official Audio], [MV] 등 대괄호 제거
    .replace(/\s*[-–—|:]+\s*$/, '').trim()
  const titleParts = extractArtistFromTitle(lightCleaned)

  const cleanedTitle = cleanTrackTitle(title)

  // 1단계: 제목에서 분리된 아티스트-제목 (가장 정확)
  if (titleParts) {
    for (const { artist: tArtist, track: tTrack } of titleParts) {
      const ct = cleanTrackTitle(tTrack)
      const ca = cleanArtistName(tArtist)
      if (ct.length > 1 && ca.length > 0) {
        let result = await lrclibSearch(new URLSearchParams({
          track_name: ct, artist_name: ca
        }), ct, ca)
        if (result) return result
        // 아티스트 괄호 제거 후 재시도 (예: "G-DRAGON (지드래곤)" → "G-DRAGON")
        const bareArtist = ca.replace(/\s*[\(\[][^\)\]]*[\)\]]/g, '').trim()
        if (bareArtist && bareArtist !== ca) {
          result = await lrclibSearch(new URLSearchParams({
            track_name: ct, artist_name: bareArtist
          }), ct, bareArtist)
          if (result) return result
        }
      }
    }
  }

  // 2단계: 클리닝된 제목 + 채널명 아티스트
  let result = await lrclibSearch(new URLSearchParams({
    track_name: cleanedTitle, artist_name: cleanedArtist
  }), cleanedTitle, cleanedArtist)
  if (result) return result

  // 3단계: 클리닝된 제목만 (아티스트 없이)
  const expectTrack = titleParts ? titleParts[0].track : cleanedTitle
  result = await lrclibSearch(new URLSearchParams({
    track_name: cleanedTitle
  }), expectTrack)
  if (result) return result

  // 4단계: 괄호 내용 전부 제거한 제목 + 아티스트
  const bareTitle = cleanedTitle.replace(/\s*[\(\[][^\)\]]*[\)\]]/g, '').trim()
  if (bareTitle !== cleanedTitle && bareTitle.length > 1) {
    result = await lrclibSearch(new URLSearchParams({
      track_name: bareTitle, artist_name: cleanedArtist
    }), bareTitle, cleanedArtist)
    if (result) return result

    // 4-1: bareTitle에서도 아티스트-제목 패턴 추출
    const bareParts = extractArtistFromTitle(bareTitle)
    if (bareParts) {
      for (const { artist: tArtist, track: tTrack } of bareParts) {
        if (tTrack.length > 1 && tArtist.length > 0) {
          result = await lrclibSearch(new URLSearchParams({
            track_name: tTrack, artist_name: tArtist
          }), tTrack, tArtist)
          if (result) return result
        }
      }
    }
  }

  // 5단계: q 파라미터로 통합 검색 (제목+아티스트 합쳐서)
  result = await lrclibSearch(new URLSearchParams({
    q: `${cleanedTitle} ${cleanedArtist}`
  }), expectTrack)
  if (result) return result

  // 6단계: 원본 제목으로 마지막 시도
  if (cleanedTitle !== title) {
    result = await lrclibSearch(new URLSearchParams({
      track_name: title
    }), expectTrack)
    if (result) return result
  }

  // 7단계: 한글 괄호 내용 추출 + 하이픈 분리
  const koreanInParens = title.match(/[\(\[]([\uAC00-\uD7AF\s]+)[\)\]]/)
  if (koreanInParens) {
    const koTitle = koreanInParens[1].trim()
    result = await lrclibSearch(new URLSearchParams({
      track_name: koTitle, artist_name: cleanedArtist
    }), koTitle, cleanedArtist)
    if (result) return result

    // 7-1: 한글 제목에서도 하이픈 분리 시도
    const koParts = extractArtistFromTitle(koTitle)
    if (koParts) {
      for (const { artist: tA, track: tT } of koParts) {
        if (tT.length > 1 && tA.length > 0) {
          result = await lrclibSearch(new URLSearchParams({
            track_name: tT, artist_name: tA
          }), tT, tA)
          if (result) return result
        }
      }
    }
  }

  // 7-2: 영문 하이픈 분리 (cleanedTitle에서)
  const enParts = extractArtistFromTitle(cleanedTitle)
  if (enParts && !titleParts) {
    for (const { artist: tA, track: tT } of enParts) {
      if (tT.length > 1 && tA.length > 0) {
        result = await lrclibSearch(new URLSearchParams({
          track_name: tT, artist_name: tA
        }), tT, tA)
        if (result) return result
      }
    }
  }

  // 8단계: 아티스트 괄호 변형 (예: "G-DRAGON (지드래곤)" → "G-DRAGON" / "지드래곤")
  const artistParens = (artist || '').match(/[\(\[](.*?)[\)\]]/)
  if (artistParens) {
    const innerArtist = artistParens[1].trim()
    const outerArtist = artist.replace(/\s*[\(\[][^\)\]]*[\)\]]/g, '').trim()
    for (const tryArtist of [innerArtist, outerArtist]) {
      if (tryArtist) {
        result = await lrclibSearch(new URLSearchParams({
          track_name: cleanedTitle, artist_name: tryArtist
        }), cleanedTitle, tryArtist)
        if (result) return result
      }
    }
  }

  return result
}

function parseLRC(lrcText) {
  const lines = []
  for (const line of lrcText.split('\n')) {
    const match = line.match(/^\[(\d{2}):(\d{2})\.(\d{2,3})\]\s*(.*)$/)
    if (match) {
      const min = parseInt(match[1])
      const sec = parseInt(match[2])
      const ms = parseInt(match[3].padEnd(3, '0'))
      const time = min * 60 + sec + ms / 1000
      const text = match[4].trim()
      if (text) lines.push({ time, text })
    }
  }
  return lines.length ? lines : null
}

// ─── Netease Lyrics (폴백 가사 소스) ──────────────────────

async function neteaseSearch(title, artist) {
  try {
    const query = artist ? `${artist} ${title}` : title
    const url = `https://music.163.com/api/search/get/web?s=${encodeURIComponent(query)}&type=1&limit=10`
    const res = await net.fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Referer': 'https://music.163.com'
      }
    })
    const json = await res.json()
    const songs = json?.result?.songs || []
    return songs.map(s => ({
      id: s.id,
      name: s.name,
      artist: s.artists?.map(a => a.name).join(', ') || '',
      album: s.album?.name || ''
    }))
  } catch {
    return []
  }
}

async function neteaseLyrics(songId) {
  try {
    const url = `https://music.163.com/api/song/lyric?id=${songId}&lv=1&kv=1&tv=-1`
    const res = await net.fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Referer': 'https://music.163.com'
      }
    })
    const json = await res.json()
    const lrcText = json?.lrc?.lyric || ''
    if (!lrcText) return null

    // 중국어 전용 가사 감지 (한글 없이 중국어만 있으면 스킵)
    const hasChinese = /[\u4e00-\u9fff]/.test(lrcText)
    const hasKorean = /[\uAC00-\uD7AF\u1100-\u11FF]/.test(lrcText)
    const isChineseOnly = hasChinese && !hasKorean

    const lyrics = { plain: lrcText.replace(/\[\d{2}:\d{2}\.\d{2,3}\]/g, '').trim(), synced: null, source: 'netease', isChineseOnly }
    const synced = parseLRC(lrcText)
    if (synced) lyrics.synced = synced
    return lyrics
  } catch {
    return null
  }
}

async function fetchLyricsFromNetease(title, artist) {
  const queries = []

  // 원본 제목+아티스트
  queries.push({ title, artist })

  // 한글 괄호 내용 추출 (예: "제목 (한글제목)" → "한글제목")
  const koreanInParens = title.match(/[\(\[]([\uAC00-\uD7AF\s]+)[\)\]]/)
  if (koreanInParens) {
    queries.push({ title: koreanInParens[1].trim(), artist })
  }

  // 아티스트 괄호 변형
  const bareArtist = (artist || '').replace(/\s*[\(\[][^\)\]]*[\)\]]/g, '').trim()
  if (bareArtist && bareArtist !== artist) {
    queries.push({ title, artist: bareArtist })
  }

  for (const q of queries) {
    const results = await neteaseSearch(q.title, q.artist)
    for (const r of results) {
      const lyrics = await neteaseLyrics(r.id)
      if (lyrics && !lyrics.isChineseOnly) return lyrics
    }
  }
  return null
}

// ─── Enhanced searchAndSendLyrics ─────────────────────────

async function searchAndSendLyrics(title, artist) {
  // 1. 저장된 가사 선택이 있으면 우선 사용
  const saved = getSavedLyricsSelection(currentMedia.videoId)
  if (saved) {
    const savedLyrics = await fetchLyricsById(saved.source, saved.id)
    if (savedLyrics) {
      currentLyrics = savedLyrics
      sendLyricsToAll()
      return
    }
  }

  // 2. LRCLIB (8단계 폴백)
  currentLyrics = await fetchLyrics(title, artist)

  // 3. Netease 폴백 (LRCLIB 실패 시)
  if (!currentLyrics) {
    console.log(`[Lyrics] LRCLIB 실패, Netease 폴백 시도...`)
    currentLyrics = await fetchLyricsFromNetease(title, artist)
  }

  sendLyricsToAll()
}

function sendLyricsToAll() {
  // 메인 창에 전송
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('lyrics:update', currentLyrics)
  }
  // 가사 팝업에 전송 + 저장된 싱크 오프셋
  if (miniLyricsPopup && !miniLyricsPopup.isDestroyed()) {
    miniLyricsPopup.webContents.send('lyrics:update', currentLyrics)
    const offset = getSyncOffset(currentMedia.videoId)
    miniLyricsPopup.webContents.send('lyrics:sync-offset', offset)
  }
}

// ─── Helpers ──────────────────────────────────────────────

function getTimeAgo(timestamp) {
  const diff = Date.now() - timestamp
  const min = Math.floor(diff / 60000)
  if (min < 1) return '방금'
  if (min < 60) return `${min}분 전`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}시간 전`
  const day = Math.floor(hr / 24)
  return `${day}일 전`
}

function restorePlayback() {
  if (!youtubeView || youtubeView.webContents.isDestroyed()) return
  youtubeView.webContents.executeJavaScript(`
    (() => {
      const restore = () => {
        const v = document.querySelector('video');
        if (v && v.paused) v.play().catch(() => {});
      };
      [200, 500, 1000, 2000, 3000].forEach(ms => setTimeout(restore, ms));
    })()
  `).catch(() => {})
}

function sendToYoutube(channel, data) {
  if (youtubeView) {
    youtubeView.webContents.send(channel, data)
  }
}

function registerShortcuts() {
  globalShortcut.register('CommandOrControl+M', toggleMiniPlayer)
  globalShortcut.register('CommandOrControl+L', () => {
    lyricsVisible = !lyricsVisible
    if (mainWindow && !mainWindow.isDestroyed()) {
      const wasPlaying = currentMedia.isPlaying
      mainWindow.webContents.send('lyrics:visibility', lyricsVisible)
      adjustYoutubeViewBoundsImmediate()
      if (wasPlaying) restorePlayback()
    }
  })
  globalShortcut.register('CommandOrControl+W', () => {
    if (mainWindow && mainWindow.isVisible()) mainWindow.hide()
  })
}

function getIconPath() {
  return path.join(__dirname, 'assets', 'icon.png')
}

// ─── Auto Updater (electron-updater) ─────────────────────

let autoUpdater = null

function setupAutoUpdater() {
  try {
    autoUpdater = require('electron-updater').autoUpdater
  } catch {
    console.log('[Updater] electron-updater not installed, skipping auto-update')
    return
  }

  const token = getConfig('updaterToken')
  if (!token) {
    console.log('[Updater] No updater token configured, skipping')
    return
  }

  autoUpdater.setFeedURL({
    provider: 'github',
    owner: 'porock8409-pixel',
    repo: 'youtube-music',
    private: true,
    token
  })

  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('update-available', (info) => {
    dialog.showMessageBox({
      type: 'info',
      title: '업데이트 가능',
      message: `새 버전 ${info.version}이 있습니다. 다운로드하시겠습니까?`,
      buttons: ['다운로드', '나중에'],
      defaultId: 0
    }).then(({ response }) => {
      if (response === 0) autoUpdater.downloadUpdate()
    })
  })

  autoUpdater.on('update-downloaded', () => {
    dialog.showMessageBox({
      type: 'info',
      title: '업데이트 준비 완료',
      message: '업데이트가 다운로드되었습니다. 지금 재시작하시겠습니까?',
      buttons: ['재시작', '나중에'],
      defaultId: 0
    }).then(({ response }) => {
      if (response === 0) autoUpdater.quitAndInstall()
    })
  })

  autoUpdater.on('error', (err) => {
    console.log('[Updater] Error:', err.message)
  })
}

function checkForUpdates() {
  if (!autoUpdater) return
  autoUpdater.checkForUpdates().catch(() => {})
}

// ─── YouTube Login Detection ─────────────────────────────

async function checkYoutubeLogin() {
  try {
    const cookies = await session.defaultSession.cookies.get({ domain: '.youtube.com' })
    return cookies.some(c => c.name === 'SID' || c.name === 'SSID')
  } catch {
    return false
  }
}

// ─── Onboarding (첫 실행 가이드) ─────────────────────────

let onboardingWindow = null

function showOnboarding() {
  if (onboardingWindow && !onboardingWindow.isDestroyed()) {
    onboardingWindow.focus()
    return
  }

  onboardingWindow = new BrowserWindow({
    width: 480,
    height: 520,
    frame: false,
    resizable: false,
    icon: getIconPath(),
    backgroundColor: '#0f0f0f',
    webPreferences: {
      preload: path.join(__dirname, 'preload-ui.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  onboardingWindow.loadFile('renderer/onboarding.html')

  onboardingWindow.on('closed', () => {
    onboardingWindow = null
  })
}

ipcMain.on('onboarding:login', () => {
  // 메인 창 표시하여 YouTube 로그인
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show()
    mainWindow.focus()
  }
})

ipcMain.handle('youtube:check-login', async () => {
  return checkYoutubeLogin()
})

ipcMain.on('onboarding:finish', () => {
  setConfig('onboardingComplete', true)
  if (onboardingWindow && !onboardingWindow.isDestroyed()) {
    onboardingWindow.close()
    onboardingWindow = null
  }
  // 메인 창 숨기고 미니 플레이어 표시
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.hide()
  }
  createMiniPlayer()
})
