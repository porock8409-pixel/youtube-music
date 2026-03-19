const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  // 윈도우 컨트롤
  minimize: () => ipcRenderer.send('window:minimize'),
  maximize: () => ipcRenderer.send('window:maximize'),
  close: () => ipcRenderer.send('window:close'),
  toggleMini: () => ipcRenderer.send('window:toggle-mini'),

  // 네비게이션
  goBack: () => ipcRenderer.send('nav:back'),
  goForward: () => ipcRenderer.send('nav:forward'),
  goHome: () => ipcRenderer.send('nav:home'),

  // 미디어 컨트롤 (미니 플레이어용)
  playPause: () => ipcRenderer.send('control:play-pause'),
  next: () => ipcRenderer.send('control:next'),
  prev: () => ipcRenderer.send('control:prev'),

  // 미니 플레이어 닫기
  closeMini: () => ipcRenderer.send('mini:close'),
  hideMini: () => ipcRenderer.send('mini:hide'),
  hideMiniLyrics: () => ipcRenderer.send('mini:hide-lyrics'),

  // 가사
  toggleLyrics: () => ipcRenderer.send('lyrics:toggle'),
  toggleMiniLyrics: () => ipcRenderer.send('lyrics:toggle-mini'),
  seekTo: (time) => ipcRenderer.send('control:seek', time),
  adjustSync: (delta) => ipcRenderer.send('lyrics:adjust-sync', delta),
  resetSync: () => ipcRenderer.send('lyrics:reset-sync'),
  getLyricsCandidates: () => ipcRenderer.invoke('lyrics:get-candidates'),
  selectLyricsCandidate: (index) => ipcRenderer.invoke('lyrics:select-candidate', index),
  adjustOpacity: (delta) => ipcRenderer.send('mini:opacity', delta),
  moveWindow: (dx, dy) => ipcRenderer.send('mini:move', dx, dy),
  snapCheck: () => ipcRenderer.invoke('mini:snap-check'),
  resetPosition: () => ipcRenderer.send('mini:reset-position'),

  // 무음 / 볼륨 / 확장모드 / 즐겨찾기
  toggleMute: () => ipcRenderer.send('control:mute-toggle'),
  setVolume: (vol) => ipcRenderer.send('control:volume', vol),
  toggleExpanded: () => ipcRenderer.send('mini:toggle-expanded'),
  navigateUrl: (url, meta) => ipcRenderer.send('navigate:url', url, meta),
  addFavorite: () => ipcRenderer.send('favorite:add'),
  toggleFavorite: () => ipcRenderer.send('favorite:toggle'),
  requestFavorites: () => ipcRenderer.send('favorite:get'),
  requestHistory: () => ipcRenderer.send('history:get'),
  requestMedia: () => ipcRenderer.send('popup:request-media'),

  // 온보딩
  openYoutubeLogin: () => ipcRenderer.send('onboarding:login'),
  finishOnboarding: () => ipcRenderer.send('onboarding:finish'),
  checkYoutubeLogin: () => ipcRenderer.invoke('youtube:check-login'),

  // 보조 팝업 (가사/히스토리/검색)
  openPopup: (tab) => ipcRenderer.send('popup:open', tab),

  // 미니 플레이어 컨텍스트 메뉴
  showMiniContextMenu: () => ipcRenderer.send('mini:context-menu'),

  // YouTube 검색
  searchYoutube: (query, mode) => ipcRenderer.invoke('search:youtube', query, mode || 'video'),

  // 커스텀 큐 (하위 호환)
  addToQueue: (song) => ipcRenderer.send('queue:add', song),
  addBulkToQueue: (songs) => ipcRenderer.send('queue:add-bulk', songs),
  removeFromQueue: (videoId) => ipcRenderer.send('queue:remove', videoId),
  clearQueue: () => ipcRenderer.send('queue:clear'),
  playFromQueue: (index) => ipcRenderer.send('queue:play', index),
  requestQueue: () => ipcRenderer.send('queue:get'),
  toggleQueue: () => ipcRenderer.send('queue:toggle'),

  // 재생목록 관리 (신규)
  createPlaylist: (name) => ipcRenderer.send('playlist:create', { name }),
  renamePlaylist: (id, name) => ipcRenderer.send('playlist:rename', { id, name }),
  deletePlaylist: (id) => ipcRenderer.send('playlist:delete', { id }),
  duplicatePlaylist: (id, newName) => ipcRenderer.send('playlist:duplicate', { id, newName }),
  selectPlaylist: (id) => ipcRenderer.send('playlist:select', { id }),
  playFromPlaylist: (index) => ipcRenderer.send('playlist:play', index),
  addSongToPlaylist: (playlistId, song) => ipcRenderer.send('playlist:add-song', { playlistId, song }),
  addBulkToPlaylist: (playlistId, songs) => ipcRenderer.send('playlist:add-bulk', { playlistId, songs }),
  removeSongFromPlaylist: (playlistId, videoId) => ipcRenderer.send('playlist:remove-song', { playlistId, videoId }),
  reorderSong: (playlistId, fromIdx, toIdx) => ipcRenderer.send('playlist:reorder', { playlistId, fromIdx, toIdx }),
  clearPlaylist: (playlistId) => ipcRenderer.send('playlist:clear', { playlistId }),
  exportPlaylist: (id) => ipcRenderer.send('playlist:export', { id }),
  importPlaylist: () => ipcRenderer.send('playlist:import'),
  requestPlaylists: () => ipcRenderer.send('playlist:get'),

  // 이벤트 수신
  onMaximized: (callback) => ipcRenderer.on('window:maximized', (_, val) => callback(val)),
  onMediaUpdate: (callback) => ipcRenderer.on('media:update', (_, data) => callback(data)),
  onMediaProgress: (callback) => ipcRenderer.on('media:progress', (_, data) => callback(data)),
  onLyricsUpdate: (callback) => ipcRenderer.on('lyrics:update', (_, data) => callback(data)),
  onLyricsVisibility: (callback) => ipcRenderer.on('lyrics:visibility', (_, val) => callback(val)),
  onMiniLyricsVisibility: (callback) => ipcRenderer.on('lyrics:mini-visibility', (_, val) => callback(val)),
  onOpacityChanged: (callback) => ipcRenderer.on('mini:opacity-changed', (_, val) => callback(val)),
  onPlaylist: (callback) => ipcRenderer.on('media:playlist', (_, data) => callback(data)),
  onMarquee: (callback) => ipcRenderer.on('mini:marquee', (_, val) => callback(val)),
  onFadeout: (callback) => ipcRenderer.on('mini:fadeout', () => callback()),
  onFadein: (callback) => ipcRenderer.on('mini:fadein', () => callback()),
  onMarqueeSpeed: (callback) => ipcRenderer.on('mini:marquee-speed', (_, val) => callback(val)),
  onMiniMode: (callback) => ipcRenderer.on('mini:mode', (_, mode) => callback(mode)),
  onHistory: (callback) => ipcRenderer.on('mini:history', (_, data) => callback(data)),
  onMuteChanged: (callback) => ipcRenderer.on('media:mute-changed', (_, val) => callback(val)),
  onVolumeChanged: (callback) => ipcRenderer.on('media:volume-changed', (_, val) => callback(val)),
  onPopupTab: (callback) => ipcRenderer.on('popup:tab', (_, tab) => callback(tab)),
  onFavoriteState: (callback) => ipcRenderer.on('favorite:state', (_, val) => callback(val)),
  onFavoriteList: (callback) => ipcRenderer.on('favorite:list', (_, data) => callback(data)),
  onSyncOffset: (callback) => ipcRenderer.on('lyrics:sync-offset', (_, val) => callback(val)),
  onQueueUpdate: (callback) => ipcRenderer.on('queue:update', (_, data) => callback(data)),
  onPlaylistUpdate: (callback) => ipcRenderer.on('playlist:update', (_, data) => callback(data))
})
