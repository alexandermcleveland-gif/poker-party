/* server.js — Multiplayer host for the Poker Trainer.
   Run: node server.js  (or double-click "Start Poker Server.bat")
   Friends on the same Wi-Fi open http://<your-LAN-IP>:8766 to join.

   Zero dependencies: Node stdlib only. Game rules come from engine.js — the same
   engine the solo trainer uses. Clients poll a JSON API; each player only ever
   receives their own hole cards until a showdown/runout makes hands public. */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const E = require('./engine.js');

// Cloud hosts (Render, Fly, etc.) inject their own PORT; fall back to LAN default.
const PORT = Number(process.env.PORT || process.env.POKER_PORT) || 8766;
const BOT_DELAY_MS = Number(process.env.POKER_BOT_MS) || 900;
// When set (online mode), players must type this code to join the table.
const ROOM_CODE = (process.env.POKER_ROOM_CODE || '').trim();
const QUIET = !!process.env.POKER_QUIET; // launcher prints its own banner
const MAX_SEATS = 4;
const STARTING_STACK = 1000;

// Bots keep their personalities (relative style) but a difficulty preset shifts
// the whole field: Easy = loose/passive "calling stations" that are easy to beat;
// Hard = tight and aggressive. Each bot's flavor delta keeps them feeling distinct.
const DIFFICULTIES = {
  easy: { base: { tight: 0.15, aggr: 0.20, bluff: 0.05 }, label: 'Easy' },
  medium: { base: { tight: 0.50, aggr: 0.55, bluff: 0.20 }, label: 'Medium' },
  hard: { base: { tight: 0.72, aggr: 0.80, bluff: 0.38 }, label: 'Hard' },
};
const BOT_FLAVOR = [
  { name: 'Rosie', emoji: '🦊', d: { tight: -0.18, aggr: 0.12, bluff: 0.10 } },
  { name: 'Tex', emoji: '🤠', d: { tight: 0, aggr: 0, bluff: 0 } },
  { name: 'Doc', emoji: '🦉', d: { tight: 0.14, aggr: -0.15, bluff: -0.05 } },
];
const clamp01 = (x) => Math.max(0.02, Math.min(0.98, x));
function botPersonality(flavor, diffKey) {
  const base = (DIFFICULTIES[diffKey] || DIFFICULTIES.medium).base;
  return {
    tight: clamp01(base.tight + flavor.d.tight),
    aggr: clamp01(base.aggr + flavor.d.aggr),
    bluff: clamp01(base.bluff + flavor.d.bluff),
  };
}
const HUMAN_EMOJI = ['🙂', '🐯', '🐼', '🦁'];

// ---------- static files (explicit whitelist — nothing else is served) ----------
const STATIC_FILES = {
  '/': 'Poker Party.html',
  '/index.html': 'Poker Party.html',
  '/Poker Party.html': 'Poker Party.html',
  '/Poker Trainer.html': 'Poker Trainer.html',
  '/engine.js': 'engine.js',
  '/app.js': 'app.js',
  '/mp.js': 'mp.js',
  '/styles.css': 'styles.css',
};
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

// ---------- session ----------
// seq is monotonic ACROSS resets (never rewound) so a lagging client can always
// tell it is behind; gen bumps each game so clients flush stale animation.
function newLobby(keepPlayers, keepSeq, keepGen) {
  return {
    mode: 'lobby',           // 'lobby' | 'game'
    players: keepPlayers || [], // humans: {token, name, emoji, isHost, lastSeen}
    game: null,
    log: [],                 // {seq, ev, revealed:[seats]}
    seq: keepSeq || 0,
    gen: keepGen || 0,       // game generation — increments on each start
    revealed: new Set(),     // seats whose hole cards are public this hand
    botTimer: null,
    botGen: 0,
  };
}
let S = newLobby();

const findPlayer = (token) => S.players.find((p) => p.token === token) || null;
// Humans sit at their join-order index. A player waiting to be dealt in (joined
// mid-game) has no seat yet, so they spectate until the next hand seats them.
const seatOf = (player) => (player.spectating ? -1 : S.players.indexOf(player));

