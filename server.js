'use strict';
const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const path    = require('path');
const crypto  = require('crypto');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*' },
  pingInterval: 10000,
  pingTimeout:  30000,
});

/*
══════════════════════════════════════════
  YALANCILАР KAHVESİ  — Server Engine
══════════════════════════════════════════
  FLOW:
    lobby → playing → (turn: play → challenge_window) → … → ended

  RULES:
    • 52-card deck, 5 cards dealt per player
    • Turn player picks 1–3 cards, claims a rank → plays face-down
    • 8 s challenge window: any other player can call "YALAN!"
        – Liar caught  → claimant  −sabır
        – Wrong call   → challenger −sabır
    • sabır starts at 5; reach 0 → eliminated
    • Turn timer 10 s → auto-play if AFK
    • Last survivor wins

  MODES:  normal | chaos | silence | highrisk
    chaos     : 25 % chance a played card is secretly swapped
    silence   : chat disabled
    highrisk  : penalty = 2 instead of 1
══════════════════════════════════════════
*/

/* ── Deck ── */
const SUITS = ['♠','♥','♦','♣'];
const RANKS = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];

function makeDeck() {
  const d = [];
  for (const s of SUITS) for (const r of RANKS) d.push({ id: `${r}${s}`, rank: r, suit: s });
  return shuffle([...d]);
}
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/* ── Constants ── */
const ROOMS     = new Map();
let   roomSeq   = 1;
const timers    = new Map();
const AVATARS   = ['🎩','🦊','🐺','🗡','👁','🎭','🔮','🐍','☕','🃏','🌙','🎪'];
const COLORS    = ['#d4880a','#9944aa','#2288cc','#44aa44','#cc4422','#8844cc'];
const SABIR_MAX = 5;
const TURN_MS   = 10_000;
const CHAL_MS   =  8_000;
const REVEAL_MS =  3_200;

/* ── Room factory ── */
function makeRoom(id, mode = 'normal') {
  return {
    id, mode,
    players:  [],
    phase:    'lobby',
    deck:     [],
    pile:     [],
    claim:    null,   // { pid, rank, count, cards, _liar }
    turnIdx:  0,
    winner:   null,
    round:    0,
    tEnd:     null,
    tType:    null,   // 'turn' | 'challenge'
    messages: [],
    svotes:   { liar: 0, truth: 0 },
    created:  Date.now(),
  };
}

function findOrCreate(mode) {
  for (const [, r] of ROOMS)
    if (r.phase === 'lobby' && r.players.length < 6 && r.mode === mode) return r;
  const id = `K${roomSeq++}`, r = makeRoom(id, mode);
  ROOMS.set(id, r);
  return r;
}

/* ── Helpers ── */
function pub(room, ev, data) { io.to(`r:${room.id}`).emit(ev, data); }

function pushMsg(room, m) {
  m.id = m.id || crypto.randomUUID();
  m.ts = Date.now();
  room.messages.push(m);
  if (room.messages.length > 250) room.messages.shift();
  pub(room, 'msg', m);
}

function sysMsg(room, body, type = 'system') {
  pushMsg(room, { type, body });
}

function active(room) { return room.players.filter(p => !p.out); }
function byId(room, id) { return room.players.find(p => p.id === id); }

function setTimer(room, ms, type, cb) {
  clearTimer(room);
  room.tEnd  = Date.now() + ms;
  room.tType = type;
  timers.set(room.id, setTimeout(() => {
    if (!ROOMS.has(room.id)) return;
    room.tEnd = null; room.tType = null;
    cb();
  }, ms));
}
function clearTimer(room) {
  clearTimeout(timers.get(room.id));
  timers.delete(room.id);
  room.tEnd = null; room.tType = null;
}

/* ── State snapshot ── */
function snap(room, forId = null) {
  const act = active(room);
  return {
    id:      room.id,
    mode:    room.mode,
    phase:   room.phase,
    turnPid: act[room.turnIdx % Math.max(1, act.length)]?.id ?? null,
    claim:   room.claim
      ? { pid: room.claim.pid, rank: room.claim.rank, count: room.claim.count }
      : null,
    pileN:   room.pile.length,
    winner:  room.winner,
    round:   room.round,
    tEnd:    room.tEnd,
    tType:   room.tType,
    svotes:  room.svotes,
    players: room.players.map(p => ({
      id:    p.id,    name:  p.name,  slot:  p.slot,
      avatar:p.avatar,color: p.color, sabir: p.sabir,
      cards: p.hand?.length ?? 0,
      afk:   p.afk,  out:   p.out,   on:    p.on,
      hand:  p.id === forId ? p.hand : undefined,
    })),
  };
}

