const AVATARS = ['🦊', '🐼', '🐸', '🦁', '🐙', '🐝', '🦄', '🐯', '🐨', '🦉', '🐳', '🦖'];
const REACTIONS = ['🔥', '😂', '😮', '👏', '💀', '❤️'];
const ROUND_OPTIONS = [3, 5];
const TIME_OPTIONS = [60, 90, 120];
const PROFILE_KEY = 'wordrush.profile';
const SOUND_KEY = 'wordrush.sound';
const SESSION_PREFIX = 'wordrush.session.';
const LAST_SESSION_KEY = 'wordrush.lastSession';
const TIMER_CIRCUMFERENCE = 2 * Math.PI * 18;
const REDUCED_MOTION = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

const dom = {};
const app = {
  ws: null,
  wsReady: false,
  connected: false,
  hasConnected: false,
  reconnectAttempts: 0,
  reconnectTimer: null,
  pingTimer: null,
  pingSamples: [],
  serverOffset: 0,
  profile: loadProfile(),
  soundOn: loadSoundPreference(),
  room: null,
  you: null,
  playerId: null,
  token: null,
  sessionCode: null,
  resumeTarget: null,
  rejoining: false,
  awaitingState: false,
  landingBusy: null,
  starting: false,
  claimPending: false,
  claimTimer: null,
  path: [],
  gridKey: '',
  gridHintShown: false,
  screen: 'landing',
  lastStatus: undefined,
  lastScores: new Map(),
  lastFeedId: 0,
  feedInitialized: false,
  overlayDismissedKey: null,
  overlayOpenKey: null,
  confettiKey: null,
  confettiRaf: 0,
  uiRaf: 0,
  lastTimerSecond: null,
  lastTickSecond: null,
  audioCtx: null,
  reactionCooldownUntil: 0,
  bootAt: Date.now(),
};

function $(selector, root = document) {
  return root.querySelector(selector);
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function normalizeCode(value) {
  return String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
}

function pointsForLength(length) {
  if (length < 3) return 0;
  if (length === 3) return 1;
  if (length === 4) return 2;
  if (length === 5) return 3;
  if (length === 6) return 5;
  if (length === 7) return 8;
  return 12;
}

function serverNow() {
  return Date.now() + app.serverOffset;
}

function loadProfile() {
  try {
    const raw = localStorage.getItem(PROFILE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      const name = typeof parsed.name === 'string' ? parsed.name.slice(0, 14) : '';
      const avatar = AVATARS.includes(parsed.avatar) ? parsed.avatar : AVATARS[0];
      return { name, avatar };
    }
  } catch {
  }
  return { name: '', avatar: AVATARS[Math.floor(Math.random() * AVATARS.length)] };
}

function saveProfile() {
  try {
    localStorage.setItem(PROFILE_KEY, JSON.stringify(app.profile));
  } catch {
  }
}

function loadSoundPreference() {
  try {
    const raw = localStorage.getItem(SOUND_KEY);
    return raw === null ? true : raw === 'on';
  } catch {
    return true;
  }
}

function saveSoundPreference() {
  try {
    localStorage.setItem(SOUND_KEY, app.soundOn ? 'on' : 'off');
  } catch {
  }
}

function loadSession(code) {
  if (!code) return null;
  try {
    const raw = localStorage.getItem(SESSION_PREFIX + code);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.token !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

function saveSession(code, token, playerId) {
  try {
    localStorage.setItem(SESSION_PREFIX + code, JSON.stringify({ token, playerId }));
    localStorage.setItem(LAST_SESSION_KEY, JSON.stringify({ code, token, playerId }));
  } catch {
  }
}

function clearStoredSession(code) {
  try {
    localStorage.removeItem(SESSION_PREFIX + code);
    const raw = localStorage.getItem(LAST_SESSION_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed.code === code) localStorage.removeItem(LAST_SESSION_KEY);
    }
  } catch {
  }
}

function init() {
  dom.screens = {
    landing: $('#screen-landing'),
    lobby: $('#screen-lobby'),
    game: $('#screen-game'),
  };

  const ids = [
    'brand-link', 'connection-pill', 'connection-label', 'sound-btn', 'sound-icon',
    'play-eyebrow', 'play-heading', 'play-subcopy', 'new-room-link',
    'top-leave-btn', 'connection-banner', 'name-input', 'avatar-picker', 'create-btn',
    'code-input', 'join-btn', 'landing-error', 'room-code', 'copy-link-btn',
    'copy-code-btn', 'qr-img', 'lobby-count', 'host-badge', 'lobby-players',
    'host-settings', 'rounds-picker', 'time-picker', 'guest-settings', 'start-btn',
    'waiting-host', 'lobby-hint', 'round-current', 'round-total', 'timer',
    'timer-progress', 'timer-seconds', 'leave-btn', 'invite-btn', 'score-strip', 'grid',
    'round-found', 'word-display', 'clear-btn', 'submit-btn', 'word-points',
    'live-ticker', 'your-word-count', 'your-words', 'scoreboard', 'feed',
    'reaction-bar', 'results-overlay', 'overlay-close', 'overlay-eyebrow',
    'overlay-title', 'overlay-subtitle', 'podium', 'results-caption', 'results-list',
    'next-round-btn', 'rematch-btn', 'overlay-leave-btn', 'next-countdown', 'waiting-next', 'toasts',
    'confetti',
  ];
  for (const id of ids) {
    dom[id.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = document.getElementById(id);
  }

  dom.body = document.body;
  dom.app = $('.app');
  dom.wordDisplay = $('#word-display');
  dom.timerProgress = $('#timer-progress');
  dom.overlayCard = $('.overlay-card');
  dom.qrFrame = $('.qr-frame');

  renderAvatarPicker();
  setupSegmented(dom.roundsPicker, ROUND_OPTIONS, (value) => `${value} rounds`);
  setupSegmented(dom.timePicker, TIME_OPTIONS, (value) => `${value}s`);
  renderReactionBar();
  updateSoundButton();

  dom.nameInput.value = app.profile.name;
  dom.avatarPicker.querySelectorAll('.avatar-btn').forEach((button) => {
    button.setAttribute('aria-checked', String(button.dataset.avatar === app.profile.avatar));
  });

  const params = new URLSearchParams(window.location.search);
  const roomCode = normalizeCode(params.get('room'));
  if (roomCode) {
    setInviteMode(roomCode);
    const saved = loadSession(roomCode);
    if (saved?.token) {
      app.resumeTarget = { code: roomCode, token: saved.token };
      app.rejoining = true;
    }
  }

  wireEvents();
  showScreen('landing');
  updateConnectionUI('connecting');
  updateLandingControls();
  connectSocket();

  app.pingTimer = setInterval(() => {
    if (app.wsReady) sendMessage({ type: 'ping', t: Date.now() });
  }, 8000);

  window.setTimeout(() => {
    if (!app.connected) updateConnectionBanner();
  }, 1600);

  startUiLoop();
}

function wireEvents() {
  dom.brandLink.addEventListener('click', (event) => {
    event.preventDefault();
    if (app.room) {
      toast('You are already in a room. Use Leave to exit.', 'info');
    } else {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  });

  dom.nameInput.addEventListener('input', () => {
    app.profile.name = dom.nameInput.value;
    saveProfile();
    setLandingError('');
  });
  dom.nameInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    if (normalizeCode(dom.codeInput.value).length === 4) handleJoin();
    else handleCreate();
  });

  dom.codeInput.addEventListener('input', () => {
    const normalized = normalizeCode(dom.codeInput.value);
    if (dom.codeInput.value !== normalized) dom.codeInput.value = normalized;
    setLandingError('');
  });
  dom.codeInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    handleJoin();
  });

  dom.createBtn.addEventListener('click', handleCreate);
  dom.joinBtn.addEventListener('click', handleJoin);
  dom.newRoomLink.addEventListener('click', () => {
    setInviteMode('');
    dom.codeInput.value = '';
    const url = new URL(window.location.href);
    url.search = '';
    history.replaceState({}, '', url);
    setLandingError('');
    dom.nameInput.focus();
  });

  dom.copyLinkBtn.addEventListener('click', () => {
    if (!app.room) return;
    copyText(`${window.location.origin}/?room=${app.room.code}`, 'Invite link copied!');
  });
  dom.copyCodeBtn.addEventListener('click', () => {
    if (!app.room) return;
    copyText(app.room.code, 'Room code copied!');
  });

  dom.startBtn.addEventListener('click', handleStart);
  dom.roundsPicker.addEventListener('click', handleSegmentedClick);
  dom.timePicker.addEventListener('click', handleSegmentedClick);

  dom.grid.addEventListener('click', (event) => {
    const tile = event.target.closest('.tile');
    if (!tile) return;
    handleTileTap(Number(tile.dataset.index));
  });

  dom.clearBtn.addEventListener('click', clearPath);
  dom.submitBtn.addEventListener('click', submitWord);

  dom.soundBtn.addEventListener('click', toggleSound);
  dom.leaveBtn.addEventListener('click', leaveRoom);
  dom.topLeaveBtn.addEventListener('click', leaveRoom);
  dom.inviteBtn.addEventListener('click', () => {
    if (!app.room) return;
    copyText(`${window.location.origin}/?room=${app.room.code}`, 'Invite link copied!');
  });

  dom.reactionBar.addEventListener('click', (event) => {
    const button = event.target.closest('.reaction-btn');
    if (!button) return;
    sendReaction(button.dataset.emoji);
  });

  dom.overlayClose.addEventListener('click', () => closeResultsOverlay());
  dom.nextRoundBtn.addEventListener('click', () => {
    if (!app.room || !app.you?.canNext) return;
    dom.nextRoundBtn.disabled = true;
    if (!sendMessage({ type: 'nextRound' })) {
      dom.nextRoundBtn.disabled = false;
      toast('Still reconnecting…', 'info');
    }
  });
  dom.rematchBtn.addEventListener('click', () => {
    if (!app.room || !app.you?.canRematch) return;
    dom.rematchBtn.disabled = true;
    if (!sendMessage({ type: 'rematch' })) {
      dom.rematchBtn.disabled = false;
      toast('Still reconnecting…', 'info');
    }
  });
  dom.overlayLeaveBtn.addEventListener('click', leaveRoom);

  document.addEventListener('keydown', handleGlobalKeydown);

  window.addEventListener('online', () => {
    if (!app.ws || app.ws.readyState > 1) {
      app.reconnectAttempts = 0;
      connectSocket();
    }
  });
  window.addEventListener('offline', () => {
    updateConnectionUI('offline');
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && (!app.ws || app.ws.readyState > 1)) {
      app.reconnectAttempts = 0;
      connectSocket();
    }
  });

  document.addEventListener('pointerdown', unlockAudio, { passive: true });
  dom.qrImg.addEventListener('error', () => {
    if (dom.qrFrame) dom.qrFrame.hidden = true;
  });
  dom.qrImg.addEventListener('load', () => {
    if (dom.qrFrame) dom.qrFrame.hidden = false;
  });
}

