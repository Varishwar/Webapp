'use strict';

// ─── App state ────────────────────────────────────────────────────────────
const S = {
  token:         null,
  username:      null,
  displayName:   null,
  roomId:        null,
  roomUrl:       null,
  role:          null,   // 'admin' | 'partner'
  socket:        null,
  keyPair:       null,
  sharedKey:     null,
  peerName:      null,
  messages:      new Map(),   // messageId → { el, isMine, status, countdownInterval }
  typingTimer:   null,
  pendingRoomId: null,
};

const DELETE_DELAY_MS = 10_000;

// ─── Screen management ────────────────────────────────────────────────────
function showScreen(id) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
  const el = document.getElementById('screen-' + id);
  if (el) el.classList.add('active');
}

// ─── Toast ────────────────────────────────────────────────────────────────
function toast(msg, type) {
  const el = document.createElement('div');
  el.className = 'toast' + (type ? ' toast-' + type : '');
  el.textContent = msg;
  document.body.appendChild(el);
  requestAnimationFrame(() => {
    requestAnimationFrame(() => el.classList.add('show'));
  });
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 300);
  }, 3200);
}

// ─── API helper ───────────────────────────────────────────────────────────
async function api(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (S.token) opts.headers['Authorization'] = 'Bearer ' + S.token;
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(path, opts);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

// ─── Auth ─────────────────────────────────────────────────────────────────
async function register(username, password) {
  const data = await api('POST', '/api/register', { username, password });
  saveSession(data);
  return data;
}

async function login(username, password) {
  const data = await api('POST', '/api/login', { username, password });
  saveSession(data);
  return data;
}

function saveSession(data) {
  S.token = data.token;
  S.username = data.username;
  S.displayName = data.username;
  sessionStorage.setItem('token', data.token);
  updateLobbyUser(data.username);
}

async function verifySession(token) {
  try {
    S.token = token;
    const data = await api('GET', '/api/me');
    S.username = data.username;
    S.displayName = data.username;
    updateLobbyUser(data.username);
    return data;
  } catch {
    S.token = null;
    sessionStorage.removeItem('token');
    return null;
  }
}

async function logout() {
  try { await api('POST', '/api/logout'); } catch { /* ignore */ }
  S.token = null;
  S.username = null;
  S.displayName = null;
  sessionStorage.removeItem('token');
  disconnectSocket();
  window.location.hash = '';
  showScreen('auth');
}

function updateLobbyUser(username) {
  const el = document.getElementById('lobby-username');
  const av = document.getElementById('lobby-avatar');
  if (el) el.textContent = username;
  if (av) {
    av.textContent = username[0].toUpperCase();
    av.style.background = nameToGradient(username);
  }
}

// ─── Socket ───────────────────────────────────────────────────────────────
function disconnectSocket() {
  if (S.socket) {
    S.socket.removeAllListeners();
    S.socket.disconnect();
    S.socket = null;
  }
}

function connectSocket() {
  disconnectSocket();
  const socket = io({ auth: { token: S.token }, transports: ['websocket', 'polling'] });
  S.socket = socket;

  socket.on('connect_error', (err) => {
    const msg = err.message || '';
    if (msg.includes('expired') || msg.includes('Authentication')) {
      toast('Session expired — please sign in again.', 'error');
      logout();
    } else {
      toast('Connection error: ' + msg, 'error');
    }
  });

  socket.on('room-error', (msg) => {
    toast(msg, 'error');
    disconnectSocket();
    window.location.hash = '';
    showScreen('lobby');
  });

  socket.on('role-assigned', ({ role }) => {
    S.role = role;
  });

  socket.on('peer-info', async ({ displayName, publicKey }) => {
    try {
      const peerPub = await importPublicKey(publicKey);
      S.sharedKey = await deriveSharedKey(S.keyPair.privateKey, peerPub);
      S.peerName = displayName;
      enterChat(displayName);
    } catch {
      toast('Key exchange failed — please reload.', 'error');
    }
  });

  socket.on('receive-message', async ({ messageId, encryptedMessage, iv, senderName, timestamp }) => {
    if (!S.sharedKey) return;
    try {
      const text = await decryptMessage(S.sharedKey, encryptedMessage, iv);
      appendMessage({ id: messageId, text, isMine: false, senderName, timestamp });
    } catch { /* tampered or corrupt — discard silently */ }
  });

  socket.on('message-read-ack', ({ messageId }) => {
    setMsgStatus(messageId, 'read');
    startCountdown(messageId);
  });

  socket.on('message-deleted', ({ messageId }) => {
    removeMsgEl(messageId);
  });

  socket.on('peer-typing', ({ isTyping, name }) => {
    const el = document.getElementById('typing-hint');
    el.textContent = isTyping ? name + ' is typing…' : '';
    el.style.display = isTyping ? 'block' : 'none';
  });

  socket.on('peer-renamed', ({ newName }) => {
    S.peerName = newName;
    setChatPeerName(newName);
    addSystemMsg('Contact renamed to "' + newName + '"');
  });

  socket.on('peer-disconnected', ({ name }) => {
    S.peerName = null;
    S.sharedKey = null;
    document.getElementById('online-dot').classList.remove('visible');
    setChatPeerName(null);
    addSystemMsg(name + ' disconnected.');
    // Return to waiting so creator can reshare the link
    document.getElementById('room-url-display').textContent = S.roomUrl || '';
    document.getElementById('display-name-input').value = S.displayName || S.username;
    showScreen('waiting');
  });

  socket.on('disconnect', () => {
    addSystemMsg('Connection lost. Reload to reconnect.');
  });
}

// ─── Room ─────────────────────────────────────────────────────────────────
async function enterRoom(roomId) {
  S.roomId = roomId;
  S.roomUrl = window.location.origin + '/#/room/' + roomId;

  // Generate ECDH key pair for this session
  S.keyPair = await generateKeyPair();
  const pubKeyB64 = await exportPublicKey(S.keyPair.publicKey);

  connectSocket();

  let joined = false;
  const doJoin = () => {
    if (joined) return;
    joined = true;
    S.socket.emit('join-room', {
      roomId,
      displayName: S.displayName || S.username,
      publicKey: pubKeyB64,
    });
  };

  S.socket.once('connect', doJoin);
  if (S.socket.connected) doJoin();

  document.getElementById('room-url-display').textContent = S.roomUrl;
  document.getElementById('display-name-input').value = S.displayName || S.username;
  window.location.hash = '/room/' + roomId;
  showScreen('waiting');
}

async function createRoom() {
  const btn = document.getElementById('create-room-btn');
  btn.disabled = true;
  btn.textContent = 'Creating…';
  try {
    const { roomId } = await api('POST', '/api/rooms');
    await enterRoom(roomId);
  } catch (e) {
    toast(e.message || 'Failed to create room', 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<span class="btn-icon">✦</span> Create Private Room';
  }
}

async function joinRoom(roomId) {
  let info;
  try { info = await api('GET', '/api/rooms/' + roomId); }
  catch { toast('Server unreachable.', 'error'); showScreen('lobby'); return; }

  if (!info.exists) { toast('Room not found or has expired.', 'error'); showScreen('lobby'); return; }
  if (info.full)    { toast('Room is full (2/2).', 'error'); showScreen('lobby'); return; }

  await enterRoom(roomId);
}

// ─── Chat UI ───────────────────────────────────────────────────────────────
function enterChat(peerName) {
  clearMessages();
  setChatPeerName(peerName);
  document.getElementById('online-dot').classList.add('visible');
  addSystemMsg(peerName + ' joined · Encryption active 🔒');
  showScreen('chat');
}

function setChatPeerName(name) {
  const nameEl = document.getElementById('chat-peer-name');
  const avatarEl = document.getElementById('peer-avatar');
  if (name) {
    nameEl.textContent = name;
    avatarEl.textContent = name[0].toUpperCase();
    avatarEl.style.background = nameToGradient(name);
  } else {
    nameEl.textContent = 'Disconnected';
    avatarEl.textContent = '?';
    avatarEl.style.background = '';
  }
}

function clearMessages() {
  // Cancel all countdown timers
  S.messages.forEach((m) => {
    if (m.countdownInterval) clearInterval(m.countdownInterval);
  });
  S.messages.clear();
  const inner = document.getElementById('messages-inner');
  if (inner) inner.innerHTML = '';
}

function addSystemMsg(text) {
  const inner = document.getElementById('messages-inner');
  if (!inner) return;
  const el = document.createElement('div');
  el.className = 'system-msg';
  el.textContent = text;
  inner.appendChild(el);
  scrollBottom();
}

function appendMessage({ id, text, isMine, senderName, timestamp }) {
  const inner = document.getElementById('messages-inner');
  if (!inner) return;

  const wrapper = document.createElement('div');
  wrapper.className = 'msg-wrapper ' + (isMine ? 'mine' : 'theirs');
  wrapper.dataset.id = id;

  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';

  const textEl = document.createElement('p');
  textEl.className = 'msg-text';
  textEl.textContent = text;

  const meta = document.createElement('div');
  meta.className = 'msg-meta';

  const timeEl = document.createElement('span');
  timeEl.className = 'msg-time';
  timeEl.textContent = new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  meta.appendChild(timeEl);

  if (isMine) {
    const statusEl = document.createElement('span');
    statusEl.className = 'msg-status';
    statusEl.id = 'status-' + id;
    statusEl.textContent = '✓';
    meta.appendChild(statusEl);
  }

  bubble.appendChild(textEl);
  bubble.appendChild(meta);
  wrapper.appendChild(bubble);

  // Admin delete button (visible to admin for all messages)
  if (S.role === 'admin') {
    const delBtn = document.createElement('button');
    delBtn.className = 'msg-delete-btn';
    delBtn.title = 'Delete message';
    delBtn.setAttribute('aria-label', 'Delete message');
    delBtn.textContent = '✕';
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (S.socket && S.roomId) {
        S.socket.emit('delete-message', { roomId: S.roomId, messageId: id });
      }
    });
    wrapper.appendChild(delBtn);
  }

  inner.appendChild(wrapper);

  const entry = { el: wrapper, isMine, status: 'sent', countdownInterval: null };
  S.messages.set(id, entry);

  scrollBottom();

  // IntersectionObserver fires the "read" signal for received messages
  if (!isMine) {
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        observer.disconnect();
        markRead(id);
      }
    }, { threshold: 0.5 });
    observer.observe(wrapper);
  }
}

