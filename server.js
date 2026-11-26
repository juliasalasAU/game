// Rare Answer Twenty — plain Node.js server with no dependencies at all.
// Serves the game page from /public and keeps each room in memory while the server runs.
//
//   node server.js          (same Wi-Fi only)
//   node online.js          (also opens a public address for friends on mobile data)

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const PORT = Number(process.env.PORT) || 8787;
const PUBLIC = path.join(__dirname, "public");
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const ROOM_TTL_MS = 12 * 60 * 60 * 1000;
const SURVEY_MS = 60 * 1000;
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml" };

const rooms = new Map(); // code -> { createdAt, hostToken, game, players, sockets:Set }

// ---- room logic --------------------------------------------------------------
function newRoom() {
  for (let attempt = 0; attempt < 20; attempt++) {
    const code = Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join("");
    const cur = rooms.get(code);
    const live = cur && Date.now() - cur.createdAt < ROOM_TTL_MS && (Object.keys(cur.players).length > 0 || cur.game.phase !== "lobby");
    if (live) continue;
    const room = { code, createdAt: Date.now(), hostToken: crypto.randomUUID(), game: { phase: "lobby", round: 0, order: null }, players: {}, sockets: new Set() };
    rooms.set(code, room);
    return room;
  }
  return null;
}

function view(d, att) {
  const g = d.game;
  const revealedUpTo = g.phase === "reveal" || g.phase === "done" ? g.round : g.round - 1;
  const players = {};
  for (const [id, p] of Object.entries(d.players)) {
    const guesses = {};
    for (const [k, v] of Object.entries(p.guesses || {})) if (id === att.pid || Number(k) <= revealedUpTo) guesses[k] = v;
    const lists = {};
    for (const [k, v] of Object.entries(p.lists || {})) if (id === att.pid || Number(k) <= revealedUpTo) lists[k] = v;
    players[id] = { name: p.name, guesses, lists, answered: g.phase === "guess" && (p.guesses || {})[String(g.round)] != null, listed: g.phase === "survey" && !!(p.listed || {})[String(g.round)] };
  }
  return { type: "state", game: g, players, you: att.pid, isHost: att.isHost, joined: !!(att.pid && d.players[att.pid]) };
}
function broadcast(d) {
  for (const ws of d.sockets) { try { ws.send(JSON.stringify(view(d, ws.att))); } catch (e) {} }
}
const clean = s => String(s ?? "").replace(/[\u0000-\u001f]/g, "").trim().slice(0, 60);

