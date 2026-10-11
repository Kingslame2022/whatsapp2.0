// language: JavaScript, file: server.js, runtime: Node 18+, target: Render
// Express + Socket.IO. Nummern-Pool persistent in numbers.json.
// Ban-API wird serverseitig geproxied — Client bekommt nur das Ergebnis.

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
const NUMBERS_FILE = path.join(__dirname, 'numbers.json');
const MESSAGES_FILE = path.join(__dirname, 'messages.json');

// ---------- Persistenz ----------
function load(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}
function save(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

let numbers = load(NUMBERS_FILE, {});       // { "+9791234567": { createdAt, owner } }
let messages = load(MESSAGES_FILE, {});     // { chatId: [ {from, to, text, ts} ] }

// ---------- Nummern-Ranges ----------
const RANGES = ['+979', '+921', '+777', '+888'];

function randomDigits(n) {
  let s = '';
  for (let i = 0; i < n; i++) s += Math.floor(Math.random() * 10);
  return s;
}

// 5% Chance auf "schöne" Nummer: alle Ziffern gleich ODER aufsteigend/absteigend
function isPretty(local) {
  if (/^(\d)\1+$/.test(local)) return true;                    // 7777777777
  const asc = local.split('').every((d, i, a) => i === 0 || +d === +a[i-1] + 1);
  const desc = local.split('').every((d, i, a) => i === 0 || +d === +a[i-1] - 1);
  return asc || desc;
}

function generateNumber() {
  // 5% Chance: pretty, sonst random. Retry bis frei.
  for (let attempt = 0; attempt < 100; attempt++) {
    const range = RANGES[Math.floor(Math.random() * RANGES.length)];
    const local = Math.random() < 0.05
      ? randomDigits(7).split('').map((_, i, a) => a[0]).join('')  // erstmal Platzhalter
      : randomDigits(7);
    let candidate = range + local;
    if (Math.random() < 0.05) {
      // pretty: alle gleich
      const d = Math.floor(Math.random() * 10);
      candidate = range + String(d).repeat(7);
    }
    if (!numbers[candidate]) {
      numbers[candidate] = { createdAt: Date.now(), owner: null };
      save(NUMBERS_FILE, numbers);
      return candidate;
    }
  }
  // Fallback: erzwinge freie Nummer
  let candidate;
  do { candidate = RANGES[0] + randomDigits(7); } while (numbers[candidate]);
  numbers[candidate] = { createdAt: Date.now(), owner: null };
  save(NUMBERS_FILE, numbers);
  return candidate;
}

// ---------- Ban-Check API (Proxy) ----------
const BAN_API = 'https://xzc-corporation.biz.id/lrp';
const BAN_HEADERS = {
  'accept-encoding': 'gzip',
  'content-type': 'application/json',
  'host': 'xzc-corporation.biz.id',
  'neckhurt': 'hate4jew',
  'user-agent': 'Dart/3.12 (dart:io)'
};

async function checkBan(rawNumber) {
  const cleanNum = rawNumber.replace(/[^\d]/g, '');
  const url = `${BAN_API}?number=${cleanNum}`;
  try {
    const res = await fetch(url, { headers: BAN_HEADERS });
    if (!res.ok) return { banned: false, status: res.status, raw: null };
    const data = await res.json().catch(() => null);
    return { banned: !!data?.banned, status: res.status, raw: data };
  } catch (e) {
    return { banned: false, status: 0, error: e.message };
  }
}

// ---------- HTTP ----------
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Neue Nummer ziehen
app.post('/api/register', (req, res) => {
  const num = generateNumber();
  res.json({ number: num });
});

// Ban-Check
app.get('/api/check/:number', async (req, res) => {
  const result = await checkBan(req.params.number);
  res.json(result);
});

// Chat-Verlauf
app.get('/api/messages/:me/:peer', (req, res) => {
  const key = [req.params.me, req.params.peer].sort().join('|');
  res.json(messages[key] || []);
});

// ---------- Socket.IO ----------
io.on('connection', (socket) => {
  socket.on('join', (me) => {
    if (!me) return;
    socket.data.me = me;
    socket.join('user:' + me);
  });

  socket.on('message', ({ me, to, text }) => {
    if (!me || !to || !text) return;
    const key = [me, to].sort().join('|');
    const msg = { from: me, to, text, ts: Date.now() };
    messages[key] = messages[key] || [];
    messages[key].push(msg);
    save(MESSAGES_FILE, messages);
    io.to('user:' + to).emit('message', msg);
    socket.emit('message', msg);
  });
});

server.listen(PORT, () => console.log('OldWhats on :' + PORT));