// language: JavaScript, file: server.js, runtime: Node 18+, target: Render
// Accounts, Chats, Reports, Owner-Panel, Ban-API-Proxy, Locked-Liste.

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

const USERS_FILE   = path.join(DATA_DIR, 'users.json');
const MSGS_FILE    = path.join(DATA_DIR, 'messages.json');
const TOKENS_FILE  = path.join(DATA_DIR, 'tokens.json');
const REPORTS_FILE = path.join(DATA_DIR, 'reports.json');
const LOCKED_FILE  = path.join(DATA_DIR, 'locked.json');
const OWNER_FILE   = path.join(DATA_DIR, 'ownertokens.json');

function load(f, fb) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fb; } }
function save(f, d) { fs.writeFileSync(f, JSON.stringify(d, null, 2)); }

let users    = load(USERS_FILE, {});
let messages = load(MSGS_FILE, {});
let tokens   = load(TOKENS_FILE, {});
let reports  = load(REPORTS_FILE, []);      // [{ id, reporter, target, reason, ts, status, decidedAt }]
let locked   = load(LOCKED_FILE, {});        // { "+212707102555": { lockedAt, reportId } }
let ownerTokens = load(OWNER_FILE, {});      // { token: true }

const OWNER_USER = 'Tayy';
const OWNER_PASS = '0873@adv';

const REAL_RANGES = ['+979', '+921', '+777', '+888', '+555', '+999', '+000', '+123', '+911', '+666', '+404', '+7777', '+8888', '+112'];

function randDigits(n) { let s = ''; for (let i = 0; i < n; i++) s += Math.floor(Math.random() * 10); return s; }
function hashPw(pw, salt) { return crypto.scryptSync(pw, salt, 64).toString('hex'); }
function makeToken() { return crypto.randomBytes(32).toString('hex'); }

// tier: 'clean' (alle gleich, 0.1%) | 'half' (alternierend, 5%) | 'random'
function generateNumber() {
  for (let attempt = 0; attempt < 800; attempt++) {
    const range = REAL_RANGES[Math.floor(Math.random() * REAL_RANGES.length)];
    const r = Math.random();
    let local, tier;
    if (r < 0.001) {
      const d = Math.floor(Math.random() * 10);
      local = String(d).repeat(7);
      tier = 'clean';
    } else if (r < 0.001 + 0.05) {
      const a = Math.floor(Math.random() * 10);
      let b = Math.floor(Math.random() * 10);
      if (b === a) b = (b + 1) % 10;
      local = '';
      for (let i = 0; i < 7; i++) local += (i % 2 === 0 ? a : b);
      tier = 'half';
    } else {
      local = randDigits(7);
      tier = 'random';
    }
    const candidate = range + local;
    if (!users[candidate]) return { number: candidate, tier };
  }
  // Fallback
  let n;
  do { n = REAL_RANGES[0] + randDigits(7); } while (users[n]);
  return { number: n, tier: 'random' };
}

function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.replace(/^Bearer\s+/i, '').trim();
  const num = tokens[token];
  if (!num || !users[num]) return res.status(401).json({ error: 'unauthorized' });
  req.user = num;
  next();
}

function ownerAuth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.replace(/^Bearer\s+/i, '').trim();
  if (!ownerTokens[token]) return res.status(401).json({ error: 'unauthorized' });
  next();
}

app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ----- Nummer vorschlagen -----
app.post('/api/generate', (req, res) => {
  res.json(generateNumber());
});

// ----- Registrierung -----
app.post('/api/register', (req, res) => {
  const { number, password } = req.body || {};
  if (!number || !password) return res.status(400).json({ error: 'missing fields' });
  if (!REAL_RANGES.some(r => number.startsWith(r))) return res.status(400).json({ error: 'invalid range' });
  if (String(password).length < 4) return res.status(400).json({ error: 'password_too_short' });
  if (users[number]) return res.status(409).json({ error: 'number_taken' });

  const salt = crypto.randomBytes(16).toString('hex');
  users[number] = {
    hash: hashPw(password, salt),
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
  if (hashPw(password, u.salt) !== u.hash) return res.status(401).json({ error: 'invalid' });
  const token = makeToken();
  tokens[token] = number;
  save(TOKENS_FILE, tokens);
  res.json({ number, token });
});

app.post('/api/logout', auth, (req, res) => {
  const h = req.headers.authorization || '';
  const token = h.replace(/^Bearer\s+/i, '').trim();
  delete tokens[token];
  save(TOKENS_FILE, tokens);
  res.json({ ok: true });
});

// ----- Profil -----
app.get('/api/me', auth, (req, res) => {
  const u = users[req.user];
  res.json({ number: req.user, name: u.name, picture: u.picture, status: u.status, createdAt: u.createdAt });
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

app.get('/api/user/:number', auth, (req, res) => {
  const u = users[req.params.number];
  if (!u) return res.json({ number: req.params.number, exists: false });
  res.json({ number: req.params.number, exists: true, name: u.name, picture: u.picture, status: u.status });
});

// ----- Chats -----
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
    return { peer: p, last: msgs[msgs.length - 1] || null };
  }).sort((a, b) => (b.last?.ts || 0) - (a.last?.ts || 0));
  res.json(out);
});

