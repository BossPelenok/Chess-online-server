'use strict';
// Minimal WebSocket signaling/room server for the chess game's online mode.
// Deploy this separately from the static HTML game.
const http = require('http');
const crypto = require('crypto');
const WebSocket = require('ws');
const PORT = Number(process.env.PORT || 8080);
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('Chess online server is running.');
});
const wss = new WebSocket.Server({ server });
const rooms = new Map();
const waiting = new Set();
const clients = new Map();
const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function send(ws, data) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data)); }
function codeOf(length = 5) { let out = ''; for (let i = 0; i < length; i++) out += alphabet[crypto.randomInt(alphabet.length)]; return out; }
function newCode() { let code; do { code = codeOf(); } while (rooms.has(code)); return code; }
function startRoom(room) {
  if (!room || room.players.length !== 2 || room.started) return;
  room.started = true;
  room.players.forEach((ws, index) => {
    clients.set(ws, { room: room.code, color: index === 0 ? 'w' : 'b' });
    send(ws, { type: 'match-start', code: room.code, color: index === 0 ? 'w' : 'b' });
  });
}
function leave(ws) {
  waiting.delete(ws);
  const info = clients.get(ws);
  if (!info) return;
  clients.delete(ws);
  const room = rooms.get(info.room);
  if (!room) return;
  const opponent = room.players.find(player => player !== ws);
  if (opponent) send(opponent, { type: 'opponent-left' });
  room.players = room.players.filter(player => player !== ws);
  if (!room.players.length) rooms.delete(room.code);
  else room.started = false;
}
function fail(ws, message, fatal = false) { send(ws, { type: 'error', message, fatal }); }
wss.on('connection', ws => {
  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return fail(ws, 'Некорректный запрос.'); }
    if (!msg || typeof msg.type !== 'string') return;
    if (msg.type === 'leave') { leave(ws); return; }
    if (msg.type === 'create') {
      if (clients.has(ws)) leave(ws);
      const code = newCode();
      rooms.set(code, { code, players: [ws], started: false, createdAt: Date.now() });
      clients.set(ws, { room: code, color: 'w' });
      send(ws, { type: 'room-created', code });
      return;
    }
    if (msg.type === 'join') {
      const code = String(msg.code || '').toUpperCase();
      const room = rooms.get(code);
      if (!room || room.started || room.players.length !== 1) return fail(ws, 'Комната не найдена или уже заполнена. Проверь код.');
      if (room.players.includes(ws)) return;
      if (clients.has(ws)) leave(ws);
      room.players.push(ws); startRoom(room); return;
    }
    if (msg.type === 'random') {
      if (clients.has(ws)) leave(ws);
      const opponent = [...waiting].find(player => player !== ws && player.readyState === WebSocket.OPEN);
      if (opponent) {
        waiting.delete(opponent);
        const code = newCode();
        const room = { code, players: [opponent, ws], started: false, createdAt: Date.now() };
        rooms.set(code, room); startRoom(room);
      } else {
        waiting.add(ws); send(ws, { type: 'waiting' });
      }
      return;
    }
    if (msg.type === 'move') {
      const info = clients.get(ws);
      if (!info || !msg.san) return fail(ws, 'Ты не находишься в активной комнате.');
      const room = rooms.get(info.room);
      if (!room || !room.started) return fail(ws, 'Партия ещё не началась.');
      const opponent = room.players.find(player => player !== ws);
      // Clients validate chess legality with chess.js; the server relays only the move notation.
      send(opponent, { type: 'opponent-move', san: String(msg.san).slice(0, 16) });
      return;
    }
  });
  ws.on('close', () => leave(ws));
  ws.on('error', () => leave(ws));
});
// Remove abandoned waiting entries and stale, unstarted rooms.
setInterval(() => {
  for (const ws of waiting) if (ws.readyState !== WebSocket.OPEN) waiting.delete(ws);
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [code, room] of rooms) if (!room.started && room.createdAt < cutoff) { for (const player of room.players) clients.delete(player); rooms.delete(code); }
}, 60_000).unref();
server.listen(PORT, '0.0.0.0', () => console.log(`Chess online server listening on ${PORT}`));