function setMsgStatus(id, status) {
  const m = S.messages.get(id);
  if (m) m.status = status;
  const el = document.getElementById('status-' + id);
  if (el && status === 'read') el.textContent = '✓✓';
}

function markRead(messageId) {
  if (S.socket && S.roomId) {
    S.socket.emit('message-read', { roomId: S.roomId, messageId });
  }
  startCountdown(messageId);
}

function startCountdown(messageId) {
  const m = S.messages.get(messageId);
  if (!m || m.countdownInterval) return;

  const bubble = m.el.querySelector('.msg-bubble');
  let badge = bubble.querySelector('.countdown');
  if (!badge) {
    badge = document.createElement('div');
    badge.className = 'countdown';
    bubble.appendChild(badge);
  }

  const start = Date.now();
  m.countdownInterval = setInterval(() => {
    const rem = DELETE_DELAY_MS - (Date.now() - start);
    if (rem <= 0) {
      clearInterval(m.countdownInterval);
      m.countdownInterval = null;
      removeMsgEl(messageId);
    } else {
      badge.textContent = '🔥 ' + Math.ceil(rem / 1000) + 's';
      m.el.style.opacity = Math.max(0.25, rem / DELETE_DELAY_MS).toFixed(2);
    }
  }, 200);
}

function removeMsgEl(messageId) {
  const m = S.messages.get(messageId);
  if (!m) return;
  if (m.countdownInterval) clearInterval(m.countdownInterval);
  S.messages.delete(messageId);
  m.el.classList.add('msg-exiting');
  setTimeout(() => m.el.remove(), 380);
}