function renderAvatarPicker() {
  dom.avatarPicker.replaceChildren();
  for (const avatar of AVATARS) {
    const button = el('button', 'avatar-btn');
    button.type = 'button';
    button.dataset.avatar = avatar;
    button.setAttribute('role', 'radio');
    button.setAttribute('aria-checked', String(avatar === app.profile.avatar));
    button.setAttribute('aria-label', `Avatar ${avatar}`);
    button.textContent = avatar;
    button.addEventListener('click', () => {
      app.profile.avatar = avatar;
      saveProfile();
      dom.avatarPicker.querySelectorAll('.avatar-btn').forEach((node) => {
        node.setAttribute('aria-checked', String(node.dataset.avatar === avatar));
      });
    });
    dom.avatarPicker.append(button);
  }
}

function setupSegmented(container, options, label) {
  container.replaceChildren();
  for (const value of options) {
    const button = el('button', 'seg-btn', label(value));
    button.type = 'button';
    button.dataset.value = String(value);
    button.setAttribute('aria-pressed', 'false');
    container.append(button);
  }
}

function handleSegmentedClick(event) {
  const button = event.target.closest('.seg-btn');
  if (!button) return;
  if (!app.you?.isHost || app.room?.status !== 'lobby') return;
  const value = Number(button.dataset.value);
  if (button.closest('.segmented') === dom.roundsPicker) {
    sendSettings({ rounds: value, roundSeconds: app.room.settings.roundSeconds });
  } else {
    sendSettings({ rounds: app.room.settings.rounds, roundSeconds: value });
  }
}

function sendSettings(settings) {
  if (!sendMessage({ type: 'settings', ...settings })) {
    toast('Still connecting…', 'info');
  }
}

function renderReactionBar() {
  dom.reactionBar.replaceChildren();
  for (const emoji of REACTIONS) {
    const button = el('button', 'reaction-btn', emoji);
    button.type = 'button';
    button.dataset.emoji = emoji;
    button.setAttribute('aria-label', `React with ${emoji}`);
    dom.reactionBar.append(button);
  }
}

function updateSoundButton() {
  dom.soundIcon.textContent = app.soundOn ? '🔊' : '🔇';
  dom.soundBtn.setAttribute('aria-label', app.soundOn ? 'Mute sounds' : 'Unmute sounds');
  dom.soundBtn.title = app.soundOn ? 'Mute sounds' : 'Unmute sounds';
}

function toggleSound() {
  app.soundOn = !app.soundOn;
  saveSoundPreference();
  updateSoundButton();
  if (app.soundOn) {
    ensureAudio();
    sfx.click();
  }
}

function connectSocket() {
  if (app.ws && (app.ws.readyState === 0 || app.ws.readyState === 1)) return;
  clearTimeout(app.reconnectTimer);
  app.reconnectTimer = null;
  updateConnectionUI('connecting');

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
  app.ws = ws;
  app.wsReady = false;

  ws.addEventListener('open', () => {
    if (app.ws !== ws) return;
    app.wsReady = true;
    app.connected = true;
    app.hasConnected = true;
    app.reconnectAttempts = 0;
    updateConnectionUI('online');
    sendMessage({ type: 'ping', t: Date.now() });
    if (app.resumeTarget) {
      sendMessage({ type: 'resume', code: app.resumeTarget.code, token: app.resumeTarget.token });
    }
    updateLandingControls();
    if (app.room) renderGame();
  });

  ws.addEventListener('message', (event) => {
    if (app.ws !== ws) return;
    handleSocketMessage(event.data);
  });

  ws.addEventListener('close', (event) => {
    if (app.ws !== ws) return;
    const wasTakenOver = event.code === 4001;
    app.ws = null;
    app.wsReady = false;
    app.connected = false;

    if (wasTakenOver) {
      handleSessionTakenOver();
      return;
    }

    updateConnectionUI('offline');
    if (app.rejoining) {
      app.rejoining = false;
      app.resumeTarget = null;
      setLandingError('Could not reconnect to that room. Try joining again.');
    }
    updateLandingControls();
    if (app.room) renderWord();
    scheduleReconnect();
  });

  ws.addEventListener('error', () => {
  });
}

function scheduleReconnect() {
  if (app.reconnectTimer) return;
  const delay = Math.min(1000 * (2 ** app.reconnectAttempts), 10000);
  app.reconnectAttempts += 1;
  app.reconnectTimer = setTimeout(() => {
    app.reconnectTimer = null;
    connectSocket();
  }, delay);
}