app.get('/api/messages/:peer', auth, (req, res) => {
  const key = [req.user, req.params.peer].sort().join('|');
  res.json(messages[key] || []);
});

// ----- Report -----
app.post('/api/report', auth, (req, res) => {
  const { target, reason } = req.body || {};
  if (!target) return res.status(400).json({ error: 'missing target' });
  if (target === req.user) return res.status(400).json({ error: 'self_report' });
  const rep = {
    id: crypto.randomBytes(8).toString('hex'),
    reporter: req.user,
    target,
    reason: String(reason || '').slice(0, 500),
    ts: Date.now(),
    status: 'pending',
    decidedAt: null
  };
  reports.push(rep);
  save(REPORTS_FILE, reports);
  res.json({ ok: true, id: rep.id });
});

// ----- Owner -----
app.post('/api/owner/login', (req, res) => {
  const { username, password } = req.body || {};
  if (username !== OWNER_USER || password !== OWNER_PASS) {
    return res.status(401).json({ error: 'invalid' });
  }
  const token = makeToken();
  ownerTokens[token] = true;
  save(OWNER_FILE, ownerTokens);
  res.json({ token });
});

app.post('/api/owner/logout', ownerAuth, (req, res) => {
  const h = req.headers.authorization || '';
  const token = h.replace(/^Bearer\s+/i, '').trim();
  delete ownerTokens[token];
  save(OWNER_FILE, ownerTokens);
  res.json({ ok: true });
});

app.get('/api/owner/reports', ownerAuth, (req, res) => {
  // sortiert: pending zuerst, dann nach ts desc
  const sorted = [...reports].sort((a, b) => {
    if (a.status === 'pending' && b.status !== 'pending') return -1;
    if (b.status === 'pending' && a.status !== 'pending') return 1;
    return b.ts - a.ts;
  });
  res.json(sorted);
});

app.post('/api/owner/decide', ownerAuth, (req, res) => {
  const { reportId, decision } = req.body || {};
  if (!reportId || !['lock', 'unlock', 'dismiss'].includes(decision)) {
    return res.status(400).json({ error: 'invalid' });
  }
  const rep = reports.find(r => r.id === reportId);
  if (!rep) return res.status(404).json({ error: 'not_found' });

  if (decision === 'lock') {
    rep.status = 'locked';
    locked[rep.target] = { lockedAt: Date.now(), reportId: rep.id };
    save(LOCKED_FILE, locked);
  } else if (decision === 'unlock') {
    rep.status = 'unlocked';
    delete locked[rep.target];
    save(LOCKED_FILE, locked);
  } else {
    rep.status = 'dismissed';
  }
  rep.decidedAt = Date.now();
  save(REPORTS_FILE, reports);
  res.json({ ok: true, report: rep });
});

// ----- Ban-Check (öffentlich) + locked-Status -----
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
  const isLocked = !!locked[req.params.number] || !!locked['+' + cleanNum];

  try {
    const r = await fetch(`${BAN_API}?number=${cleanNum}`, { headers: BAN_HEADERS });
    if (!r.ok) return res.json({ banned: false, locked: isLocked, status: r.status });
    const data = await r.json().catch(() => null);
    return res.json({ banned: !!data?.banned, locked: isLocked, status: r.status, raw: data });
  } catch (e) {
    return res.json({ banned: false, locked: isLocked, status: 0, error: e.message });
  }
});

// ----- Socket -----
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
    save(MSGS_FILE, messages);
    io.to('user:' + to).emit('message', msg);
    socket.emit('message', msg);
  });
});

server.listen(PORT, () => console.log('OldWhats on :' + PORT));