function broadcast(room) {
  for (const p of room.players) {
    const s = io.sockets.sockets.get(p.id);
    if (s) s.emit('state', snap(room, p.id));
  }
  pub(room, 'spub', snap(room, null));
}

/* ══════════════════════════════════════
   GAME LOGIC
══════════════════════════════════════ */
function startGame(room) {
  room.phase = 'playing';
  room.round = 1;
  room.pile  = [];
  room.claim = null;
  room.winner = null;
  room.turnIdx = 0;
  room.svotes  = { liar: 0, truth: 0 };

  for (const p of room.players) {
    p.sabir = SABIR_MAX; p.out = false; p.afk = false;
  }
  const deck = makeDeck(); let i = 0;
  for (const p of room.players) { p.hand = deck.slice(i, i + 5); i += 5; }
  room.deck = deck.slice(i);

  sysMsg(room, `☕ Oyun başladı! ${room.players.length} oyuncu masada. Şansınız bol!`);
  broadcast(room);
  beginTurn(room);
}

function beginTurn(room) {
  const act = active(room);
  if (!act.length) return;
  room.turnIdx = room.turnIdx % act.length;
  room.phase   = 'playing';
  room.claim   = null;
  room.svotes  = { liar: 0, truth: 0 };

  const cur = act[room.turnIdx];
  if (!cur.hand.length) refill(room, cur);

  sysMsg(room, `🃏 ${cur.avatar} ${cur.name} oynuyor...`, 'turn');
  broadcast(room);

  const ms = room.mode === 'chaos' ? 8_000 : TURN_MS;
  setTimer(room, ms, 'turn', () => {
    cur.afk = true;
    autoPlay(room, cur);
  });
}

function refill(room, p) {
  if (!room.deck.length) room.deck = makeDeck();
  p.hand = room.deck.splice(0, 3);
}

function autoPlay(room, p) {
  if (!p.hand.length) refill(room, p);
  const c = p.hand[0];
  doPlay(room, p.id, [c.id], c.rank, true);
}

function doPlay(room, pid, cardIds, claimedRank, auto = false) {
  const p = byId(room, pid);
  if (!p) return;
  clearTimer(room);

  const cards = cardIds.map(id => p.hand.find(c => c.id === id)).filter(Boolean);
  if (!cards.length) return;
  p.hand = p.hand.filter(c => !cardIds.includes(c.id));

  // CHAOS: secretly swap one card ~25%
  let playCards = [...cards], chaosSwap = false;
  if (room.mode === 'chaos' && Math.random() < 0.25) {
    const nd  = makeDeck();
    const idx = Math.floor(Math.random() * playCards.length);
    playCards[idx] = nd[0];
    chaosSwap = true;
  }

  room.pile.push(...playCards);
  const isLiar = playCards.some(c => c.rank !== claimedRank);
  room.claim   = { pid, rank: claimedRank, count: cards.length, cards: playCards, _liar: isLiar };
  room.phase   = 'challenge';

  const tag = auto ? ' (otomatik)' : '';
  pushMsg(room, {
    type: 'play', pid,
    body: `🃏 ${p.avatar} ${p.name} — "${cards.length}× ${claimedRank}" dedi${tag}`,
    rank: claimedRank, count: cards.length,
  });
  if (chaosSwap) sysMsg(room, '🌀 KAOS: Bir kart gizlice değiştirildi!');

  broadcast(room);

  setTimer(room, CHAL_MS, 'challenge', () => {
    sysMsg(room, `✅ Kimse itiraz etmedi — ${p.name}'in iddiası geçti.`);
    room.pile  = [];
    room.claim = null;
    room.phase = 'playing';
    refillCheck(room);
    advance(room);
  });
}