function scrollBottom() {
  const area = document.getElementById('messages-area');
  if (area) area.scrollTop = area.scrollHeight;
}

async function sendMessage() {
  const input = document.getElementById('message-input');
  const text = (input.value || '').trim();
  if (!text || !S.sharedKey || !S.socket || !S.socket.connected) return;

  input.value = '';
  input.style.height = 'auto';
  document.getElementById('send-btn').disabled = true;

  clearTimeout(S.typingTimer);
  S.socket.emit('typing', { isTyping: false });

  const messageId = crypto.randomUUID();
  try {
    const { encryptedMessage, iv } = await encryptMessage(S.sharedKey, text);
    appendMessage({ id: messageId, text, isMine: true, senderName: S.displayName, timestamp: Date.now() });
    S.socket.emit('send-message', { roomId: S.roomId, messageId, encryptedMessage, iv });
  } catch { /* sharedKey was lost — peer disconnected */ }
}

// ─── Screenshot guard ──────────────────────────────────────────────────────
function setupScreenshotGuard() {
  const overlay = document.getElementById('screenshot-overlay');
  let hideTimer = null;

  const cover = (ms) => {
    overlay.classList.remove('hidden');
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => overlay.classList.add('hidden'), ms || 2500);
  };

  document.addEventListener('keydown', (e) => {
    const isPrintScreen = e.key === 'PrintScreen' || e.key === 'Print';
    const isMacShot = e.metaKey && e.shiftKey && ['3', '4', '5', 's'].includes(e.key.toLowerCase());
    if (isPrintScreen || isMacShot) {
      cover(2500);
      // Best-effort: overwrite clipboard after capture
      setTimeout(() => { navigator.clipboard?.writeText('').catch(() => {}); }, 100);
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      overlay.classList.remove('hidden');
    } else {
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => overlay.classList.add('hidden'), 700);
    }
  });
}