// At a hand boundary, seat any waiting players by taking over an open bot seat.
function seatWaitingPlayers() {
  if (!S.game) return;
  S.players.forEach((p, i) => {
    if (!p.spectating) return;
    const seat = S.game.seats[i];
    if (seat && seat.isBot) { // take over this bot's seat with a fresh buy-in
      seat.isBot = false;
      seat.name = p.name;
      seat.emoji = p.emoji;
      seat.personality = null;
      seat.out = false;
      seat.stack = STARTING_STACK;
      p.spectating = false;
      pushSyntheticEvent({ type: 'sit-in', seat: i, name: p.name });
    }
  });
}

function drainToLog() {
  if (!S.game) return;
  for (const ev of S.game.drainEvents()) {
    if (ev.type === 'hand-start') S.revealed = new Set();
    if ((ev.type === 'runout' || ev.type === 'showdown') && ev.reveals) {
      ev.reveals.forEach((r) => S.revealed.add(r.seat));
    }
    S.log.push({ seq: ++S.seq, ev, revealed: Array.from(S.revealed) });
  }
  if (S.log.length > 1000) S.log = S.log.slice(S.log.length - 1000);
}

function pushSyntheticEvent(ev) {
  ev.snap = S.game._snapshot();
  S.log.push({ seq: ++S.seq, ev, revealed: Array.from(S.revealed) });
}

// If a human is disconnected (not polled recently) or dawdles past the hard cap,
// the server acts for them (check if free, else fold) so one person can't freeze
// the whole table — essential for a permanent public server with no host present.
const HUMAN_DISCONNECT_MS = Number(process.env.POKER_HUMAN_DISCONNECT_MS) || 20000; // no poll in 20s => gone
const HUMAN_TURN_MAX_MS = Number(process.env.POKER_HUMAN_MAX_MS) || 120000;  // hard cap per turn even if connected
const ACTOR_CHECK_MS = Number(process.env.POKER_ACTOR_CHECK_MS) || 4000;

function autoActFor(seat) {
  const g = S.game;
  const la = g.legalActions(seat);
  g.act(seat, la.canCheck ? { type: 'check' } : { type: 'fold' });
  drainToLog();
  scheduleBots();
}

// Advances play: schedules the bot's move, OR a watchdog for a human whose turn it is.
function scheduleBots() {
  if (S.botTimer) { clearTimeout(S.botTimer); S.botTimer = null; }
  const g = S.game;
  if (!g || g.phase !== 'betting' || g.actor == null) return;
  const seat = g.actor;
  const gen = ++S.botGen;

  if (g.seats[seat].isBot) {
    S.botTimer = setTimeout(() => {
      if (gen !== S.botGen) return;
      const g2 = S.game;
      if (!g2 || g2.phase !== 'betting' || g2.actor !== seat || !g2.seats[seat].isBot) return;
      const d = E.botDecide(g2, seat);
      if (!g2.act(seat, d)) {
        const la = g2.legalActions(seat);
        g2.act(seat, la.canCheck ? { type: 'check' } : { type: 'fold' });
      }
      drainToLog();
      scheduleBots();
    }, BOT_DELAY_MS);
    return;
  }

  // Human actor: THIS turn starts now. Each scheduleBots() call is a fresh turn
  // (the previous actor just finished), so reset the deadline every time — otherwise
  // a player who keeps their seat across hands would be timed from their first-ever
  // turn and get auto-acted on every move once the session passed the limit.
  const turnStart = Date.now();
  S.turnStartedAt = turnStart;  // exposed to clients as a live play-clock
  S.turnActorSeat = seat;
  const tick = () => {
    if (gen !== S.botGen) return;
    const g2 = S.game;
    if (!g2 || g2.phase !== 'betting' || g2.actor !== seat || g2.seats[seat].isBot) return;
    const p = S.players[seat];
    const now = Date.now();
    const gone = !p || (now - p.lastSeen > HUMAN_DISCONNECT_MS);
    const tooLong = now - turnStart > HUMAN_TURN_MAX_MS;
    if (gone || tooLong) { autoActFor(seat); return; }
    S.botTimer = setTimeout(tick, ACTOR_CHECK_MS);
  };
  S.botTimer = setTimeout(tick, ACTOR_CHECK_MS);
}