function doChallenge(room, challId) {
  if (room.phase !== 'challenge' || !room.claim) return false;
  if (challId === room.claim.pid) return false;
  const ch = byId(room, challId);
  if (!ch || ch.out) return false;
  clearTimer(room);

  const cl     = byId(room, room.claim.pid);
  const isLiar = room.claim._liar;
  const pen    = room.mode === 'highrisk' ? 2 : 1;

  pub(room, 'reveal', {
    cards:          room.claim.cards,
    isLiar,
    claimedRank:    room.claim.rank,
    claimantId:     room.claim.pid,
    claimantName:   cl?.name,
    claimantAvatar: cl?.avatar,
    challengerId:   challId,
    challengerName: ch?.name,
    challengerAvatar: ch?.avatar,
  });

  if (isLiar) {
    cl.sabir = Math.max(0, cl.sabir - pen);
    pushMsg(room, { type: 'caught', pid: cl.id, body: `😱 YALAN! ${cl?.avatar} ${cl?.name} yakalandı! −${pen} sabır (kalan: ${cl.sabir})` });
    pub(room, 'anim', { pid: cl.id, type: 'caught' });
  } else {
    ch.sabir = Math.max(0, ch.sabir - pen);
    pushMsg(room, { type: 'safe', pid: ch.id, body: `✅ DOĞRU! ${cl?.avatar} ${cl?.name} dürüsttü! ${ch?.avatar} ${ch?.name} −${pen} sabır (kalan: ${ch.sabir})` });
    pub(room, 'anim', { pid: ch.id, type: 'wrong' });
  }

  // Eliminate
  for (const p of room.players) {
    if (p.sabir <= 0 && !p.out) {
      p.out = true;
      pushMsg(room, { type: 'elim', pid: p.id, body: `💀 ${p.avatar} ${p.name} masadan kalktı!` });
      pub(room, 'anim', { pid: p.id, type: 'elim' });
    }
  }

  room.pile  = [];
  room.claim = null;

  const rem = active(room);
  broadcast(room);
  if (rem.length <= 1) { setTimeout(() => endGame(room, rem[0]?.id ?? null), 1200); return true; }
  room.turnIdx = room.turnIdx % rem.length;
  setTimeout(() => { room.phase = 'playing'; refillCheck(room); advance(room); }, REVEAL_MS);
  return true;
}

function advance(room) {
  const a = active(room);
  if (!a.length) return endGame(room, null);
  room.turnIdx = (room.turnIdx + 1) % a.length;
  beginTurn(room);
}

function refillCheck(room) {
  for (const p of active(room)) if (!p.hand?.length) refill(room, p);
}

function endGame(room, wid) {
  clearTimer(room);
  room.phase  = 'ended';
  room.winner = wid;
  const w = byId(room, wid);
  sysMsg(room, w ? `🏆 ${w.avatar} ${w.name} KAZANDI! Kahvenin şampiyonu!` : '🤝 Oyun sona erdi.');
  broadcast(room);
}