// ─── Utility ──────────────────────────────────────────────────────────────
function nameToGradient(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) & 0x7fffffff;
  const hue = h % 360;
  return 'linear-gradient(135deg, hsl(' + hue + ',65%,42%), hsl(' + ((hue + 45) % 360) + ',65%,55%))';
}

function setLoading(btn, loading, loadingText, defaultHTML) {
  btn.disabled = loading;
  btn.innerHTML = loading ? loadingText : defaultHTML;
}

// ─── Welcome screen ───────────────────────────────────────────────────────
function createParticles() {
  const container = document.getElementById('welcome-particles');
  if (!container) return;
  for (let i = 0; i < 20; i++) {
    const p = document.createElement('span');
    p.className = 'w-particle';
    const size = Math.random() * 3.5 + 1.5;
    p.style.cssText = [
      'left:'              + (Math.random() * 100).toFixed(1) + '%',
      'bottom:'            + (-(Math.random() * 60)).toFixed(0) + 'px',
      'width:'             + size.toFixed(1) + 'px',
      'height:'            + size.toFixed(1) + 'px',
      'animation-delay:'   + (Math.random() * 8).toFixed(2) + 's',
      'animation-duration:'+ (Math.random() * 6 + 7).toFixed(1) + 's',
    ].join(';');
    container.appendChild(p);
  }
}

async function fadeOutWelcome() {
  return new Promise((resolve) => {
    const el = document.getElementById('screen-welcome');
    if (!el || !el.classList.contains('active')) { resolve(); return; }
    el.classList.add('w-exit');
    setTimeout(() => {
      el.classList.remove('active', 'w-exit');
      el.style.display = 'none';
      resolve();
    }, 650);
  });
}

