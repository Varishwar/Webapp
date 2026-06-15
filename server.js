const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcrypt');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── In-memory stores (everything is ephemeral by design) ──────────────────
// users: username.toLowerCase() → { username, hash }
const users = new Map();
// sessions: token → username
const sessions = new Map();
// rooms: roomId → { users: Map<socketId, {username, displayName, publicKey}>, adminUsername, createdAt }
const rooms = new Map();

// ── Auth middleware ───────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  const token = auth.slice(7);
  const username = sessions.get(token);
  if (!username) return res.status(401).json({ error: 'Session expired — please log in again' });
  req.username = username;
  req.token = token;
  next();
}

// ── Auth routes ───────────────────────────────────────────────────────────
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password are required' });
  if (username.length < 3 || username.length > 32) return res.status(400).json({ error: 'Username must be 3–32 characters' });
  if (!/^[a-zA-Z0-9_.-]+$/.test(username)) return res.status(400).json({ error: 'Username may only contain letters, numbers, _ . -' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  if (users.has(username.toLowerCase())) return res.status(409).json({ error: 'That username is already taken' });

  const hash = await bcrypt.hash(password, 12);
  users.set(username.toLowerCase(), { username, hash });

  const token = uuidv4();
  sessions.set(token, username);
  console.log(`[auth] registered: ${username}`);
  res.json({ token, username });
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password are required' });

  const user = users.get(username.toLowerCase());
  if (!user) return res.status(401).json({ error: 'Invalid username or password' });

  const ok = await bcrypt.compare(password, user.hash);
  if (!ok) return res.status(401).json({ error: 'Invalid username or password' });

  const token = uuidv4();
  sessions.set(token, user.username);
  console.log(`[auth] login: ${user.username}`);
  res.json({ token, username: user.username });
});

app.get('/api/me', requireAuth, (req, res) => {
  res.json({ username: req.username });
});

app.post('/api/logout', requireAuth, (req, res) => {
  sessions.delete(req.token);
  res.json({ ok: true });
});

// ── Room routes ───────────────────────────────────────────────────────────
app.post('/api/rooms', requireAuth, (req, res) => {
  const roomId = uuidv4();
  rooms.set(roomId, {
    users: new Map(),
    adminUsername: req.username,   // creator is always admin
    createdAt: Date.now(),
  });
  console.log(`[room] created ${roomId} by ${req.username}`);
  res.json({ roomId });
});

app.get('/api/rooms/:roomId', requireAuth, (req, res) => {
  const room = rooms.get(req.params.roomId);
  if (!room) return res.json({ exists: false });
  res.json({ exists: true, userCount: room.users.size, full: room.users.size >= 2 });
});

// ── SPA catch-all ─────────────────────────────────────────────────────────
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Socket.io middleware: authenticate every connection ───────────────────
io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) return next(new Error('Authentication required'));
  const username = sessions.get(token);
  if (!username) return next(new Error('Session expired'));
  socket.data.username = username;
  next();
});

// ── Socket.io events ──────────────────────────────────────────────────────
io.on('connection', (socket) => {
  let roomId = null;
  let displayName = socket.data.username;

  socket.on('join-room', ({ roomId: rid, displayName: dn, publicKey }) => {
    const room = rooms.get(rid);
    if (!room) { socket.emit('room-error', 'Room not found or expired.'); return; }
    if (room.users.size >= 2) { socket.emit('room-error', 'Room is already full (2/2).'); return; }

    roomId = rid;
    displayName = (dn && dn.trim()) ? dn.trim() : socket.data.username;
    room.users.set(socket.id, { username: socket.data.username, displayName, publicKey });
    socket.join(roomId);

    // Assign role: admin = room creator
    const role = room.adminUsername === socket.data.username ? 'admin' : 'partner';
    socket.emit('role-assigned', { role });

    // Exchange public keys with existing peer
    for (const [sid, user] of room.users) {
      if (sid !== socket.id) {
        socket.emit('peer-info', { displayName: user.displayName, publicKey: user.publicKey });
        socket.to(sid).emit('peer-info', { displayName, publicKey });
      }
    }

    io.to(roomId).emit('room-status', {
      userCount: room.users.size,
      users: [...room.users.values()].map((u) => u.displayName),
    });
    console.log(`[room] ${displayName} (${role}) joined ${roomId} (${room.users.size}/2)`);
  });

  socket.on('update-display-name', ({ displayName: newName }) => {
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room || !room.users.has(socket.id)) return;
    const n = (newName && newName.trim()) ? newName.trim() : displayName;
    room.users.get(socket.id).displayName = n;
    displayName = n;
    socket.to(roomId).emit('peer-renamed', { newName: n });
  });

  // Messages are relayed immediately — never stored, never logged as plaintext
  socket.on('send-message', ({ messageId, encryptedMessage, iv }) => {
    if (!roomId) return;
    socket.to(roomId).emit('receive-message', {
      messageId,
      encryptedMessage,
      iv,
      senderName: displayName,
      timestamp: Date.now(),
    });
  });

  socket.on('message-read', ({ messageId }) => {
    if (!roomId) return;
    socket.to(roomId).emit('message-read-ack', { messageId });
  });

  // Admin-only: delete any message (enforced server-side)
  socket.on('delete-message', ({ messageId }) => {
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;

    if (room.adminUsername !== socket.data.username) {
      // Non-admin tried to delete — silently reject (could also emit an error)
      socket.emit('room-error', 'Only the room admin can delete messages.');
      return;
    }

    // Broadcast delete to EVERYONE in the room (including admin themselves)
    io.to(roomId).emit('message-deleted', { messageId });
  });

  socket.on('typing', ({ isTyping }) => {
    if (!roomId) return;
    socket.to(roomId).emit('peer-typing', { isTyping, name: displayName });
  });

  socket.on('disconnect', () => {
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;
    room.users.delete(socket.id);
    socket.to(roomId).emit('peer-disconnected', { name: displayName });
    io.to(roomId).emit('room-status', {
      userCount: room.users.size,
      users: [...room.users.values()].map((u) => u.displayName),
    });
    console.log(`[room] ${displayName} left ${roomId}`);
    if (room.users.size === 0) {
      setTimeout(() => {
        if (rooms.has(roomId) && rooms.get(roomId).users.size === 0) {
          rooms.delete(roomId);
          console.log(`[room] cleaned up ${roomId}`);
        }
      }, 300_000); // 5-minute grace period for reconnects
    }
  });
});

// Sweep truly stale empty rooms every hour
setInterval(() => {
  const cutoff = Date.now() - 86_400_000;
  for (const [id, room] of rooms) {
    if (room.users.size === 0 && room.createdAt < cutoff) rooms.delete(id);
  }
}, 3_600_000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n✓ Shagun Workspace running → http://localhost:${PORT}\n`);
});