/* ══════════════════════════════════════
   SOCKET
══════════════════════════════════════ */
io.on('connection', socket => {

  /* JOIN */
  socket.on('join', ({ name, roomId: rId, mode = 'normal' } = {}, cb) => {
    const nm = (name || 'Misafir').slice(0, 20).trim();
    if (!nm) return cb?.({ ok: false, e: 'Ad gerekli' });

    let room;
    if (rId && ROOMS.has(rId)) room = ROOMS.get(rId);
    else room = findOrCreate(mode);

    if (room.players.length >= 6 && room.phase === 'lobby') {
      room = makeRoom(`K${roomSeq++}`, mode);
      ROOMS.set(room.id, room);
    }
    if (room.phase !== 'lobby') return cb?.({ ok: false, e: 'Oyun devam ediyor' });

    const slot   = room.players.length;
    const player = {
      id: socket.id, name: nm, slot,
      avatar: AVATARS[slot % AVATARS.length],
      color:  COLORS[slot % COLORS.length],
      hand:   [], sabir: SABIR_MAX, afk: false, out: false, on: true,
    };
    room.players.push(player);
    socket.join(`r:${room.id}`);
    socket.data.rid = room.id;

    socket.emit('history', room.messages.slice(-60));
    socket.emit('state', snap(room, socket.id));
    sysMsg(room, `${player.avatar} ${nm} kahveye girdi!`, 'join');
    broadcast(room);
    cb?.({ ok: true, roomId: room.id, slot, avatar: player.avatar, color: player.color });
  });

  /* STREAM SPECTATOR */
  socket.on('stream_join', ({ roomId: rId } = {}, cb) => {
    const room = ROOMS.get(rId);
    if (!room) return cb?.({ ok: false, e: 'Oda yok' });
    socket.join(`r:${rId}`);
    socket.data.rid    = rId;
    socket.data.stream = true;
    socket.emit('spub',    snap(room));
    socket.emit('history', room.messages.slice(-60));
    cb?.({ ok: true });
  });

  socket.on('stream_vote', ({ vote } = {}) => {
    const room = ROOMS.get(socket.data.rid);
    if (!room || !['liar', 'truth'].includes(vote)) return;
    room.svotes[vote] = (room.svotes[vote] || 0) + 1;
    pub(room, 'svotes', room.svotes);
  });

  /* START */
  socket.on('start', ({ mode: m } = {}, cb) => {
    const room = ROOMS.get(socket.data.rid);
    if (!room)               return cb?.({ ok: false, e: 'Oda yok' });
    if (room.phase !== 'lobby') return cb?.({ ok: false, e: 'Zaten başladı' });
    if (room.players.length < 2) return cb?.({ ok: false, e: 'En az 2 oyuncu' });
    if (m) room.mode = m;
    startGame(room);
    cb?.({ ok: true });
  });

  /* PLAY */
  socket.on('play', ({ cardIds, claimedRank } = {}, cb) => {
    const room = ROOMS.get(socket.data.rid);
    if (!room) return cb?.({ ok: false, e: 'Oda yok' });
    if (room.phase !== 'playing') return cb?.({ ok: false, e: 'Sıra değil' });
    const act = active(room);
    if (act[room.turnIdx % act.length]?.id !== socket.id)
      return cb?.({ ok: false, e: 'Sıra sizde değil' });
    if (!Array.isArray(cardIds) || !cardIds.length || cardIds.length > 3)
      return cb?.({ ok: false, e: '1–3 kart seçin' });
    if (!RANKS.includes(claimedRank))
      return cb?.({ ok: false, e: 'Geçersiz rank' });
    doPlay(room, socket.id, cardIds, claimedRank);
    cb?.({ ok: true });
  });

  /* CHALLENGE */
  socket.on('challenge', ({} = {}, cb) => {
    const room = ROOMS.get(socket.data.rid);
    if (!room || room.phase !== 'challenge') return cb?.({ ok: false, e: 'Yanlış aşama' });
    const ok = doChallenge(room, socket.id);
    cb?.({ ok });
  });

  /* EMOJI */
  socket.on('emoji', ({ emoji } = {}) => {
    const room = ROOMS.get(socket.data.rid);
    if (!room) return;
    const p = byId(room, socket.id);
    pub(room, 'emoji', { emoji, pid: socket.id, name: p?.name, avatar: p?.avatar });
  });

  /* ANIMATION */
  socket.on('anim', ({ type } = {}) => {
    const room = ROOMS.get(socket.data.rid);
    if (!room) return;
    if (!['laugh', 'doubt', 'knock', 'nervous', 'shrug'].includes(type)) return;
    const p = byId(room, socket.id);
    pub(room, 'anim', { pid: socket.id, type, name: p?.name, avatar: p?.avatar });
  });

  /* CHAT */
  socket.on('chat', ({ text } = {}) => {
    const room = ROOMS.get(socket.data.rid);
    if (!room) return;
    if (room.mode === 'silence') return;
    const p    = byId(room, socket.id);
    const body = (text || '').trim().slice(0, 200);
    if (!body) return;
    pushMsg(room, {
      type: 'chat', body,
      name: p?.name ?? '?', avatar: p?.avatar ?? '?',
      pid: socket.id, color: p?.color ?? '#aaa',
    });
  });

  /* NEW GAME */
  socket.on('new_game', ({} = {}, cb) => {
    const room = ROOMS.get(socket.data.rid);
    if (!room || room.phase !== 'ended') return cb?.({ ok: false });
    room.phase    = 'lobby'; room.winner = null;
    room.pile     = []; room.claim = null; room.messages = [];
    for (const p of room.players) { p.sabir = SABIR_MAX; p.hand = []; p.afk = false; p.out = false; }
    broadcast(room);
    sysMsg(room, '🔄 Yeni oyun — hazır olun!');
    cb?.({ ok: true });
  });

  /* DISCONNECT */
  socket.on('disconnect', () => {
    const room = ROOMS.get(socket.data.rid);
    if (!room) return;
    const p = byId(room, socket.id);
    if (!p) return;
    p.on = false;
    sysMsg(room, `${p.avatar} ${p.name} bağlantısı kesildi...`);
    if (room.phase === 'playing') {
      const act = active(room);
      if (act[room.turnIdx % Math.max(1, act.length)]?.id === socket.id) {
        clearTimer(room); p.afk = true; autoPlay(room, p);
      }
    }
    broadcast(room);
    setTimeout(() => {
      const r = ROOMS.get(room.id);
      if (r && r.players.every(x => !x.on)) ROOMS.delete(room.id);
    }, 300_000);
  });
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`☕  Yalancılar Kahvesi  →  http://localhost:${PORT}`));