// ---------- redaction: never leak hidden hole cards over the wire ----------
function redactSnap(snap, forSeat, revealedSet) {
  if (!snap) return snap;
  return Object.assign({}, snap, {
    seats: snap.seats.map((s, i) => Object.assign({}, s, {
      hole: (i === forSeat || revealedSet.has(i)) ? s.hole : s.hole.map(() => -1),
    })),
  });
}

function redactEvent(logEntry, forSeat) {
  const revealed = new Set(logEntry.revealed);
  const ev = JSON.parse(JSON.stringify(logEntry.ev));
  if (ev.snap) ev.snap = redactSnap(ev.snap, forSeat, revealed);
  // runout/showdown reveals are public by definition; everything else carries no holes
  ev.seq = logEntry.seq;
  return ev;
}

// ---------- API handlers ----------
// Room-code brute-force guard, keyed PER CLIENT so a stranger spamming wrong codes
// can't lock out players who have the right code. A correct code is always admitted;
// only wrong guesses are throttled (10 per minute per IP).
const badCodeByIp = new Map(); // ip -> [timestamps]
function bruteLocked(ip) {
  const now = Date.now();
  const recent = (badCodeByIp.get(ip) || []).filter((t) => t > now - 60000);
  badCodeByIp.set(ip, recent);
  return recent.length >= 10;
}
function noteBadCode(ip) {
  const arr = badCodeByIp.get(ip) || [];
  arr.push(Date.now());
  badCodeByIp.set(ip, arr);
}
setInterval(() => { // keep the map from growing unboundedly with random scanners
  const cut = Date.now() - 60000;
  for (const [ip, arr] of badCodeByIp) {
    const r = arr.filter((t) => t > cut);
    if (r.length) badCodeByIp.set(ip, r); else badCodeByIp.delete(ip);
  }
}, 60000).unref();