// ─── Bootstrap ────────────────────────────────────────────────────────────
async function init() {
  setupScreenshotGuard();

  // Parse pending room from URL hash
  const match = window.location.hash.match(/#\/room\/([a-zA-Z0-9-]+)/);
  if (match) S.pendingRoomId = match[1];

  // Personalise the welcome screen for invited users
  if (S.pendingRoomId) {
    const subEl = document.getElementById('welcome-sub');
    const msgEl = document.getElementById('welcome-msg');
    if (subEl) subEl.textContent = "You've been invited";
    if (msgEl) msgEl.innerHTML   = "A private encrypted chat<br>is waiting for you.";
  }

  // Allow a tap anywhere on the welcome screen to skip the timer
  let resolveSkip;
  const skipPromise = new Promise((r) => { resolveSkip = r; });
  const welcomeEl = document.getElementById('screen-welcome');
  if (welcomeEl) welcomeEl.addEventListener('click', () => resolveSkip(), { once: true });

  // Minimum welcome display (2.5s) races against the user tapping to skip
  const minDisplay = Promise.race([
    new Promise((r) => setTimeout(r, 2500)),
    skipPromise,
  ]);

  // Run session verification in parallel with the display timer
  const savedToken = sessionStorage.getItem('token');
  let sessionData = null;
  if (savedToken) {
    // Wait for BOTH: timer/tap AND session check (so we never skip before auth resolves)
    [, sessionData] = await Promise.all([minDisplay, verifySession(savedToken)]);
  } else {
    await minDisplay;
  }

  // Gracefully fade the welcome screen out
  await fadeOutWelcome();

  // Navigate to the right screen
  if (sessionData) {
    if (S.pendingRoomId) {
      const rid = S.pendingRoomId;
      S.pendingRoomId = null;
      await joinRoom(rid);
    } else {
      showScreen('lobby');
    }
  } else {
    showScreen('auth');
  }
}

// ─── Event wiring (runs after DOM ready) ─────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {

  // ── Auth tabs ──────────────────────────────────────────────────────────
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.tab-pane').forEach((p) => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('tab-' + tab).classList.add('active');
    });
  });

  // ── Login ──────────────────────────────────────────────────────────────
  const loginBtn = document.getElementById('login-btn');
  async function doLogin() {
    const username = document.getElementById('login-username').value.trim();
    const password = document.getElementById('login-password').value;
    const errEl    = document.getElementById('login-error');
    errEl.textContent = '';
    if (!username || !password) { errEl.textContent = 'Please fill in all fields.'; return; }
    setLoading(loginBtn, true, 'Signing in…', 'Sign In');
    try {
      await login(username, password);
      if (S.pendingRoomId) {
        const rid = S.pendingRoomId;
        S.pendingRoomId = null;
        await joinRoom(rid);
      } else {
        showScreen('lobby');
      }
    } catch (e) {
      errEl.textContent = e.message;
    } finally {
      setLoading(loginBtn, false, '', 'Sign In');
    }
  }
  loginBtn.addEventListener('click', doLogin);
  document.getElementById('login-username').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
  document.getElementById('login-password').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });

  // ── Register ───────────────────────────────────────────────────────────
  const registerBtn = document.getElementById('register-btn');
  async function doRegister() {
    const username = document.getElementById('reg-username').value.trim();
    const password = document.getElementById('reg-password').value;
    const confirm  = document.getElementById('reg-confirm').value;
    const errEl    = document.getElementById('register-error');
    errEl.textContent = '';
    if (!username || !password || !confirm) { errEl.textContent = 'Please fill in all fields.'; return; }
    if (password !== confirm) { errEl.textContent = 'Passwords do not match.'; return; }
    setLoading(registerBtn, true, 'Creating…', 'Create Account');
    try {
      await register(username, password);
      if (S.pendingRoomId) {
        const rid = S.pendingRoomId;
        S.pendingRoomId = null;
        await joinRoom(rid);
      } else {
        showScreen('lobby');
      }
    } catch (e) {
      errEl.textContent = e.message;
    } finally {
      setLoading(registerBtn, false, '', 'Create Account');
    }
  }
  registerBtn.addEventListener('click', doRegister);
  document.getElementById('reg-username').addEventListener('keydown', (e) => { if (e.key === 'Enter') doRegister(); });
  document.getElementById('reg-password').addEventListener('keydown', (e) => { if (e.key === 'Enter') doRegister(); });
  document.getElementById('reg-confirm').addEventListener('keydown',  (e) => { if (e.key === 'Enter') doRegister(); });

  // ── Logout ─────────────────────────────────────────────────────────────
  document.getElementById('logout-btn').addEventListener('click', logout);

  // ── Create room ────────────────────────────────────────────────────────
  document.getElementById('create-room-btn').addEventListener('click', createRoom);

  // ── Copy link ──────────────────────────────────────────────────────────
  document.getElementById('copy-link-btn').addEventListener('click', () => {
    navigator.clipboard.writeText(S.roomUrl || '').catch(() => {});
    const btn = document.getElementById('copy-link-btn');
    btn.textContent = '✓ Copied!';
    btn.classList.add('copied');
    setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 2200);
  });

  // ── Set display name (waiting screen) ─────────────────────────────────
  function applyDisplayName() {
    const val = document.getElementById('display-name-input').value.trim();
    if (!val) return;
    S.displayName = val;
    S.socket?.emit('update-display-name', { displayName: val });
    toast('Display name updated', 'success');
  }
  document.getElementById('set-display-name-btn').addEventListener('click', applyDisplayName);
  document.getElementById('display-name-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') applyDisplayName();
  });

  // ── Cancel room ────────────────────────────────────────────────────────
  document.getElementById('cancel-room-btn').addEventListener('click', () => {
    disconnectSocket();
    S.roomId = null;
    S.roomUrl = null;
    S.keyPair = null;
    S.sharedKey = null;
    S.role = null;
    window.location.hash = '';
    showScreen('lobby');
  });

  // ── Edit identity (chat header) ────────────────────────────────────────
  document.getElementById('edit-identity-btn').addEventListener('click', () => {
    const editor = document.getElementById('identity-editor');
    editor.classList.toggle('hidden');
    if (!editor.classList.contains('hidden')) {
      const inp = document.getElementById('new-display-name');
      inp.value = S.displayName || S.username;
      inp.focus();
    }
  });

  function saveIdentity() {
    const val = document.getElementById('new-display-name').value.trim();
    if (!val) return;
    S.displayName = val;
    S.socket?.emit('update-display-name', { displayName: val });
    document.getElementById('identity-editor').classList.add('hidden');
    toast('Name updated', 'success');
  }
  document.getElementById('save-display-name-btn').addEventListener('click', saveIdentity);
  document.getElementById('cancel-identity-btn').addEventListener('click', () => {
    document.getElementById('identity-editor').classList.add('hidden');
  });
  document.getElementById('new-display-name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') saveIdentity();
    if (e.key === 'Escape') document.getElementById('cancel-identity-btn').click();
  });

  // ── Send message ───────────────────────────────────────────────────────
  document.getElementById('send-btn').addEventListener('click', sendMessage);

  const msgInput = document.getElementById('message-input');
  msgInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });
  msgInput.addEventListener('input', function () {
    // Auto-resize
    this.style.height = 'auto';
    this.style.height = Math.min(this.scrollHeight, 120) + 'px';
    // Enable/disable send button
    document.getElementById('send-btn').disabled = !this.value.trim();
    // Typing indicator
    if (!S.socket) return;
    S.socket.emit('typing', { isTyping: true });
    clearTimeout(S.typingTimer);
    S.typingTimer = setTimeout(() => {
      S.socket?.emit('typing', { isTyping: false });
    }, 1500);
  });

  // ── Back button ────────────────────────────────────────────────────────
  document.getElementById('back-btn').addEventListener('click', () => {
    disconnectSocket();
    clearMessages();
    S.roomId = null;
    S.roomUrl = null;
    S.keyPair = null;
    S.sharedKey = null;
    S.peerName = null;
    S.role = null;
    document.getElementById('messages-inner').innerHTML = '';
    document.getElementById('typing-hint').style.display = 'none';
    document.getElementById('identity-editor').classList.add('hidden');
    document.getElementById('message-input').value = '';
    document.getElementById('message-input').style.height = 'auto';
    document.getElementById('send-btn').disabled = true;
    window.location.hash = '';
    showScreen('lobby');
  });

  // ── Handle browser back/forward ────────────────────────────────────────
  window.addEventListener('hashchange', () => {
    // If navigated away from a room hash, stay on lobby
    if (!window.location.hash || window.location.hash === '#') {
      if (!S.roomId) showScreen('lobby');
    }
  });

  createParticles();
  init();
});