function handleMessage(d, ws, raw) {
  let m; try { m = JSON.parse(raw); } catch (e) { return; }
  const att = ws.att; const g = d.game;
  switch (m.type) {
    case "hello": {
      const pid = clean(m.pid);
      if (!/^[A-Za-z0-9_-]{6,40}$/.test(pid)) return;
      att.pid = pid; att.isHost = !!m.hostToken && m.hostToken === d.hostToken;
      ws.send(JSON.stringify(view(d, att)));
      return;
    }
    case "join": {
      if (!att.pid) return;
      const name = clean(m.name).slice(0, 24); if (!name) return;
      if (Object.keys(d.players).length >= 30 && !d.players[att.pid]) return;
      const prev = d.players[att.pid] || {}; d.players[att.pid] = { name, guesses: prev.guesses || {}, lists: prev.lists || {}, listed: prev.listed || {} };
      break;
    }
    case "list": {
      if (!att.pid || !d.players[att.pid] || g.phase !== "survey") return;
      const list = Array.isArray(m.list) ? m.list.map(clean).filter(Boolean).slice(0, 200) : [];
      const p = d.players[att.pid]; p.lists = p.lists || {}; p.listed = p.listed || {};
      p.lists[String(g.round)] = list; if (m.done) p.listed[String(g.round)] = true;
      break;
    }
    case "guess": {
      if (!att.pid || !d.players[att.pid] || g.phase !== "guess") return;
      const text = clean(m.text); if (!text) return;
      d.players[att.pid].guesses[String(g.round)] = text;
      break;
    }
    case "host": {
      if (!att.isHost) return;
      const validOrder = Array.isArray(m.order) && m.order.length >= 1 && m.order.length <= 40 &&
        m.order.every(o => (Number.isInteger(o) && o >= 0 && o < 1000) || (o && typeof o.title === "string" && o.title.length > 0 && o.title.length <= 80));
      const mode = m.mode === "boards" ? "boards" : m.mode === "room" ? "room" : "same";
      const firstPhase = () => mode === "room" ? "survey" : "guess";
      const surveyEnds = () => mode === "room" ? Date.now() + SURVEY_MS : null;
      if (m.action === "start" && validOrder && g.phase === "lobby") {
        for (const p of Object.values(d.players)) { p.guesses = {}; p.lists = {}; p.listed = {}; }
        const answerSeconds = [0, 25, 45, 60, 90, 120].includes(m.answerSeconds) ? m.answerSeconds : 0;
        d.game = { phase: firstPhase(), round: 0, order: m.order.map(o => Number.isInteger(o) ? o : { title: clean(o.title).slice(0, 80) }), mode, answerSeconds, accepted: {}, rejected: {}, surveyEnds: surveyEnds(), guessEnds: mode === "boards" && answerSeconds ? Date.now() + answerSeconds * 1000 : null };
      }
      else if (m.action === "endsurvey" && g.phase === "survey") d.game = { ...g, phase: "guess", surveyEnds: null, guessEnds: g.answerSeconds ? Date.now() + g.answerSeconds * 1000 : null };
      else if (m.action === "reveal" && g.phase === "guess") d.game = { ...g, phase: "reveal" };
      else if (m.action === "next" && g.phase === "reveal") d.game = g.round >= g.order.length - 1 ? { ...g, phase: "done" } : { ...g, phase: g.mode === "room" ? "survey" : "guess", round: g.round + 1, surveyEnds: g.mode === "room" ? Date.now() + SURVEY_MS : null, guessEnds: g.mode === "boards" && g.answerSeconds ? Date.now() + g.answerSeconds * 1000 : null };
      else if (m.action === "reject" && g.phase === "reveal" && typeof m.pid === "string" && d.players[m.pid]) {
        const r = String(g.round); const acc = { ...(g.rejected || {}) }; const row = { ...(acc[r] || {}) };
        if (row[m.pid]) delete row[m.pid]; else row[m.pid] = true; acc[r] = row;
        d.game = { ...g, rejected: acc };
      }
      else if (m.action === "accept" && g.phase === "reveal" && typeof m.pid === "string" && d.players[m.pid]) {
        const r = String(g.round); const acc = { ...(g.accepted || {}) }; const row = { ...(acc[r] || {}) };
        if (row[m.pid]) delete row[m.pid]; else row[m.pid] = true; acc[r] = row;
        d.game = { ...g, accepted: acc };
      }
      else if (m.action === "end") d.game = { ...g, phase: "done" };
      else if (m.action === "lobby") { for (const p of Object.values(d.players)) { p.guesses = {}; p.lists = {}; p.listed = {}; } d.game = { phase: "lobby", round: 0, order: null }; }
      else if (m.action === "clear") d.players = {};
      else if (m.action === "kick" && typeof m.pid === "string") delete d.players[m.pid];
      else return;
      break;
    }
    default: return;
  }
  broadcast(d);
}

// ---- HTTP --------------------------------------------------------------------
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/api/rooms" && req.method === "POST") {
    const room = newRoom();
    if (!room) { res.writeHead(503, { "content-type": "application/json" }); return res.end(JSON.stringify({ error: "Could not create a room. Try again." })); }
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ code: room.code, hostToken: room.hostToken }));
  }
  let file = url.pathname === "/" ? "/index.html" : url.pathname;
  file = path.normalize(file).replace(/^(\.\.[\/\\])+/, "");
  const full = path.join(PUBLIC, file);
  if (!full.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404, { "content-type": "text/plain" }); return res.end("Not found"); }
    res.writeHead(200, { "content-type": MIME[path.extname(full)] || "application/octet-stream", "cache-control": "no-cache" });
    res.end(data);
  });
});