function codeMatches(input) {
  const a = Buffer.from(String(input || '').trim().toUpperCase());
  const b = Buffer.from(ROOM_CODE.toUpperCase());
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Drop players who have gone quiet (closed their tab) so their seat frees up.
// Only safe in the lobby — during a game, seat indices map positionally to players.
const PLAYER_STALE_MS = 30000;
function reapLobbyGhosts() {
  if (S.mode !== 'lobby') return;
  const now = Date.now();
  const kept = S.players.filter((p) => now - p.lastSeen <= PLAYER_STALE_MS);
  if (kept.length !== S.players.length) {
    S.players = kept;
    if (kept.length && !kept.some((p) => p.isHost)) kept[0].isHost = true;
  }
}

function apiJoin(body, ip) {
  if (ROOM_CODE) {
    if (!codeMatches(body.code)) {
      if (bruteLocked(ip)) return { ok: false, error: 'Too many wrong codes from your connection — wait a minute.' };
      noteBadCode(ip);
      return { ok: false, error: 'Wrong room code — ask the host for it.', badCode: true };
    }
  }
  reapLobbyGhosts(); // free seats held by players who left
  if (S.players.length >= MAX_SEATS) return { ok: false, error: 'Table is full — 4 players max.' };
  // Joining mid-game is always allowed: you watch, then get dealt in at the next
  // hand (taking over a bot seat) or at the next game if the table has no bot to free.
  const midGame = S.mode === 'game';
  let name = String(body.name || '').replace(/[^\w\s'-]/g, '').trim().slice(0, 12);
  if (!name) name = 'Player';
  const taken = new Set(S.players.map((p) => p.name));
  let unique = name, n = 2;
  while (taken.has(unique)) unique = name.slice(0, 10) + ' ' + n++;
  const player = {
    token: crypto.randomBytes(12).toString('hex'),
    name: unique,
    emoji: HUMAN_EMOJI[S.players.length % HUMAN_EMOJI.length],
    isHost: S.players.length === 0,
    lastSeen: Date.now(),
    spectating: midGame, // seated at the next hand
  };
  S.players.push(player);
  return { ok: true, token: player.token, name: player.name, spectating: midGame };
}

function apiStart(player, body) {
  // Any player can start (avoids a frozen lobby if the first joiner leaves).
  if (S.mode !== 'lobby') return { ok: false, error: 'Already started.' };
  const humans = S.players.map((p) => ({ name: p.name, isBot: false, emoji: p.emoji }));
  const seats = humans.slice();
  const diffKey = DIFFICULTIES[body.difficulty] ? body.difficulty : 'medium';
  const maxBots = MAX_SEATS - seats.length;
  let botCount = Number(body.botCount);
  if (!Number.isFinite(botCount)) botCount = maxBots; // default: fill the table
  botCount = Math.max(0, Math.min(maxBots, Math.round(botCount)));
  for (let i = 0; i < botCount; i++) {
    const f = BOT_FLAVOR[i % BOT_FLAVOR.length];
    seats.push({ name: f.name, isBot: true, emoji: f.emoji, personality: botPersonality(f, diffKey) });
  }
  if (seats.length < 2) return { ok: false, error: 'Need at least 2 players — invite someone or add a bot.' };
  S.players.forEach((p) => { p.spectating = false; }); // everyone in the lobby is seated now
  S.game = new E.Game({ players: seats, startingStack: STARTING_STACK, smallBlind: 5, bigBlind: 10 });
  S.mode = 'game';
  S.gen++;                 // new game generation
  S.log = []; S.revealed = new Set(); // seq is NOT reset — stays monotonic across games
  S.difficulty = diffKey;
  S.game.startHand();
  drainToLog();
  scheduleBots();
  return { ok: true };
}

function apiNext(player) {
  // Any seated player may deal the next hand; phase check makes double-deals harmless.
  const g = S.game;
  if (!g || S.mode !== 'game') return { ok: false, error: 'No game running.' };
  if (g.phase === 'gameOver') return { ok: false, error: 'Game over — reset to return to the lobby.' };
  if (g.phase !== 'handComplete') return { ok: false, error: 'The hand is still going.' };
  seatWaitingPlayers(); // deal in anyone who joined mid-game (takes over a bot seat)
  // Humans always rebuy so nobody sits out; bots stay busted.
  g.seats.forEach((s, i) => {
    if (!s.isBot && s.stack <= 0) {
      s.stack = STARTING_STACK;
      s.out = false;
      pushSyntheticEvent({ type: 'rebuy', seat: i, amount: STARTING_STACK });
    }
  });
  g.startHand();
  drainToLog();
  scheduleBots();
  return { ok: true };
}

function apiReset(player) {
  // Any player can reset to the lobby (so a stuck table is always recoverable).
  if (S.botTimer) clearTimeout(S.botTimer);
  S.botGen++; // invalidate any pending bot/actor timer callback
  // Return to the lobby, keeping only players who are still connected, as normal
  // (non-spectating) players — drops ghosts so seats aren't stuck taken.
  const now = Date.now();
  const kept = S.players
    .filter((p) => now - p.lastSeen <= PLAYER_STALE_MS)
    .map((p) => Object.assign({}, p, { spectating: false }));
  if (kept.length && !kept.some((p) => p.isHost)) kept[0].isHost = true;
  S = newLobby(kept, S.seq, S.gen);
  return { ok: true };
}

function apiAct(player, body) {
  const g = S.game;
  const seat = seatOf(player);
  if (!g || S.mode !== 'game') return { ok: false, error: 'No game running.' };
  if (g.phase !== 'betting' || g.actor !== seat) return { ok: false, error: 'Not your turn.' };
  const a = body.action || {};
  const type = String(a.type || '');
  if (!['fold', 'check', 'call', 'raise'].includes(type)) return { ok: false, error: 'Bad action.' };
  const action = { type };
  if (type === 'raise') {
    const amt = Math.round(Number(a.amount));
    if (!Number.isFinite(amt) || amt <= 0) return { ok: false, error: 'Bad raise amount.' };
    action.amount = amt;
  }
  const applied = g.act(seat, action);
  if (!applied) return { ok: false, error: 'Illegal action.' };
  drainToLog();
  scheduleBots();
  return { ok: true };
}

function apiState(player, query) {
  player.lastSeen = Date.now();
  reapLobbyGhosts(); // keep the lobby list fresh and free seats held by no-shows
  const seat = S.mode === 'game' ? seatOf(player) : -1;
  const now = Date.now();
  const resp = {
    ok: true,
    mode: S.mode,
    serverSeq: S.seq,
    gen: S.gen,
    you: { seat, name: player.name, emoji: player.emoji, isHost: player.isHost, spectating: !!player.spectating },
    lobby: {
      players: S.players.map((p) => ({
        name: p.name, emoji: p.emoji, isHost: p.isHost,
        connected: now - p.lastSeen < 6000,
      })),
      maxSeats: MAX_SEATS,
    },
  };
  if (S.mode === 'game' && S.game) {
    const g = S.game;
    const since = Math.max(0, Number(query.since) || 0);
    const clientGen = Number(query.gen);
    const oldest = S.log.length ? S.log[0].seq : 0;
    // Full resync when: client behind trimmed history, ahead of us, from a previous
    // game generation, or so far behind that replaying would be a long animation.
    const backlog = S.log.filter((l) => l.seq > since).length;
    resp.resync = since > S.seq || (since > 0 && since + 1 < oldest) ||
      (Number.isFinite(clientGen) && clientGen !== S.gen) || (since === 0 && backlog > 24) || backlog > 60;
    resp.events = resp.resync ? [] : S.log.filter((l) => l.seq > since).map((l) => redactEvent(l, seat));
    resp.state = redactSnap(g._snapshot(), seat, S.revealed);
    resp.hole = seat >= 0 && g.seats[seat] ? g.seats[seat].hole : [];
    resp.phase = g.phase;
    resp.handNum = g.handNum;
    resp.hostName = (S.players.find((p) => p.isHost) || {}).name || '?';
    resp.difficulty = (DIFFICULTIES[S.difficulty] || DIFFICULTIES.medium).label;
    resp.seatsMeta = g.seats.map((s) => ({ name: s.name, emoji: s.emoji, isBot: s.isBot }));
    resp.youTurn = g.phase === 'betting' && g.actor === seat;
    // Live play clock for the current human actor (bots act instantly, so no clock).
    if (g.phase === 'betting' && g.actor != null && g.seats[g.actor] &&
        !g.seats[g.actor].isBot && S.turnActorSeat === g.actor && S.turnStartedAt) {
      resp.actorSeat = g.actor;
      resp.actorMsLeft = Math.max(0, HUMAN_TURN_MAX_MS - (Date.now() - S.turnStartedAt));
      resp.turnMaxMs = HUMAN_TURN_MAX_MS;
    }
    if (resp.youTurn) {
      resp.legal = g.legalActions(seat);
      resp.pot = g.totalPot();
      resp.currentBet = g.currentBet;
      resp.bigBlind = g.bigBlind;
      resp.street = g.street;
      resp.button = g.button;
    }
  }
  return resp;
}

// ---------- HTTP plumbing ----------
function sendJson(res, obj, code) {
  const body = JSON.stringify(obj);
  res.writeHead(code || 200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 10240) { reject(new Error('body too large')); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  // Parse defensively: a malformed URL / percent-escape must never crash the host.
  let u, pathname;
  try {
    u = new URL(req.url, 'http://x');
    pathname = decodeURIComponent(u.pathname);
  } catch (e) {
    res.writeHead(400); return res.end('Bad request');
  }

  if (pathname.startsWith('/api/')) {
    try {
      const query = Object.fromEntries(u.searchParams);
      if (pathname === '/api/info' && req.method === 'GET') {
        return sendJson(res, { ok: true, needCode: !!ROOM_CODE });
      }
      if (pathname === '/api/join' && req.method === 'POST') {
        // Behind Render/Cloudflare the real client IP is the first X-Forwarded-For hop.
        const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
        const ip = fwd || (req.socket && req.socket.remoteAddress) || 'unknown';
        return sendJson(res, apiJoin(await readBody(req), ip));
      }
      // every other endpoint needs a valid token
      const body = req.method === 'POST' ? await readBody(req) : {};
      const token = body.token || query.token || '';
      const player = findPlayer(token);
      if (!player) return sendJson(res, { ok: false, error: 'unknown-token' });
      if (pathname === '/api/state' && req.method === 'GET') return sendJson(res, apiState(player, query));
      if (pathname === '/api/start' && req.method === 'POST') return sendJson(res, apiStart(player, body));
      if (pathname === '/api/act' && req.method === 'POST') return sendJson(res, apiAct(player, body));
      if (pathname === '/api/next' && req.method === 'POST') return sendJson(res, apiNext(player));
      if (pathname === '/api/reset' && req.method === 'POST') return sendJson(res, apiReset(player));
      return sendJson(res, { ok: false, error: 'not found' }, 404);
    } catch (e) {
      return sendJson(res, { ok: false, error: 'bad request' }, 400);
    }
  }

  const file = STATIC_FILES[pathname];
  if (!file) { res.writeHead(404); return res.end('Not found'); }
  const full = path.join(__dirname, file);
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
});

server.on('error', (e) => {
  if (e && e.code === 'EADDRINUSE') {
    console.log('');
    console.log('  ⚠  The Poker Party server is already running.');
    console.log('  ─────────────────────────────────────────────');
    console.log('  Port ' + PORT + ' is already in use — you probably have another');
    console.log('  Poker Party window open. You don\'t need a second one:');
    console.log('');
    console.log('     • To PLAY: just open http://localhost:' + PORT + ' in your browser.');
    console.log('     • To RESTART fresh: close the other Poker Party server');
    console.log('       window first, then run this again.');
    console.log('');
  } else {
    console.log('  Server error: ' + (e && e.message));
  }
  process.exit(1);
});

// Rank IPv4 addresses so the real home-Wi-Fi one is offered first and VPN /
// link-local ones (which friends on your Wi-Fi CAN'T reach) are set aside.
function lanAddresses() {
  const nets = os.networkInterfaces();
  const out = [];
  for (const ifname of Object.keys(nets)) {
    for (const net of (nets[ifname] || [])) {
      if (net.family !== 'IPv4' || net.internal) continue;
      if (net.address.startsWith('169.254.')) continue; // link-local, never routable
      const isVpn = /vpn|nord|tailscale|wireguard|openvpn|zerotier|hamachi|nordlynx/i.test(ifname) ||
        /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(net.address); // CGNAT / Tailscale range
      let rank;
      if (isVpn) rank = 5;
      else if (net.address.startsWith('192.168.')) rank = 0; // typical home Wi-Fi/router
      else if (/^172\.(1[6-9]|2\d|3[01])\./.test(net.address)) rank = 1;
      else if (net.address.startsWith('10.')) rank = 2;
      else rank = 3;
      out.push({ ifname, address: net.address, isVpn, rank });
    }
  }
  return out.sort((a, b) => a.rank - b.rank);
}

server.listen(PORT, '0.0.0.0', () => {
  if (QUIET) return; // online launcher prints its own banner
  const addrs = lanAddresses();
  const best = addrs.find((a) => !a.isVpn);
  const others = addrs.filter((a) => a !== best);
  console.log('');
  console.log('  ♠ Poker Party server is running!');
  console.log('  ─────────────────────────────────────────────');
  console.log('  On THIS computer:   http://localhost:' + PORT);
  if (best) {
    console.log('');
    console.log('  For friends on your Wi-Fi, share this link:');
    console.log('      →  http://' + best.address + ':' + PORT + '   (via "' + best.ifname + '")');
  } else {
    console.log('  (Could not detect a Wi-Fi address — see the list below.)');
  }
  if (others.length) {
    console.log('');
    console.log('  Other addresses (probably NOT the right one to share):');
    others.forEach((a) => {
      console.log('      http://' + a.address + ':' + PORT +
        '   (' + a.ifname + (a.isVpn ? ' — VPN, friends can\'t use this' : '') + ')');
    });
  }
  if (addrs.some((a) => a.isVpn)) {
    console.log('');
    console.log('  NOTE: You have a VPN (e.g. NordVPN/Tailscale) running. Use the');
    console.log('  192.168.x.x link above. If friends still can\'t connect, enable');
    console.log('  "Allow LAN traffic / Local network" in your VPN, or turn the VPN');
    console.log('  off while hosting.');
  }
  console.log('  ─────────────────────────────────────────────');
  console.log('  Everyone opens the link, enters a name, and any');
  console.log('  player can pick the bots and start the game.');
  console.log('  Press Ctrl+C to stop the server.');
  console.log('');
});

// Last-resort guards: no single bad request or edge case should end the party.
process.on('uncaughtException', (e) => console.error('[server] uncaught:', e && e.message));
process.on('unhandledRejection', (e) => console.error('[server] unhandled rejection:', e && e.message));
