// language: JavaScript, file: server.js, runtime: Node 18+, target: Render
// Account-System: Nummer + Passwort (scrypt), Token persistent, Messages serverseitig.

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

const USERS_FILE    = path.join(DATA_DIR, 'users.json');
const MESSAGES_FILE = path.join(DATA_DIR, 'messages.json');
const TOKENS_FILE   = path.join(DATA_DIR, 'tokens.json');

function load(f, fb) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fb; } }
function save(f, d) { fs.writeFileSync(f, JSON.stringify(d, null, 2)); }

let users    = load(USERS_FILE, {});     // { "+9791234567": { hash, salt, name, picture, status, createdAt } }
let messages = load(MESSAGES_FILE, {});  // { "chatKey": [msg, ...] }
let tokens   = load(TOKENS_FILE, {});    // { token: number }

const RANGES = ['+979', '+921', '+777', '+888'];

function randDigits(n) { let s = ''; for (let i = 0; i < n; i++) s += Math.floor(Math.random() * 10); return s; }
function hashPassword(password, salt) { return crypto.scryptSync(password, salt, 64).toString('hex'); }
function makeToken() { return crypto.randomBytes(32).toString('hex'); }

function generateNumber() {
  for (let i = 0; i < 500; i++) {
    const range = RANGES[Math.floor(Math.random() * RANGES.length)];
    let local;
    if (Math.random() < 0.05) {
      const d = Math.floor(Math.random() * 10);
      local = String(d).repeat(7);
    } else {
      local = randDigits(7);
    }
    const candidate = range + local;
    if (!users[candidate]) return candidate;
  }
  let c;
  do { c = RANGES[0] + randDigits(7); } while (users[c]);
  return c;
}

function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.replace(/^Bearer\s+/i, '').trim();
  const num = tokens[token];
  if (!num || !users[num]) return res.status(401).json({ error: 'unauthorized' });
  req.user = num;
  next();
}

app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ----- Nummer vorschlagen (noch nicht beansprucht) -----
app.post('/api/generate', (req, res) => {
  res.json({ number: generateNumber() });
});

// ----- Registrierung: Nummer + Passwort -----
app.post('/api/register', (req, res) => {
  const { number, password } = req.body || {};
  if (!number || !password) return res.status(400).json({ error: 'missing fields' });
  if (!RANGES.some(r => number.startsWith(r))) return res.status(400).json({ error: 'invalid range' });
  if (String(password).length < 4) return res.status(400).json({ error: 'password_too_short' });
  if (users[number]) return res.status(409).json({ error: 'number_taken' });

  const salt = crypto.randomBytes(16).toString('hex');
  users[number] = {
    hash: hashPassword(password, salt),
    salt,
    name: '',
    picture: null,
    status: 'Hey! Nutze OldWhats.',
    createdAt: Date.now()
  };
  save(USERS_FILE, users);

  const token = makeToken();
  tokens[token] = number;
  save(TOKENS_FILE, tokens);
  res.json({ number, token });
});

// ----- Login -----
app.post('/api/login', (req, res) => {
  const { number, password } = req.body || {};
  if (!number || !password) return res.status(400).json({ error: 'missing fields' });
  const u = users[number];
  if (!u) return res.status(401).json({ error: 'invalid' });
  if (hashPassword(password, u.salt) !== u.hash) return res.status(401).json({ error: 'invalid' });

  const token = makeToken();
  tokens[token] = number;
  save(TOKENS_FILE, tokens);
  res.json({ number, token });
});

// ----- Logout -----
app.post('/api/logout', auth, (req, res) => {
  const h = req.headers.authorization || '';
  const token = h.replace(/^Bearer\s+/i, '').trim();
  delete tokens[token];
  save(TOKENS_FILE, tokens);
  res.json({ ok: true });
});

// ----- Eigenes Profil -----
app.get('/api/me', auth, (req, res) => {
  const u = users[req.user];
  res.json({
    number: req.user,
    name: u.name,
    picture: u.picture,
    status: u.status,
    createdAt: u.createdAt
  });
});

app.post('/api/profile', auth, (req, res) => {
  const { name, picture, status } = req.body || {};
  const u = users[req.user];
  if (typeof name === 'string') u.name = name.slice(0, 40);
  if (typeof status === 'string') u.status = status.slice(0, 80);
  if (typeof picture === 'string' || picture === null) u.picture = picture;
  save(USERS_FILE, users);
  res.json({ ok: true });
});

// ----- Peer-Profil (Name, Bild) -----
app.get('/api/user/:number', auth, (req, res) => {
  const u = users[req.params.number];
  if (!u) return res.json({ number: req.params.number, exists: false });
  res.json({
    number: req.params.number,
    exists: true,
    name: u.name,
    picture: u.picture,
    status: u.status
  });
});

// ----- Chats-Liste -----
app.get('/api/chats', auth, (req, res) => {
  const me = req.user;
  const peers = new Set();
  for (const key of Object.keys(messages)) {
    const [a, b] = key.split('|');
    if (a === me) peers.add(b);
    if (b === me) peers.add(a);
  }
  const out = [...peers].map(p => {
    const key = [me, p].sort().join('|');
    const msgs = messages[key] || [];
    const last = msgs[msgs.length - 1] || null;
    return { peer: p, last };
  }).sort((a, b) => (b.last?.ts || 0) - (a.last?.ts || 0));
  res.json(out);
});

// ----- Nachrichten mit Peer -----
app.get('/api/messages/:peer', auth, (req, res) => {
  const key = [req.user, req.params.peer].sort().join('|');
  res.json(messages[key] || []);
});

// ----- Ban-Check (öffentlich, damit auch vor Login nutzbar) -----
const BAN_API = 'https://xzc-corporation.biz.id/lrp';
const BAN_HEADERS = {
  'accept-encoding': 'gzip',
  'content-type': 'application/json',
  'host': 'xzc-corporation.biz.id',
  'neckhurt': 'hate4jew',
  'user-agent': 'Dart/3.12 (dart:io)'
};

app.get('/api/check/:number', async (req, res) => {
  const cleanNum = String(req.params.number).replace(/[^\d]/g, '');
  try {
    const r = await fetch(`${BAN_API}?number=${cleanNum}`, { headers: BAN_HEADERS });
    if (!r.ok) return res.json({ banned: false, status: r.status });
    const data = await r.json().catch(() => null);
    return res.json({ banned: !!data?.banned, status: r.status, raw: data });
  } catch (e) {
    return res.json({ banned: false, status: 0, error: e.message });
  }
});

// ----- Socket.IO mit Token-Auth -----
io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  const num = tokens[token];
  if (!num || !users[num]) return next(new Error('unauthorized'));
  socket.data.me = num;
  next();
});

io.on('connection', (socket) => {
  const me = socket.data.me;
  socket.join('user:' + me);

  socket.on('message', ({ to, text }) => {
    if (!to || !text) return;
    const key = [me, to].sort().join('|');
    const msg = { from: me, to, text: String(text).slice(0, 4000), ts: Date.now() };
    messages[key] = messages[key] || [];
    messages[key].push(msg);
    save(MESSAGES_FILE, messages);
    io.to('user:' + to).emit('message', msg);
    socket.emit('message', msg);
  });
});

server.listen(PORT, () => console.log('OldWhats on :' + PORT));