function sendMessage(payload) {
  if (!app.ws || app.ws.readyState !== 1) return false;
  try {
    app.ws.send(JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

function handleSocketMessage(raw) {
  let message;
  try {
    message = JSON.parse(raw);
  } catch {
    return;
  }
  if (!message || typeof message.type !== 'string') return;

  switch (message.type) {
    case 'hello':
      if (app.pingSamples.length === 0) {
        app.serverOffset = message.serverNow - Date.now();
      }
      break;
    case 'session':
      handleSession(message);
      break;
    case 'state':
      applyState(message);
      break;
    case 'pong':
      handlePong(message);
      break;
    case 'claimOk':
      handleClaimOk(message);
      break;
    case 'error':
      handleServerError(message);
      break;
    case 'left':
      handleLeft();
      break;
    default:
      break;
  }
}

function handleSession(message) {
  app.playerId = message.playerId;
  app.token = message.token;
  app.sessionCode = message.code;
  app.resumeTarget = { code: message.code, token: message.token };
  app.rejoining = false;
  app.landingBusy = null;
  app.awaitingState = true;
  saveSession(message.code, message.token, message.playerId);
  setLandingError('');
  updateRoomUrl(message.code);
  updateLandingControls();
  window.setTimeout(() => {
    if (app.awaitingState) {
      app.awaitingState = false;
      updateLandingControls();
    }
  }, 2500);
}

function handlePong(message) {
  if (!Number.isFinite(message.t) || !Number.isFinite(message.serverNow)) return;
  const receivedAt = Date.now();
  const rtt = receivedAt - message.t;
  const offset = message.serverNow - (message.t + receivedAt) / 2;
  app.pingSamples.push({ rtt, offset, at: receivedAt });
  app.pingSamples = app.pingSamples.filter((sample) => receivedAt - sample.at < 30000);
  if (app.pingSamples.length > 8) app.pingSamples = app.pingSamples.slice(-8);
  const best = app.pingSamples.reduce((winner, sample) => (sample.rtt < winner.rtt ? sample : winner));
  app.serverOffset = best.offset;
}

function handleSessionTakenOver() {
  clearLocalSession();
  setLandingError('This room is open in another tab. Use that tab or rejoin here.');
  toast('Session opened in another tab.', 'info');
  app.reconnectAttempts = 0;
  scheduleReconnect();
}

function handleLeft() {
  clearLocalSession();
  toast('You left the room.', 'info');
}

function applyState(message) {
  const previousStatus = app.lastStatus;
  const previousRound = app.room?.roundNumber;
  app.room = message.room;
  app.you = message.you;
  app.sessionCode = message.room.code;
  app.awaitingState = false;
  app.landingBusy = null;
  app.starting = false;
  app.rejoining = false;

  if (app.pingSamples.length === 0 && Number.isFinite(message.serverNow)) {
    app.serverOffset = message.serverNow - Date.now();
  }

  updateRoomUrl(message.room.code);
  updateLandingControls();

  if (message.room.status === 'lobby') {
    showScreen('lobby');
    closeResultsOverlay(true);
    clearConfetti();
    stopTimerDisplay();
    renderLobby();
    document.title = `Room ${message.room.code} · Word Rush`;
  } else {
    showScreen('game');
    ensureGrid();
    renderGame();
    if (previousStatus !== message.room.status || previousRound !== message.room.roundNumber) {
      app.overlayDismissedKey = null;
    }

    if (message.room.status === 'playing') {
      closeResultsOverlay(true);
      clearConfetti();
      if (message.room.roundNumber === 1) app.confettiKey = null;
      app.claimPending = false;
      clearTimeout(app.claimTimer);
      renderWord();
      document.title = `Round ${message.room.roundNumber} · Word Rush`;
    } else if (message.room.status === 'roundResult') {
      showRoundResults();
      document.title = 'Round results · Word Rush';
    } else if (message.room.status === 'gameOver') {
      showFinalResults();
      document.title = 'Final scores · Word Rush';
    }
  }

  if (previousStatus !== message.room.status) {
    if (message.room.status === 'playing' && previousStatus !== undefined) sfx.start();
    if (message.room.status === 'roundResult' && previousStatus === 'playing') sfx.chime();
  }

  app.lastStatus = message.room.status;
  updateConnectionBanner();
}

function ensureGrid() {
  const grid = app.room?.grid;
  const key = Array.isArray(grid) ? grid.join('') : '';
  if (key && key !== app.gridKey) {
    app.gridKey = key;
    app.path = [];
    app.gridHintShown = false;
    app.lastTimerSecond = null;
    app.lastTickSecond = null;
    buildGrid();
  }
  if (!key) app.gridKey = '';
  updateTiles();
}

function buildGrid() {
  dom.grid.replaceChildren();
  app.room.grid.forEach((letter, index) => {
    const row = Math.floor(index / 4) + 1;
    const column = (index % 4) + 1;
    const tile = el('button', 'tile');
    tile.type = 'button';
    tile.dataset.index = String(index);
    tile.dataset.letter = letter;
    tile.setAttribute('aria-label', `Letter ${letter}, row ${row}, column ${column}`);
    tile.setAttribute('aria-pressed', 'false');
    const text = el('span', 'tile-letter', letter);
    const order = el('span', 'tile-order');
    order.setAttribute('aria-hidden', 'true');
    tile.append(order, text);
    dom.grid.append(tile);
  });
}

function updateTiles() {
  const tiles = dom.grid.querySelectorAll('.tile');
  const selected = new Map();
  app.path.forEach((index, position) => selected.set(index, position + 1));
  tiles.forEach((tile) => {
    const index = Number(tile.dataset.index);
    const order = selected.get(index);
    tile.classList.toggle('is-selected', Boolean(order));
    tile.classList.toggle('is-last', order === app.path.length);
    tile.setAttribute('aria-pressed', String(Boolean(order)));
    const orderNode = tile.querySelector('.tile-order');
    if (orderNode) orderNode.textContent = order ? String(order) : '';
  });
  renderWord();
}

function showScreen(name) {
  for (const [screenName, screen] of Object.entries(dom.screens)) {
    screen.hidden = screenName !== name;
  }
  app.screen = name;
  document.body.dataset.screen = name;
  dom.topLeaveBtn.hidden = !app.room;
  window.scrollTo(0, 0);
  updateConnectionBanner();
}

function renderLobby() {
  if (!app.room || app.room.status !== 'lobby') return;
  const room = app.room;
  renderRoomCode(room.code);
  dom.lobbyCount.textContent = `${room.players.length}/${room.maxPlayers}`;

  if (dom.qrImg.dataset.code !== room.code) {
    dom.qrImg.dataset.code = room.code;
    dom.qrImg.src = `/api/qr?room=${encodeURIComponent(room.code)}`;
    if (dom.qrFrame) dom.qrFrame.hidden = false;
  }

  const host = room.players.find((player) => player.id === room.hostId);
  dom.hostBadge.textContent = app.you?.isHost ? 'You are the host' : `Host: ${host?.name ?? '—'}`;

  const sortedPlayers = [...room.players].sort((a, b) => {
    if (a.isHost !== b.isHost) return a.isHost ? -1 : 1;
    if ((a.id === app.you?.id) !== (b.id === app.you?.id)) return a.id === app.you?.id ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  dom.lobbyPlayers.replaceChildren();
  for (const player of sortedPlayers) {
    const row = el('li', `player-row${player.id === app.you?.id ? ' is-you' : ''}${player.connected ? '' : ' is-offline'}`);
    const avatar = el('span', 'player-avatar', player.avatar);
    const info = el('div');
    const nameLine = el('div', 'player-meta');
    const name = el('span', 'player-name', player.name);
    nameLine.append(name);
    if (player.isHost) nameLine.append(el('span', 'tag tag-host', 'host'));
    if (player.id === app.you?.id) nameLine.append(el('span', 'tag tag-you', 'you'));
    info.append(nameLine);
    row.append(avatar, info);
    const status = el('span', 'player-status', player.connected ? 'ready' : 'offline');
    row.append(status);
    dom.lobbyPlayers.append(row);
  }

  const emptySlots = Math.max(0, Math.min(2, 3 - sortedPlayers.length));
  for (let i = 0; i < emptySlots; i += 1) {
    const slot = el('li', 'empty-slot');
    slot.append(el('span', 'empty-avatar', '＋'), el('span', '', 'Invite a friend'));
    dom.lobbyPlayers.append(slot);
  }

  dom.hostSettings.hidden = !app.you?.isHost;
  dom.guestSettings.hidden = Boolean(app.you?.isHost);
  dom.guestSettings.textContent = `${room.settings.rounds} rounds · ${room.settings.roundSeconds} seconds each`;
  dom.startBtn.hidden = !app.you?.isHost;
  dom.waitingHost.hidden = Boolean(app.you?.isHost);

  dom.roundsPicker.querySelectorAll('.seg-btn').forEach((button) => {
    button.setAttribute('aria-pressed', String(Number(button.dataset.value) === room.settings.rounds));
  });
  dom.timePicker.querySelectorAll('.seg-btn').forEach((button) => {
    button.setAttribute('aria-pressed', String(Number(button.dataset.value) === room.settings.roundSeconds));
  });

  if (app.you?.isHost) {
    dom.startBtn.disabled = !app.wsReady || app.starting;
    dom.startBtn.innerHTML = app.starting
      ? 'Starting…'
      : (room.players.length === 1
        ? 'Start solo practice <span class="btn-arrow" aria-hidden="true">→</span>'
        : 'Start game <span class="btn-arrow" aria-hidden="true">→</span>');
    dom.lobbyHint.textContent = room.players.length === 1
      ? 'Invite a friend — or start solo to practice.'
      : 'Everyone gets the same board and the same countdown.';
  } else {
    dom.lobbyHint.textContent = 'The host can change rounds and round length.';
  }
}

function renderRoomCode(code) {
  dom.roomCode.replaceChildren();
  for (const char of code) {
    dom.roomCode.append(el('span', 'code-char', char));
  }
  dom.roomCode.setAttribute('aria-label', `Room code ${code.split('').join(' ')}`);
}

function renderGame() {
  if (!app.room) return;
  const room = app.room;
  dom.roundCurrent.textContent = String(Math.max(1, room.roundNumber));
  dom.roundTotal.textContent = String(room.totalRounds);
  updateTiles();
  renderScoreStrip();
  renderScoreboard();
  renderYourWords();
  renderFeed();
  renderReactionState();

  const totalFound = room.players.reduce((sum, player) => sum + (player.found ?? 0), 0);
  dom.roundFound.textContent = `${totalFound} word${totalFound === 1 ? '' : 's'} found`;
  updateTimerDisplay();
}

function renderScoreStrip() {
  if (!app.room) return;
  dom.scoreStrip.replaceChildren();
  for (const player of app.room.players) {
    const chip = el('span', `score-chip${player.id === app.you?.id ? ' is-you' : ''}`);
    chip.append(el('span', 'chip-avatar', player.avatar));
    chip.append(el('span', 'chip-name', player.name));
    chip.append(el('span', 'chip-score', String(player.score)));
    dom.scoreStrip.append(chip);
  }
  if (!app.room.players.length) {
    dom.scoreStrip.append(el('span', 'score-chip', 'Waiting for players…'));
  }
}

function renderScoreboard() {
  if (!app.room) return;
  dom.scoreboard.replaceChildren();
  const players = app.room.players;
  const topScore = players[0]?.score ?? 0;

  players.forEach((player, index) => {
    const row = el('li', `scoreboard-row${player.id === app.you?.id ? ' is-you' : ''}${player.score === topScore && topScore > 0 ? ' is-leader' : ''}`);
    row.append(el('span', 'rank', String(index + 1)));
    row.append(el('span', 'scoreboard-avatar', player.avatar));
    const nameWrap = el('span', 'scoreboard-name', player.name);
    if (player.isHost) nameWrap.append(el('span', 'tag tag-host', 'host'));
    row.append(nameWrap);
    if (!player.connected) row.append(el('span', 'offline-dot'));
    row.append(el('span', 'scoreboard-sub', `${player.found ?? 0} word${player.found === 1 ? '' : 's'}`));
    const score = el('span', 'scoreboard-score', String(player.score));
    const previous = app.lastScores.get(player.id);
    if (previous !== undefined && player.score > previous) score.classList.add('is-bumped');
    row.append(score);
    dom.scoreboard.append(row);
  });

  app.lastScores = new Map(players.map((player) => [player.id, player.score]));
}

function renderYourWords() {
  if (!app.you) return;
  const words = [...app.you.words].sort((a, b) => b.points - a.points || a.word.localeCompare(b.word));
  dom.yourWords.replaceChildren();
  dom.yourWordCount.textContent = String(words.length);
  for (const entry of words) {
    const chip = el('li', 'word-chip');
    chip.append(el('span', '', entry.word.toUpperCase()));
    chip.append(el('b', '', `+${entry.points}`));
    dom.yourWords.append(chip);
  }
}

function renderFeed() {
  if (!app.room) return;
  const feed = app.room.feed ?? [];
  const maxId = feed.reduce((max, item) => Math.max(max, item.id ?? 0), 0);
  if (!app.feedInitialized) {
    app.lastFeedId = maxId;
    app.feedInitialized = true;
  }
  const scrollTop = dom.feed.scrollTop;
  dom.feed.replaceChildren();
  const newReactions = [];

  for (const item of feed) {
    const isNew = item.id > app.lastFeedId;
    const row = el('li', `feed-item${isNew ? ' is-new' : ''}`);
    if (item.kind === 'system') {
      row.classList.add('feed-system');
      row.textContent = item.text ?? '';
    } else {
      row.append(el('span', 'feed-avatar', item.avatar ?? ''));
      const text = el('span', 'feed-text');
      const strong = el('strong', '', item.name ?? 'Someone');
      if (item.kind === 'word') {
        text.append(strong, document.createTextNode(` found a ${item.length}-letter word`));
        text.append(el('span', 'feed-points', `+${item.points}`));
      } else if (item.kind === 'react') {
        text.append(strong, document.createTextNode(' reacted '));
        text.append(el('span', 'reaction-emoji', item.emoji ?? ''));
        row.classList.add('feed-reaction');
      } else if (item.kind === 'join') {
        text.append(strong, document.createTextNode(' joined the room'));
      } else if (item.kind === 'leave') {
        text.append(strong, document.createTextNode(' left the room'));
      } else {
        text.append(strong);
      }
      row.append(text);
      if (isNew && item.kind === 'react') newReactions.push(item);
    }
    dom.feed.append(row);
  }

  app.lastFeedId = maxId;
  if (scrollTop > 5) dom.feed.scrollTop = scrollTop;

  const latest = feed[0];
  if (latest) {
    if (latest.kind === 'system') {
      dom.liveTicker.textContent = latest.text ?? '';
    } else if (latest.kind === 'word') {
      dom.liveTicker.textContent = `${latest.name} found a ${latest.length}-letter word +${latest.points}`;
    } else if (latest.kind === 'react') {
      dom.liveTicker.textContent = `${latest.name} reacted ${latest.emoji}`;
    } else {
      dom.liveTicker.textContent = `${latest.name} ${latest.text ?? ''}`;
    }
  } else {
    dom.liveTicker.textContent = '';
  }

  for (const reaction of newReactions) floatReaction(reaction.emoji);
}

function renderReactionState() {
  const status = app.room?.status;
  const enabled = ['playing', 'roundResult', 'gameOver'].includes(status)
    && Date.now() > app.reactionCooldownUntil
    && app.wsReady;
  dom.reactionBar.querySelectorAll('.reaction-btn').forEach((button) => {
    button.disabled = !enabled;
  });
}

function handleTileTap(index) {
  if (!app.room || app.room.status !== 'playing' || !app.room.grid) return;
  if (!Number.isInteger(index) || index < 0 || index >= 16) return;

  if (app.path.includes(index)) {
    if (app.path[app.path.length - 1] === index) {
      app.path.pop();
      sfx.click();
      updateTiles();
    }
    return;
  }

  if (app.path.length > 0) {
    const last = app.path[app.path.length - 1];
    if (!areAdjacent(last, index)) {
      app.path = [index];
      if (!app.gridHintShown) {
        app.gridHintShown = true;
        toast('Letters must touch — edge or corner.', 'info');
      }
      updateTiles();
      return;
    }
  }

  app.path.push(index);
  sfx.click();
  updateTiles();
}

function areAdjacent(a, b) {
  const rowA = Math.floor(a / 4);
  const colA = a % 4;
  const rowB = Math.floor(b / 4);
  const colB = b % 4;
  const dr = Math.abs(rowA - rowB);
  const dc = Math.abs(colA - colB);
  return dr <= 1 && dc <= 1 && !(dr === 0 && dc === 0);
}

function addTypedLetter(letter) {
  if (!app.room?.grid || app.room.status !== 'playing') return;
  const lower = letter.toLowerCase();
  const candidates = [];
  const last = app.path.length ? app.path[app.path.length - 1] : null;

  app.room.grid.forEach((tileLetter, index) => {
    if (tileLetter.toLowerCase() !== lower) return;
    if (app.path.includes(index)) return;
    if (last !== null && !areAdjacent(last, index)) return;
    candidates.push(index);
  });

  if (!candidates.length) return;

  app.path.push(candidates[0]);
  sfx.click();
  updateTiles();
}

function clearPath() {
  if (!app.path.length) return;
  app.path = [];
  updateTiles();
}

function renderWord() {
  const word = app.path.map((index) => app.room?.grid?.[index] ?? '').join('');
  const playing = app.room?.status === 'playing';
  const canSubmit = playing && word.length >= 3 && !app.claimPending && app.wsReady;

  dom.wordDisplay.replaceChildren();
  dom.wordDisplay.classList.toggle('has-word', word.length > 0);
  if (!word) {
    dom.wordDisplay.append(el('span', 'word-placeholder', 'Build a word…'));
  } else {
    for (const letter of word) {
      dom.wordDisplay.append(el('span', 'word-letter', letter));
    }
  }

  const points = pointsForLength(word.length);
  dom.wordPoints.textContent = points > 0
    ? `+${points} point${points === 1 ? '' : 's'}`
    : (word.length > 0 ? `${3 - word.length} more letter${3 - word.length === 1 ? '' : 's'}` : '3+ letters to score');
  dom.submitBtn.disabled = !canSubmit;
  dom.clearBtn.disabled = !app.path.length;
}

function submitWord() {
  if (!app.room || app.room.status !== 'playing') return;
  if (app.claimPending) return;
  if (app.path.length < 3) {
    toast('Words need at least 3 letters.', 'info');
    shakeWordDisplay();
    return;
  }
  if (!app.wsReady) {
    toast('Still reconnecting — one moment.', 'info');
    return;
  }

  const word = app.path.map((index) => app.room.grid[index]).join('').toLowerCase();
  app.claimPending = true;
  renderWord();
  const sent = sendMessage({ type: 'claim', word, path: [...app.path] });
  if (!sent) {
    app.claimPending = false;
    renderWord();
    toast('Still reconnecting — one moment.', 'info');
    return;
  }

  clearTimeout(app.claimTimer);
  app.claimTimer = setTimeout(() => {
    if (!app.claimPending) return;
    app.claimPending = false;
    renderWord();
  }, 3000);
}

function handleClaimOk(message) {
  app.claimPending = false;
  clearTimeout(app.claimTimer);
  app.path = [];
  updateTiles();
  const word = String(message.word ?? '').toUpperCase();
  toast(`${word} +${message.points}`, 'success', 1900);
  popPoints(message.points);
  sfx.claim();
}

function shakeWordDisplay() {
  dom.wordDisplay.classList.remove('is-invalid');
  void dom.wordDisplay.offsetWidth;
  dom.wordDisplay.classList.add('is-invalid');
}

function popPoints(points) {
  if (!points) return;
  const rect = dom.wordDisplay.getBoundingClientRect();
  const node = el('span', 'points-pop', `+${points}`);
  node.style.left = `${rect.left + rect.width / 2}px`;
  node.style.top = `${rect.top}px`;
  document.body.append(node);
  const remove = () => node.remove();
  node.addEventListener('animationend', remove, { once: true });
  window.setTimeout(remove, 1400);
}

function startUiLoop() {
  cancelAnimationFrame(app.uiRaf);
  const loop = () => {
    if (app.room?.status === 'playing') updateTimerDisplay(true);
    if (app.room?.status === 'roundResult') updateCountdown();
    app.uiRaf = requestAnimationFrame(loop);
  };
  app.uiRaf = requestAnimationFrame(loop);
}

function stopTimerDisplay() {
  dom.timer.classList.remove('is-urgent');
  dom.timerSeconds.textContent = '0';
  dom.timerProgress.style.strokeDashoffset = String(TIMER_CIRCUMFERENCE);
  dom.timer.setAttribute('aria-label', 'Round over');
}

function updateTimerDisplay(fromLoop = false) {
  const room = app.room;
  if (!room || room.status !== 'playing' || !room.roundEndsAt) {
    if (!fromLoop) stopTimerDisplay();
    return;
  }
  const total = room.settings.roundSeconds * 1000;
  const remaining = Math.max(0, room.roundEndsAt - serverNow());
  const seconds = Math.ceil(remaining / 1000);
  const fraction = Math.max(0, Math.min(1, remaining / total));
  dom.timer.classList.toggle('is-urgent', remaining <= 10000 && remaining > 0);
  dom.timerProgress.style.strokeDashoffset = String(TIMER_CIRCUMFERENCE * (1 - fraction));
  dom.timer.setAttribute('aria-label', `${seconds} second${seconds === 1 ? '' : 's'} remaining`);

  if (seconds !== app.lastTimerSecond) {
    dom.timerSeconds.textContent = String(seconds);
    app.lastTimerSecond = seconds;
    if (seconds <= 5 && seconds > 0 && app.soundOn && document.visibilityState === 'visible') {
      if (app.lastTickSecond !== seconds) {
        app.lastTickSecond = seconds;
        sfx.tick();
      }
    }
  }
}

function updateCountdown() {
  if (!app.room?.nextAt) {
    dom.nextCountdown.textContent = '';
    return;
  }
  const remaining = Math.max(0, app.room.nextAt - serverNow());
  const seconds = Math.ceil(remaining / 1000);
  dom.nextCountdown.innerHTML = seconds > 0
    ? `Next round in <strong>${seconds}s</strong>`
    : 'Starting the next round…';
}

function resultsKey(room) {
  return `${room.code}:${room.roundNumber}:${room.status}`;
}

function showRoundResults() {
  const room = app.room;
  if (!room || room.status !== 'roundResult') return;
  const key = resultsKey(room);
  if (app.overlayDismissedKey === key) {
    hideOverlay();
    return;
  }

  const results = room.results ?? [];
  const top = results[0];
  dom.overlayEyebrow.textContent = `Round ${room.roundNumber} complete`;
  dom.overlayTitle.textContent = top && top.roundPoints > 0 ? 'Well hunted.' : 'Quiet round.';
  dom.overlaySubtitle.textContent = top && top.roundPoints > 0
    ? `${top.name} led with ${top.roundPoints} point${top.roundPoints === 1 ? '' : 's'}. Next round starts automatically.`
    : 'Nobody scored that round — the next board is a fresh start.';
  dom.podium.hidden = true;
  dom.resultsCaption.textContent = 'Words claimed this round';
  renderResultsList(results, top?.roundPoints ?? 0);
  dom.nextRoundBtn.hidden = !app.you?.canNext;
  dom.rematchBtn.hidden = true;
  dom.nextRoundBtn.disabled = false;
  dom.nextCountdown.hidden = false;
  dom.waitingNext.hidden = Boolean(app.you?.isHost);
  dom.waitingNext.textContent = 'Waiting for the host…';
  dom.overlayClose.hidden = false;
  dom.overlayLeaveBtn.hidden = false;
  showOverlay(key);
  updateCountdown();
}

function showFinalResults() {
  const room = app.room;
  if (!room || room.status !== 'gameOver') return;
  const key = resultsKey(room);
  if (app.overlayDismissedKey === key) {
    hideOverlay();
    return;
  }

  const standings = room.players;
  const winner = standings[0];
  const leaders = winner ? standings.filter((player) => player.score === winner.score) : [];
  const tied = leaders.length > 1;

  dom.overlayEyebrow.textContent = 'Final scores';
  if (!winner) {
    dom.overlayTitle.textContent = 'Game over';
    dom.overlaySubtitle.textContent = 'No players to score.';
  } else if (tied) {
    const names = leaders.slice(0, 3).map((player) => player.name).join(', ');
    const extra = leaders.length > 3 ? ` and ${leaders.length - 3} more` : '';
    dom.overlayTitle.textContent = "It's a tie!";
    dom.overlaySubtitle.textContent = `${names}${extra} share the top spot with ${winner.score} point${winner.score === 1 ? '' : 's'}.`;
  } else {
    dom.overlayTitle.textContent = `${winner.name} wins!`;
    dom.overlaySubtitle.textContent = `${winner.score} point${winner.score === 1 ? '' : 's'} across ${room.totalRounds} round${room.totalRounds === 1 ? '' : 's'}. Nicely hunted.`;
  }

  renderPodium(standings);
  dom.podium.hidden = false;
  dom.resultsCaption.textContent = 'Final round words';
  renderResultsList(room.results ?? [], null);
  dom.nextRoundBtn.hidden = true;
  dom.rematchBtn.hidden = !app.you?.canRematch;
  dom.rematchBtn.disabled = false;
  dom.nextCountdown.hidden = true;
  dom.nextCountdown.textContent = '';
  dom.waitingNext.hidden = Boolean(app.you?.canRematch);
  dom.waitingNext.textContent = 'Waiting for the host to start a rematch…';
  dom.overlayClose.hidden = true;
  dom.overlayLeaveBtn.hidden = false;
  showOverlay(key);

  if (app.confettiKey !== key) {
    app.confettiKey = key;
    launchConfetti();
    sfx.win();
  }
}

function renderPodium(standings) {
  dom.podium.replaceChildren();
  const count = Math.min(3, standings.length);
  dom.podium.dataset.count = String(count);
  for (let index = 0; index < count; index += 1) {
    const player = standings[index];
    const place = el('div', `podium-place place-${index + 1}`);
    place.append(el('div', 'podium-medal', `${index + 1}${index === 0 ? 'st' : index === 1 ? 'nd' : 'rd'}`));
    place.append(el('div', 'podium-avatar', player.avatar));
    place.append(el('div', 'podium-name', player.name));
    place.append(el('div', 'podium-score', String(player.score)));
    dom.podium.append(place);
  }
}

function renderResultsList(results, winnerPoints) {
  dom.resultsList.replaceChildren();
  if (!results.length) {
    dom.resultsList.append(el('p', 'result-empty', 'No results yet.'));
    return;
  }
  for (const result of results) {
    const isWinner = winnerPoints !== null && result.roundPoints > 0 && result.roundPoints === winnerPoints;
    const row = el('div', `result-row${isWinner ? ' is-winner' : ''}`);
    const head = el('div', 'result-head');
    head.append(el('span', 'result-avatar', result.avatar));
    head.append(el('span', 'result-name', `${result.name}${result.playerId === app.you?.id ? ' (you)' : ''}`));
    const points = el('span', 'result-points');
    points.append(document.createTextNode(`+${result.roundPoints}`));
    points.append(el('small', '', `${result.total} total`));
    head.append(points);
    row.append(head);

    if (result.words?.length) {
      const words = el('div', 'result-words');
      for (const entry of result.words) {
        const chip = el('span', 'result-word');
        chip.append(document.createTextNode(entry.word.toUpperCase()));
        chip.append(el('b', '', `+${entry.points}`));
        words.append(chip);
      }
      row.append(words);
    } else {
      row.append(el('div', 'result-empty', 'No words this round.'));
    }
    dom.resultsList.append(row);
  }
}

function showOverlay(key) {
  document.querySelectorAll('.points-pop').forEach((node) => node.remove());
  const wasHidden = dom.resultsOverlay.hidden;
  dom.resultsOverlay.hidden = false;
  dom.body.classList.add('has-overlay');
  if (dom.app) dom.app.inert = true;
  app.overlayOpenKey = key;

  if (wasHidden) {
    const focusTarget = !dom.nextRoundBtn.hidden
      ? dom.nextRoundBtn
      : (!dom.rematchBtn.hidden
        ? dom.rematchBtn
        : (!dom.overlayLeaveBtn.hidden ? dom.overlayLeaveBtn : dom.overlayClose));
    window.setTimeout(() => focusTarget?.focus({ preventScroll: true }), 60);
  }
}

function hideOverlay() {
  dom.resultsOverlay.hidden = true;
  dom.body.classList.remove('has-overlay');
  if (dom.app) dom.app.inert = false;
  app.overlayOpenKey = null;
}

function closeResultsOverlay(force = false) {
  if (!force && app.room?.status === 'gameOver') return;
  if (!force && app.room) app.overlayDismissedKey = resultsKey(app.room);
  hideOverlay();
  window.setTimeout(() => {
    if (!dom.resultsOverlay.hidden) return;
    if (app.room && (app.room.status === 'playing' || app.room.status === 'roundResult')) {
      dom.grid.querySelector('.tile')?.focus({ preventScroll: true });
    }
  }, 40);
}

function leaveRoom() {
  if (!app.room && !app.resumeTarget) return;
  if (app.room?.status === 'playing' && !window.confirm('Leave this round? Your words from this round will be lost.')) {
    return;
  }

  dom.leaveBtn.disabled = true;
  dom.topLeaveBtn.disabled = true;
  const sent = sendMessage({ type: 'leave' });
  if (!sent) {
    clearLocalSession();
    toast('You left the room.', 'info');
    return;
  }
  window.setTimeout(() => {
    dom.leaveBtn.disabled = false;
    dom.topLeaveBtn.disabled = false;
  }, 1500);
}

function clearLocalSession() {
  const code = app.sessionCode ?? app.room?.code;
  if (code) clearStoredSession(code);

  app.room = null;
  app.you = null;
  app.playerId = null;
  app.token = null;
  app.sessionCode = null;
  app.resumeTarget = null;
  app.rejoining = false;
  app.awaitingState = false;
  app.landingBusy = null;
  app.starting = false;
  app.claimPending = false;
  clearTimeout(app.claimTimer);
  app.path = [];
  app.gridKey = '';
  app.gridHintShown = false;
  app.lastStatus = undefined;
  app.lastScores.clear();
  app.lastFeedId = 0;
  app.feedInitialized = false;
  app.overlayDismissedKey = null;
  app.overlayOpenKey = null;
  app.confettiKey = null;

  hideOverlay();
  clearConfetti();
  stopTimerDisplay();
  dom.leaveBtn.disabled = false;
  dom.topLeaveBtn.disabled = false;
  dom.codeInput.value = '';
  setInviteMode('');
  dom.landingError.textContent = '';
  dom.codeInput.disabled = false;
  dom.nameInput.disabled = false;
  dom.lobbyPlayers.replaceChildren();
  dom.grid.replaceChildren();
  dom.feed.replaceChildren();
  dom.scoreboard.replaceChildren();
  dom.scoreStrip.replaceChildren();
  dom.yourWords.replaceChildren();
  dom.liveTicker.textContent = '';
  dom.wordDisplay.replaceChildren(el('span', 'word-placeholder', 'Build a word…'));

  const url = new URL(window.location.href);
  url.search = '';
  history.replaceState({}, '', url);
  showScreen('landing');
  updateLandingControls();
  document.title = 'Word Rush — multiplayer word hunt';
}

function handleServerError(message) {
  const code = message.code || 'ERROR';
  const text = message.message || 'Something went wrong.';
  app.claimPending = false;
  clearTimeout(app.claimTimer);
  app.starting = false;
  app.landingBusy = null;
  updateLandingControls();

  if (app.room) {
    if (app.room.status === 'lobby') renderLobby();
    else renderWord();
  }

  if (code === 'SESSION_INVALID') {
    const sessionCode = app.sessionCode ?? app.room?.code ?? normalizeCode(dom.codeInput.value);
    if (sessionCode) clearStoredSession(sessionCode);
    const keepCode = normalizeCode(dom.codeInput.value);
    app.resumeTarget = null;
    app.rejoining = false;
    if (app.room) {
      clearLocalSession();
    } else {
      app.sessionCode = null;
      app.playerId = null;
      app.token = null;
      const url = new URL(window.location.href);
      url.search = '';
      history.replaceState({}, '', url);
      updateLandingControls();
    }
    if (keepCode) dom.codeInput.value = keepCode;
    setLandingError('That room or session has ended. Ask the host for a new code.');
    toast('That room has ended.', 'error');
    return;
  }

  if (code === 'NOT_IN_ROOM') {
    clearLocalSession();
    setLandingError(text);
    toast(text, 'error');
    return;
  }
  if (code === 'ROOM_NOT_FOUND' || code === 'ROOM_FULL' || code === 'SERVER_FULL' || code === 'BAD_CODE') {
    setLandingError(text);
    toast(text, 'error');
    return;
  }
  if (code === 'NAME_INVALID') {
    setLandingError(text);
    if (app.room) toast(text, 'error');
    return;
  }
  if (code === 'WORD_INVALID' || code === 'PATH_INVALID' || code === 'WORD_DUPLICATE') {
    toast(text, 'error');
    shakeWordDisplay();
    sfx.error();
    return;
  }
  if (code === 'TIME_UP') {
    toast(text, 'info');
    renderWord();
    return;
  }
  if (code === 'ALREADY_IN_ROOM') {
    toast('You are already in a room.', 'info');
    return;
  }
  if (code === 'NOT_HOST') {
    toast(text, 'info');
    return;
  }
  toast(text, 'error');
}

function setLandingError(text) {
  dom.landingError.textContent = text || '';
}

function setInviteMode(code) {
  const invited = Boolean(code);
  document.body.classList.toggle('has-invite', invited);
  if (invited) {
    dom.codeInput.value = code;
    dom.playEyebrow.textContent = 'You are invited';
    dom.playHeading.textContent = 'Join the room';
    dom.playSubcopy.textContent = 'The room code is filled in. Pick a name and an animal to jump in.';
  } else {
    dom.playEyebrow.textContent = 'Ready when you are';
    dom.playHeading.textContent = 'Jump in';
    dom.playSubcopy.textContent = 'Pick a name and an animal. That is your whole profile.';
  }
}

function validateProfile() {
  const name = dom.nameInput.value
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[^\p{L}\p{N} '._-]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  const length = [...name].length;
  if (length < 2 || length > 14) {
    setLandingError('Name must be 2–14 characters.');
    dom.nameInput.focus();
    return null;
  }
  if (!/\p{L}/u.test(name)) {
    setLandingError('Please use at least one letter in your name.');
    dom.nameInput.focus();
    return null;
  }
  app.profile.name = name;
  app.profile.avatar = AVATARS.includes(app.profile.avatar) ? app.profile.avatar : AVATARS[0];
  dom.nameInput.value = name;
  saveProfile();
  return { ...app.profile };
}

function updateLandingControls() {
  const busy = Boolean(app.landingBusy) || app.rejoining || app.awaitingState;
  const disabled = busy || !app.wsReady;
  dom.createBtn.disabled = disabled;
  dom.joinBtn.disabled = disabled;
  dom.createBtn.setAttribute('aria-busy', String(busy));
  dom.nameInput.disabled = busy;
  dom.codeInput.disabled = busy;
  dom.createBtn.innerHTML = app.landingBusy === 'create'
    ? 'Creating…'
    : 'Create a room <span class="btn-arrow" aria-hidden="true">→</span>';
  dom.joinBtn.textContent = app.landingBusy === 'join' ? 'Joining…' : 'Join';
  if (app.room?.status === 'lobby' && app.you?.isHost) {
    dom.startBtn.disabled = !app.wsReady || app.starting;
  }
}

function handleCreate() {
  if (app.landingBusy || app.rejoining || app.awaitingState) return;
  const profile = validateProfile();
  if (!profile) return;
  if (!app.wsReady) {
    setLandingError('Still connecting — try again in a second.');
    return;
  }

  setLandingError('');
  app.landingBusy = 'create';
  updateLandingControls();
  const sent = sendMessage({ type: 'create', name: profile.name, avatar: profile.avatar });
  if (!sent) {
    app.landingBusy = null;
    updateLandingControls();
    setLandingError('Could not reach the server. Try again.');
    return;
  }
  clearTimeout(app.landingTimer);
  app.landingTimer = setTimeout(() => {
    if (app.landingBusy !== 'create') return;
    app.landingBusy = null;
    updateLandingControls();
    setLandingError('The server is taking too long. Try again.');
  }, 8000);
}

function handleJoin() {
  if (app.landingBusy || app.rejoining || app.awaitingState) return;
  const code = normalizeCode(dom.codeInput.value);
  if (code.length !== 4) {
    setLandingError('Enter the 4-character room code.');
    dom.codeInput.focus();
    return;
  }
  const profile = validateProfile();
  if (!profile) return;
  if (!app.wsReady) {
    setLandingError('Still connecting — try again in a second.');
    return;
  }

  setLandingError('');
  app.landingBusy = 'join';
  updateLandingControls();
  const sent = sendMessage({ type: 'join', code, name: profile.name, avatar: profile.avatar });
  if (!sent) {
    app.landingBusy = null;
    updateLandingControls();
    setLandingError('Could not reach the server. Try again.');
    return;
  }
  clearTimeout(app.landingTimer);
  app.landingTimer = setTimeout(() => {
    if (app.landingBusy !== 'join') return;
    app.landingBusy = null;
    updateLandingControls();
    setLandingError('The server is taking too long. Try again.');
  }, 8000);
}

function handleStart() {
  if (!app.room || app.room.status !== 'lobby' || !app.you?.isHost) return;
  if (!app.wsReady) {
    toast('Still connecting…', 'info');
    return;
  }
  app.starting = true;
  renderLobby();
  if (!sendMessage({ type: 'start' })) {
    app.starting = false;
    renderLobby();
    toast('Could not start the game. Try again.', 'error');
    return;
  }
  window.setTimeout(() => {
    if (!app.starting || app.room?.status === 'playing') return;
    app.starting = false;
    renderLobby();
  }, 5000);
}

function updateConnectionUI(state) {
  app.connected = state === 'online';
  dom.connectionPill.dataset.state = state;
  dom.connectionLabel.textContent = state === 'online'
    ? 'Online'
    : (state === 'offline' ? 'Offline' : 'Connecting');
  updateLandingControls();
  updateConnectionBanner();
  if (app.room) renderReactionState();
  if (app.room) renderWord();
}

function updateConnectionBanner() {
  const state = dom.connectionPill.dataset.state || 'connecting';
  const booted = Date.now() - app.bootAt > 1200;
  const shouldShow = state !== 'online'
    && (app.hasConnected || Boolean(app.room) || app.rejoining || Boolean(app.landingBusy) || (booted && app.screen === 'landing'));
  dom.connectionBanner.hidden = !shouldShow;
  if (shouldShow) {
    dom.connectionBanner.textContent = app.rejoining
      ? 'Reconnecting to your room…'
      : (app.room ? 'Connection lost — reconnecting…' : 'Connecting to the server…');
  }
}

function updateRoomUrl(code) {
  const url = new URL(window.location.href);
  url.searchParams.set('room', code);
  history.replaceState({}, '', url);
}

function sendReaction(emoji) {
  if (!app.room || !['playing', 'roundResult', 'gameOver'].includes(app.room.status)) return;
  if (Date.now() < app.reactionCooldownUntil) return;
  if (!app.wsReady) {
    toast('Still reconnecting…', 'info');
    return;
  }
  if (!sendMessage({ type: 'react', emoji })) return;
  app.reactionCooldownUntil = Date.now() + 800;
  renderReactionState();
  window.setTimeout(renderReactionState, 850);
}

function toast(message, type = 'info', duration = 2800) {
  if (!dom.toasts) return;
  const node = el('div', `toast is-${type}`);
  node.textContent = message;
  dom.toasts.append(node);
  while (dom.toasts.children.length > 3) dom.toasts.firstElementChild.remove();
  window.setTimeout(() => {
    node.classList.add('is-leaving');
    window.setTimeout(() => node.remove(), 220);
  }, duration);
}

async function copyText(text, successMessage) {
  try {
    await navigator.clipboard.writeText(text);
    toast(successMessage, 'success');
    return;
  } catch {
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  textarea.style.pointerEvents = 'none';
  document.body.append(textarea);
  textarea.select();
  try {
    document.execCommand('copy');
    toast(successMessage, 'success');
  } catch {
    toast('Could not copy — select the code manually.', 'error');
  }
  textarea.remove();
}

function floatReaction(emoji) {
  const node = el('span', 'float-emoji', emoji);
  node.style.left = `${15 + Math.random() * 70}vw`;
  node.style.top = `${52 + Math.random() * 22}vh`;
  document.body.append(node);
  const remove = () => node.remove();
  node.addEventListener('animationend', remove, { once: true });
  window.setTimeout(remove, 1400);
}

function handleGlobalKeydown(event) {
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  const target = event.target;
  if (target?.closest?.('input, textarea, select, [contenteditable="true"]')) return;

  if (!dom.resultsOverlay.hidden) {
    if (event.key === 'Escape' && app.room?.status === 'roundResult') {
      event.preventDefault();
      closeResultsOverlay();
    }
    return;
  }

  if (app.screen !== 'game' || app.room?.status !== 'playing') return;

  if (event.key === 'Enter') {
    if (target?.tagName === 'BUTTON') return;
    event.preventDefault();
    submitWord();
    return;
  }
  if (event.key === 'Backspace') {
    event.preventDefault();
    if (app.path.length) {
      app.path.pop();
      sfx.click();
      updateTiles();
    }
    return;
  }
  if (event.key === 'Escape') {
    event.preventDefault();
    clearPath();
    return;
  }
  if (/^[a-zA-Z]$/.test(event.key)) {
    event.preventDefault();
    addTypedLetter(event.key);
  }
}

function ensureAudio() {
  if (!app.soundOn) return null;
  try {
    if (!app.audioCtx) {
      const AudioCtor = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtor) return null;
      app.audioCtx = new AudioCtor();
    }
    if (app.audioCtx.state === 'suspended') {
      app.audioCtx.resume().catch(() => {});
    }
    return app.audioCtx;
  } catch {
    return null;
  }
}

function unlockAudio() {
  if (app.soundOn) ensureAudio();
}

function playTone(frequency, duration = 0.1, type = 'sine', gain = 0.04, delay = 0) {
  if (!app.soundOn) return;
  const ctx = ensureAudio();
  if (!ctx) return;
  try {
    const startAt = ctx.currentTime + delay;
    const oscillator = ctx.createOscillator();
    const volume = ctx.createGain();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, startAt);
    volume.gain.setValueAtTime(0.0001, startAt);
    volume.gain.exponentialRampToValueAtTime(gain, startAt + 0.012);
    volume.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);
    oscillator.connect(volume);
    volume.connect(ctx.destination);
    oscillator.start(startAt);
    oscillator.stop(startAt + duration + 0.03);
  } catch {
  }
}

const sfx = {
  click() {
    playTone(640, 0.04, 'triangle', 0.018);
  },
  claim() {
    playTone(523.25, 0.09, 'triangle', 0.05);
    playTone(783.99, 0.13, 'sine', 0.04, 0.07);
  },
  error() {
    playTone(170, 0.15, 'sawtooth', 0.03);
  },
  start() {
    [392, 523.25, 659.25].forEach((frequency, index) => {
      playTone(frequency, 0.12, 'triangle', 0.04, index * 0.07);
    });
  },
  chime() {
    playTone(659.25, 0.12, 'sine', 0.04);
    playTone(880, 0.18, 'sine', 0.04, 0.08);
  },
  win() {
    [523.25, 659.25, 783.99, 1046.5].forEach((frequency, index) => {
      playTone(frequency, 0.3, 'triangle', 0.05, index * 0.1);
    });
  },
  tick() {
    playTone(880, 0.03, 'square', 0.014);
  },
};

function launchConfetti() {
  if (REDUCED_MOTION) return;
  const canvas = dom.confetti;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.floor(window.innerWidth * dpr);
  canvas.height = Math.floor(window.innerHeight * dpr);
  canvas.style.display = 'block';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const colors = ['#FF6B4A', '#74D6B0', '#FFC94A', '#1D2A44', '#6C5CE7', '#FFFDF8'];
  const pieces = Array.from({ length: 150 }, () => ({
    x: Math.random() * window.innerWidth,
    y: -20 - Math.random() * window.innerHeight * 0.6,
    vx: (Math.random() - 0.5) * 2.6,
    vy: 2 + Math.random() * 4.2,
    size: 5 + Math.random() * 8,
    rotation: Math.random() * Math.PI,
    vr: (Math.random() - 0.5) * 0.26,
    color: colors[Math.floor(Math.random() * colors.length)],
  }));
  const startedAt = performance.now();
  const duration = 4200;
  cancelAnimationFrame(app.confettiRaf);

  const frame = (now) => {
    const elapsed = now - startedAt;
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    for (const piece of pieces) {
      piece.x += piece.vx;
      piece.y += piece.vy;
      piece.vy += 0.03;
      piece.rotation += piece.vr;
      if (piece.y > window.innerHeight + 30) {
        piece.y = -20;
        piece.x = Math.random() * window.innerWidth;
      }
      ctx.save();
      ctx.translate(piece.x, piece.y);
      ctx.rotate(piece.rotation);
      ctx.fillStyle = piece.color;
      ctx.fillRect(-piece.size / 2, -piece.size / 4, piece.size, piece.size / 2);
      ctx.restore();
    }
    if (elapsed < duration) {
      app.confettiRaf = requestAnimationFrame(frame);
    } else {
      ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
      canvas.style.display = 'none';
    }
  };
  app.confettiRaf = requestAnimationFrame(frame);
}

function clearConfetti() {
  cancelAnimationFrame(app.confettiRaf);
  const canvas = dom.confetti;
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
  canvas.style.display = 'none';
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}