// ---- minimal WebSocket server (RFC 6455, text frames) ------------------------
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
function wsFrame(opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) header = Buffer.from([0x80 | opcode, len]);
  else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([header, payload]);
}
class Socket {
  constructor(socket) {
    this.socket = socket; this.buf = Buffer.alloc(0); this.closed = false; this.frag = []; this.att = { pid: null, isHost: false };
    this.onmessage = null; this.onclose = null;
    socket.on("data", d => this.feed(d));
    socket.on("close", () => this.finish());
    socket.on("error", () => this.finish());
    socket.setNoDelay(true);
  }
  send(text) { if (!this.closed) this.socket.write(wsFrame(0x1, Buffer.from(text, "utf8"))); }
  close() { if (!this.closed) { try { this.socket.write(wsFrame(0x8, Buffer.alloc(0))); } catch (e) {} this.socket.end(); } this.finish(); }
  finish() { if (this.closed) return; this.closed = true; if (this.onclose) this.onclose(); }
  feed(data) {
    this.buf = Buffer.concat([this.buf, data]);
    for (;;) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0], b1 = this.buf[1];
      const fin = !!(b0 & 0x80), opcode = b0 & 0x0f, masked = !!(b1 & 0x80);
      let len = b1 & 0x7f, off = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.buf.length < 10) return; len = Number(this.buf.readBigUInt64BE(2)); off = 10; }
      if (len > 1 << 20) { this.close(); return; }
      if (masked) off += 4;
      if (this.buf.length < off + len) return;
      let payload = this.buf.subarray(off, off + len);
      if (masked) { const mask = this.buf.subarray(off - 4, off); const out = Buffer.alloc(len); for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i & 3]; payload = out; }
      this.buf = this.buf.subarray(off + len);
      if (opcode === 0x8) { this.close(); return; }
      if (opcode === 0x9) { if (!this.closed) this.socket.write(wsFrame(0xA, payload)); continue; }
      if (opcode === 0xA) continue;
      if (opcode === 0x1 || opcode === 0x2 || opcode === 0x0) {
        this.frag.push(payload);
        if (fin) { const whole = Buffer.concat(this.frag); this.frag = []; if (this.onmessage) this.onmessage(whole.toString("utf8")); }
      }
    }
  }
}

server.on("upgrade", (req, socket, head) => {
  const m = (req.url || "").match(/^\/api\/rooms\/([A-Z]{4})\/ws$/);
  const room = m && rooms.get(m[1]);
  const key = req.headers["sec-websocket-key"];
  if (!room || !key || Date.now() - room.createdAt > ROOM_TTL_MS) { socket.write("HTTP/1.1 404 Not Found\r\n\r\n"); socket.destroy(); return; }
  const accept = crypto.createHash("sha1").update(key + WS_GUID).digest("base64");
  socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n");
  const ws = new Socket(socket);
  room.sockets.add(ws);
  ws.onmessage = raw => handleMessage(room, ws, raw);
  ws.onclose = () => room.sockets.delete(ws);
  if (head && head.length) ws.feed(head);
});

// tidy old rooms once an hour
setInterval(() => { for (const [code, r] of rooms) if (Date.now() - r.createdAt > ROOM_TTL_MS) rooms.delete(code); }, 60 * 60 * 1000).unref();

server.listen(PORT, "0.0.0.0", () => {
  const addrs = [];
  for (const list of Object.values(os.networkInterfaces())) for (const a of list) if (a.family === "IPv4" && !a.internal) addrs.push(a.address);
  console.log("\nRare Answer Twenty is running.\n");
  console.log("  On this computer:   http://localhost:" + PORT);
  for (const a of addrs) console.log("  On your Wi-Fi:      http://" + a + ":" + PORT + "   <- open this on your phone");
  console.log("\nKeep this window open while you play. Press Ctrl+C to stop.\n");
});
