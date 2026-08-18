/* mp.js — Multiplayer client for Poker Party. Talks to server.js over a polling
   JSON API. The server only ever sends this client its own hole cards (opponents'
   cards arrive as -1 placeholders until a showdown makes them public). */
(function () {
  'use strict';
  const E = window.PokerEngine;
  const $ = (id) => document.getElementById(id);

  const POLL_MS = 700;
  const EVT_DELAY = 450, STREET_DELAY = 800;
  const TOKEN_KEY = 'pokerPartyToken';

  let token = null;
  try { token = localStorage.getItem(TOKEN_KEY); } catch (e) {}

  let latest = null;      // last /api/state response
  let mySeat = -1;
  let seatsMeta = [];     // [{name, emoji, isBot}]
  let tableBuilt = 0;     // number of seats currently built (0 = none)
  let lastSeq = 0;
  let coachOn = true;
  try { coachOn = localStorage.getItem('pokerPartyCoach') !== 'off'; } catch (e) {}

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ---------- cards ----------
  function cardEl(id, opts) {
    opts = opts || {};
    const d = document.createElement('div');
    if (id == null || id < 0) { d.className = 'card back' + (opts.sm ? ' sm' : ''); return d; }
    d.className = 'card ' + (E.isRed(id) ? 'red' : 'black') + (opts.sm ? ' sm' : '');
    const rank = E.RANK_CHAR[E.rankOf(id) - 2];
    const suit = E.SUIT_SYMBOL[E.suitOf(id)];
    d.innerHTML = '<span class="tl">' + rank + '<br>' + suit + '</span><span class="big">' + suit + '</span>';
    return d;
  }
  const cardsText = (cards) => cards.map(E.cardText).join(' ');

  // ---------- views ----------
  function showView(name) {
    ['join', 'lobby', 'table'].forEach((v) => {
      $('view-' + v).style.display = v === name ? '' : 'none';
    });
  }

  // ---------- join ----------
  async function api(pathname, body) {
    const opts = body
      ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.assign({ token }, body)) }
      : undefined;
    const r = await fetch(pathname, opts);
    return r.json();
  }

  // Ask the server whether this table needs a room code (online mode).
  fetch('/api/info').then((r) => r.json()).then((info) => {
    if (info && info.needCode) {
      $('join-code').style.display = '';
      $('join-hint').textContent = 'Type your name and the room code the host gave you.';
    }
  }).catch(() => {});

  async function join() {
    const name = $('join-name').value.trim();
    if (!name) { $('join-error').textContent = 'Enter a name first.'; return; }
    const resp = await api('/api/join', { name, code: $('join-code').value.trim() });
    if (!resp.ok) { $('join-error').textContent = resp.error || 'Could not join.'; return; }
    token = resp.token;
    try { localStorage.setItem(TOKEN_KEY, token); } catch (e) {}
    $('join-error').textContent = '';
    poll();
  }
  $('btn-join').addEventListener('click', join);
  $('join-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); });
  $('join-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); });

  $('btn-start').addEventListener('click', async () => {
    const resp = await api('/api/start', {
      botCount: botCount == null ? undefined : botCount,
      difficulty, smallBlind, startingStack,
    });
    if (!resp.ok) $('start-error').textContent = resp.error || 'Could not start.';
    else poll();
  });
  $('btn-reset').addEventListener('click', async () => {
    if (confirm('Reset the table for EVERYONE back to the lobby?')) { await api('/api/reset', {}); poll(); }
  });
  async function leaveTable() {
    await api('/api/leave', {});
    try { localStorage.removeItem(TOKEN_KEY); } catch (e) {}
    token = null;
    clock.seat = -1;
    showView('join');
  }
  $('btn-leave').addEventListener('click', () => {
    if (confirm('Leave the table? The game continues for everyone else (a bot takes your chips).')) leaveTable();
  });
  // Main Menu: leave the table cleanly (so you don't hold a seat), then go to the menu.
  $('lnk-menu').addEventListener('click', async (e) => {
    e.preventDefault();
    if (token) { try { await api('/api/leave', {}); } catch (err) {} try { localStorage.removeItem(TOKEN_KEY); } catch (err) {} }
    window.location.href = 'index.html';
  });

  // ---------- lobby ----------
  const BOT_ORDER = ['Rosie', 'Tex', 'Doc']; // added in this order as count grows
  const DIFF_DESC = {
    easy: 'Loose and passive — they call too much and rarely bluff. Easiest to beat.',
    medium: 'A balanced mix of styles. A fair challenge while you learn.',
    hard: 'Tight and aggressive — they fold weak hands and punish yours. Toughest.',
  };
  let botCount = null;      // null = not yet initialized (defaults to filling the table)
  let difficulty = 'medium';
  let smallBlind = 5;       // big blind is always 2×
  let startingStack = 1000;

  $('blinds').querySelectorAll('button').forEach((b) =>
    b.addEventListener('click', () => { smallBlind = Number(b.dataset.sb); if (latest) renderLobby(latest); }));
  $('buyin').querySelectorAll('button').forEach((b) =>
    b.addEventListener('click', () => { startingStack = Number(b.dataset.buyin); if (latest) renderLobby(latest); }));

  function renderLobby(resp) {
    showView('lobby');
    const list = $('lobby-players');
    const nHumans = resp.lobby.players.length;
    list.innerHTML = resp.lobby.players.map((p) =>
      '<div class="mp-player">' + p.emoji + ' <b>' + esc(p.name) + '</b>' +
      (p.isHost ? ' <span class="mp-tag">host</span>' : '') +
      (p.connected ? '' : ' <span class="mp-tag off">away</span>') +
      '</div>').join('') +
      '<div class="mp-hint">' + nHumans + ' of ' + resp.lobby.maxSeats + ' seats taken — friends join at this same address.</div>';

    // Bot-count buttons: 0..(free seats). Default to filling the table the first time.
    const maxBots = resp.lobby.maxSeats - nHumans;
    if (botCount === null) botCount = maxBots;
    botCount = Math.min(botCount, maxBots);
    const bc = $('bot-count');
    // Only rebuild the buttons when the range changes (avoids flicker/dropped clicks each poll).
    if (bc.dataset.max !== String(maxBots)) {
      bc.dataset.max = String(maxBots);
      let btns = '';
      for (let i = 0; i <= maxBots; i++) btns += '<button data-bots="' + i + '">' + i + '</button>';
      bc.innerHTML = btns;
      bc.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
        botCount = Number(b.dataset.bots); renderLobby(latest);
      }));
    }
    bc.querySelectorAll('button').forEach((b) => b.classList.toggle('sel', Number(b.dataset.bots) === botCount));
    $('bot-names').textContent = botCount === 0
      ? (nHumans >= 2 ? 'No bots — humans only.' : 'Add at least one bot or wait for another player.')
      : 'Playing: ' + BOT_ORDER.slice(0, botCount).join(', ');

    $('difficulty').querySelectorAll('button').forEach((b) =>
      b.classList.toggle('sel', b.dataset.diff === difficulty));
    $('difficulty-desc').textContent = DIFF_DESC[difficulty];
    $('blinds').querySelectorAll('button').forEach((b) =>
      b.classList.toggle('sel', Number(b.dataset.sb) === smallBlind));
    $('buyin').querySelectorAll('button').forEach((b) =>
      b.classList.toggle('sel', Number(b.dataset.buyin) === startingStack));

    const total = nHumans + botCount;
    $('btn-start').disabled = total < 2;
    $('btn-start').textContent = total < 2 ? 'Need at least 2 players' : 'Start the game ▸';
  }

  $('difficulty').querySelectorAll('button').forEach((b) =>
    b.addEventListener('click', () => { difficulty = b.dataset.diff; if (latest) renderLobby(latest); }));

  // ---------- table ----------
  const LAYOUTS = {
    2: ['seat-you', 'seat-top'],
    3: ['seat-you', 'seat-left', 'seat-right'],
    4: ['seat-you', 'seat-left', 'seat-top', 'seat-right'],
  };
  const DEALER_POS = {
    'seat-you': { left: '38%', top: '69%' }, 'seat-left': { left: '21%', top: '34%' },
    'seat-top': { left: '40%', top: '20%' }, 'seat-right': { left: '76%', top: '34%' },
  };
  const BET_POS = {
    'seat-you': { left: '35%', top: '64%' }, 'seat-left': { left: '26%', top: '46%' },
    'seat-top': { left: '50%', top: '30%' }, 'seat-right': { left: '74%', top: '46%' },
  };

  // Spectators (mySeat < 0) view the table from seat 0's perspective.
  const viewSeat = () => (mySeat < 0 ? 0 : mySeat);
  const seatClass = (seat, n) => LAYOUTS[n][(seat - viewSeat() + n) % n];
  const seatName = (i) => (seatsMeta[i] ? seatsMeta[i].name : '?') + (i === mySeat ? ' (you)' : '');
  const plainName = (i) => seatsMeta[i] ? seatsMeta[i].name : '?';
  function verb(seat, v) { return seat === mySeat ? 'You ' + v.replace(/s( |$)/, '$1') : esc(plainName(seat)) + ' ' + v; }

  function buildSeats(n) {
    const table = $('pokerTable');
    table.querySelectorAll('.seat, .dealer-chip, .bet-chip').forEach((el) => el.remove());
    for (let i = 0; i < n; i++) {
      const d = document.createElement('div');
      d.className = 'seat ' + seatClass(i, n);
      d.id = 'seat-' + i;
      d.innerHTML =
        '<div class="badge" id="badge-' + i + '" style="display:none"></div>' +
        '<div class="pclock" id="pclock-' + i + '" style="display:none"></div>' +
        '<div class="avatar">' + (seatsMeta[i] ? seatsMeta[i].emoji : '🙂') + '</div>' +
        '<div class="nameplate"><div class="nm">' + esc(plainName(i)) + (i === mySeat ? ' ⭐' : '') + '</div><div class="stk" id="stk-' + i + '"></div></div>' +
        '<div class="hole" id="hole-' + i + '"></div>' +
        '<div class="shand" id="shand-' + i + '"></div>';
      table.appendChild(d);
    }
    const chip = document.createElement('div');
    chip.className = 'dealer-chip'; chip.id = 'dealer-chip'; chip.textContent = 'D';
    table.appendChild(chip);
    tableBuilt = n;
    builtView = viewSeat();
  }
  let builtView = -99;
  let builtSig = '';

  // per-hand UI state
  let ui = null;
  function resetUiState() {
    ui = { badges: {}, shand: {}, awards: [], streetName: '', winners: new Set(), snap: null, sbSeat: -1, bbSeat: -1, button: 0 };
  }
  resetUiState();

  function renderTable() {
    const st = ui.snap;
    if (!st) return;
    const n = st.seats.length;
    // Rebuild on seat-count, viewpoint, OR seat-identity change (e.g. a human takes over a bot seat).
    const sig = seatsMeta.map((m) => (m ? m.name + m.emoji : '?')).join('|');
    if (tableBuilt !== n || builtView !== viewSeat() || builtSig !== sig) { builtSig = sig; buildSeats(n); }
    st.seats.forEach((s, i) => {
      const seatEl = $('seat-' + i);
      if (!seatEl) return;
      seatEl.classList.toggle('turn', st.phase === 'betting' && st.actor === i);
      seatEl.classList.toggle('folded', s.folded && !s.out);
      seatEl.classList.toggle('busted', s.out);
      $('stk-' + i).textContent = s.out ? 'BUSTED' : '$' + s.stack + (s.allIn && s.stack === 0 ? ' (all-in)' : '');
      const hole = $('hole-' + i);
      hole.innerHTML = '';
      if (!s.out && s.hole.length && !s.folded) {
        s.hole.forEach((c) => hole.appendChild(cardEl(c)));
      }
      const badge = $('badge-' + i);
      const btext = ui.badges[i];
      badge.style.display = btext ? '' : 'none';
      badge.textContent = btext || '';
      badge.className = 'badge' +
        (btext === 'Fold' ? ' fold' : ui.winners.has(i) ? ' win' : /Bet|Raise|All-in/.test(btext || '') ? ' aggr' : '');
      $('shand-' + i).textContent = ui.shand[i] || '';
    });

    const dp = DEALER_POS[seatClass(st.button, n)];
    const chip = $('dealer-chip');
    chip.style.left = dp.left; chip.style.top = dp.top;

    document.querySelectorAll('.bet-chip').forEach((el) => el.remove());
    st.seats.forEach((s, i) => {
      if (s.bet > 0) {
        const b = document.createElement('div');
        b.className = 'bet-chip';
        const bp = BET_POS[seatClass(i, n)];
        b.style.left = bp.left; b.style.top = bp.top;
        b.style.transform = 'translate(-50%,-50%)';
        b.textContent = s.bet;
        $('pokerTable').appendChild(b);
      }
    });

    const bc = $('board-cards'); bc.innerHTML = '';
    st.board.forEach((c) => bc.appendChild(cardEl(c)));
    $('pot-label').textContent = st.pot > 0 ? 'Pot: $' + st.pot : '';
    $('street-label').textContent = ui.streetName;
    $('hand-num').textContent = 'Hand #' + (st.handNum || '—');
  }

  // ---------- log ----------
  function log(html, cls) {
    const body = $('log-body');
    const line = document.createElement('div');
    if (cls) line.className = cls;
    line.innerHTML = html;
    body.appendChild(line);
    body.scrollTop = body.scrollHeight;
    while (body.children.length > 300) body.removeChild(body.firstChild);
  }

  // ---------- play clock ----------
  const clock = { seat: -1, ms: 0, at: 0, max: 0 };
  function fmtClock(ms) {
    const s = Math.ceil(ms / 1000);
    if (s >= 60) return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
    return String(s);
  }
  function tickClock() {
    const showing = clock.seat >= 0 && !uiBusy && uiQueue.length === 0; // hide mid-animation
    document.querySelectorAll('.pclock').forEach((el) => { el.style.display = 'none'; });
    const abClock = $('ab-clock');
    if (!showing) { if (abClock) abClock.style.display = 'none'; return; }
    const left = Math.max(0, clock.ms - (Date.now() - clock.at));
    const el = $('pclock-' + clock.seat);
    const low = left <= 15000;
    if (el) {
      el.style.display = '';
      el.textContent = '⏱ ' + fmtClock(left);
      el.classList.toggle('low', low);
    }
    if (abClock) {
      if (clock.seat === mySeat) {
        abClock.style.display = '';
        abClock.textContent = '⏱ ' + fmtClock(left) + ' to act';
        abClock.classList.toggle('low', low);
      } else { abClock.style.display = 'none'; }
    }
  }
  setInterval(tickClock, 250);

  // ---------- event pump ----------
  const uiQueue = [];
  let uiBusy = false;
  let pumpGen = 0; // bumped on resync/new-game so stale animation timers abandon

  function flushQueue() { uiQueue.length = 0; uiBusy = false; pumpGen++; }
  function enqueue(evts) { evts.forEach((e) => uiQueue.push(e)); pump(); }

  function pump() {
    if (uiBusy) return;
    const ev = uiQueue.shift();
    if (!ev) { onQueueEmpty(); return; }
    uiBusy = true;
    const delay = handleEvent(ev);
    const gen = pumpGen;
    setTimeout(() => { if (gen !== pumpGen) return; uiBusy = false; pump(); }, delay);
  }

  function handleEvent(ev) {
    if (ev.snap) ui.snap = ev.snap;
    switch (ev.type) {
      case 'hand-start': {
        const snap = ev.snap;
        resetUiState();
        ui.snap = snap;
        ui.sbSeat = ev.sbSeat; ui.bbSeat = ev.bbSeat; ui.button = ev.button;
        hideBanner(); hideActionBar();
        log('<span class="hd">— Hand #' + ev.handNum + ' — button: ' + esc(plainName(ev.button)) + '</span>');
        renderTable();
        return EVT_DELAY;
      }
      case 'blind': {
        ui.badges[ev.seat] = (ev.kind === 'sb' ? 'SB ' : 'BB ') + ev.amount;
        log(verb(ev.seat, 'posts') + ' ' + (ev.kind === 'sb' ? 'small' : 'big') + ' blind $' + ev.amount);
        renderTable();
        return EVT_DELAY * 0.5;
      }
      case 'deal-hole': {
        const you = ev.snap && ev.snap.seats[mySeat];
        if (you && you.hole.length && you.hole[0] >= 0) {
          log('You are dealt <b>' + cardsText(you.hole) + '</b> (' + E.holeLabel(you.hole[0], you.hole[1]) + ')');
        }
        renderTable();
        coachIdle(); // show the Chen score the moment cards land
        return EVT_DELAY;
      }
      case 'turn': { renderTable(); return 0; }
      case 'action': {
        let txt, badge;
        if (ev.action === 'fold') { txt = verb(ev.seat, 'folds'); badge = 'Fold'; }
        else if (ev.action === 'check') { txt = verb(ev.seat, 'checks'); badge = 'Check'; }
        else if (ev.action === 'call') { txt = verb(ev.seat, 'calls') + ' $' + ev.amount; badge = 'Call ' + ev.amount; }
        else if (ev.action === 'bet') { txt = verb(ev.seat, 'bets') + ' $' + ev.amount; badge = 'Bet ' + ev.amount; }
        else { txt = verb(ev.seat, 'raises') + ' to $' + ev.amount; badge = 'Raise ' + ev.amount; }
        if (ev.allIn) { txt += ' — ALL-IN'; badge = 'All-in'; }
        ui.badges[ev.seat] = badge;
        log(txt);
        renderTable();
        return EVT_DELAY;
      }
      case 'street': {
        Object.keys(ui.badges).forEach((k) => {
          if (ui.badges[k] !== 'Fold' && ui.badges[k] !== 'All-in') delete ui.badges[k];
        });
        ui.streetName = ev.name;
        log('<b>' + ev.name + ':</b> ' + cardsText(ev.board));
        renderTable();
        return STREET_DELAY;
      }
      case 'runout': {
        log('All-in — hands face up!');
        renderTable();
        return STREET_DELAY;
      }
      case 'showdown': {
        ev.reveals.forEach((r) => {
          ui.shand[r.seat] = r.name;
          log(verb(r.seat, 'shows') + ' <b>' + cardsText(r.hole) + '</b> — ' + r.name);
        });
        renderTable();
        return STREET_DELAY;
      }
      case 'pot-award': {
        ui.awards.push(ev);
        if (ev.reason === 'returned') {
          log(verb(ev.seat, 'takes') + ' back $' + ev.amount + ' (uncalled bet)');
        } else {
          ui.winners.add(ev.seat);
          ui.badges[ev.seat] = (ev.seat === mySeat ? 'Win $' : 'Wins $') + ev.amount;
          log('<span class="win">' + verb(ev.seat, 'wins') + ' $' + ev.amount +
            (ev.reason === 'fold' ? ' — everyone folded' : (ev.sidePot ? ' (side pot)' : '') +
              (ev.handName ? ' with ' + ev.handName : '')) + '</span>');
        }
        renderTable();
        return EVT_DELAY;
      }
      case 'rebuy': {
        log('<b>' + verb(ev.seat, 'rebuys') + ' for $' + ev.amount + '</b>');
        renderTable();
        return EVT_DELAY * 0.5;
      }
      case 'sit-in': {
        log('<b>' + (ev.seat === mySeat ? 'You sit in' : esc(ev.name) + ' sits in') + ' at the table.</b>');
        renderTable();
        return EVT_DELAY * 0.5;
      }
      case 'left': {
        log('<b>' + esc(ev.name) + ' left the table</b> — a bot is playing their chips.');
        renderTable();
        return EVT_DELAY * 0.5;
      }
      case 'bust': { log('<b>' + esc(ev.name) + ' is out of chips!</b>'); return EVT_DELAY; }
      case 'hand-end': { renderTable(); return EVT_DELAY * 0.5; }
      case 'game-over': { renderTable(); return 0; }
      default: return 0;
    }
  }

  function onQueueEmpty() {
    if (!latest || latest.mode !== 'game') return;
    renderTable();
    // Busted? Offer a rebuy (or leave) — this overrides other banners, just for me.
    const meSnap = ui.snap && mySeat >= 0 ? ui.snap.seats[mySeat] : null;
    const iAmBot = seatsMeta[mySeat] && seatsMeta[mySeat].isBot;
    if (meSnap && !latest.you.spectating && !iAmBot && meSnap.stack <= 0 && !latest.youTurn) {
      hideActionBar();
      showRebuyBanner();
      return;
    }
    if (latest.you.spectating) {
      // Watching until dealt in — no action bar, friendly note in the coach panel.
      hideActionBar();
      if (latest.phase === 'handComplete') showHandEndBanner();
      else { hideBanner(); $('coach-body').innerHTML = '<span class="off">👀 You\'re watching this hand. You\'ll be dealt in when the next hand starts. Anyone can press “Deal next hand” to speed that along, or “Back to lobby” to start fresh.</span>'; }
      return;
    }
    if (latest.youTurn && latest.phase === 'betting') {
      showActionBar(latest);
      updateCoach(latest);
    } else {
      hideActionBar();
      if (latest.phase === 'handComplete') showHandEndBanner();
      else if (latest.phase === 'gameOver') showGameOverBanner();
      else { hideBanner(); coachIdle(); }
    }
  }

  // ---------- action bar ----------
  let acting = false;
  function hideActionBar() { $('action-bar').classList.remove('show'); }

  function showActionBar(resp) {
    const la = resp.legal;
    const bar = $('action-bar');
    const freshTurn = !bar.classList.contains('show');
    bar.classList.add('show');
    $('btn-check').textContent = la.canCheck ? 'Check' : 'Call $' + la.toCall;
    $('tocall-label').textContent = la.canCheck ? '' : '$' + la.toCall + ' to call';
    $('raise-row').style.display = la.canRaise ? '' : 'none';
    $('btn-raise').style.display = la.canRaise ? '' : 'none';
    if (la.canRaise) {
      const slider = $('raiseSlider');
      slider.min = la.minRaiseTo;
      slider.max = la.maxRaiseTo;
      slider.step = 1;
      if (freshTurn || Number(slider.value) < la.minRaiseTo || Number(slider.value) > la.maxRaiseTo) {
        slider.value = la.minRaiseTo;
      }
      syncRaiseLabel();
    }
  }

  function syncRaiseLabel() {
    if (!latest || !latest.legal) return;
    const la = latest.legal;
    let v = Number($('raiseSlider').value);
    v = Math.max(la.minRaiseTo, Math.min(la.maxRaiseTo, v));
    $('raiseAmt').textContent = (v >= la.maxRaiseTo ? 'All-in $' : '$') + v;
    $('btn-raise').textContent = (latest.currentBet === 0 ? 'Bet $' : 'Raise to $') + v;
  }
  $('raiseSlider').addEventListener('input', syncRaiseLabel);

  document.querySelectorAll('.quickbet').forEach((b) => {
    b.addEventListener('click', () => {
      if (!latest || !latest.legal) return;
      const la = latest.legal;
      const pot = latest.pot || 0;
      let v;
      if (b.dataset.qb === 'min') v = la.minRaiseTo;
      else if (b.dataset.qb === 'half') v = (latest.currentBet || 0) + Math.round((pot + la.toCall) / 2);
      else if (b.dataset.qb === 'pot') v = (latest.currentBet || 0) + pot + la.toCall;
      else v = la.maxRaiseTo;
      if (b.dataset.qb !== 'allin') {
        v = Math.round(v / 5) * 5;
        if (la.maxRaiseTo - v < 5) v = la.maxRaiseTo;
      }
      $('raiseSlider').value = Math.max(la.minRaiseTo, Math.min(la.maxRaiseTo, v));
      syncRaiseLabel();
    });
  });

  async function humanAct(action) {
    if (acting || !latest || !latest.youTurn) return;
    acting = true;
    hideActionBar();
    try {
      const resp = await api('/api/act', { action });
      if (!resp.ok && latest && latest.youTurn) showActionBar(latest); // rejected: let them retry
    } finally {
      acting = false;
      poll();
    }
  }
  $('btn-fold').addEventListener('click', () => humanAct({ type: 'fold' }));
  $('btn-check').addEventListener('click', () => {
    if (!latest || !latest.legal) return;
    humanAct(latest.legal.canCheck ? { type: 'check' } : { type: 'call' });
  });
  $('btn-raise').addEventListener('click', () => humanAct({ type: 'raise', amount: Number($('raiseSlider').value) }));

  // ---------- coach ----------
  $('coach-toggle').addEventListener('click', () => {
    coachOn = !coachOn;
    try { localStorage.setItem('pokerPartyCoach', coachOn ? 'on' : 'off'); } catch (e) {}
    $('coach-toggle').textContent = coachOn ? 'hide' : 'show';
    if (!coachOn) $('coach-body').innerHTML = '<span class="off">Coach hidden — click "show" to bring the advice back.</span>';
    else if (latest) updateCoach(latest);
  });

  function positionText(resp) {
    if (ui.button === mySeat) return 'the button (best position — you act last after the flop)';
    if (ui.sbSeat === mySeat) return 'the small blind (out of position all hand)';
    if (ui.bbSeat === mySeat) return 'the big blind';
    return 'the middle — be selective';
  }

  function handTier(hole, chen) {
    const r1 = E.rankOf(hole[0]), r2 = E.rankOf(hole[1]);
    const isAK = (r1 === 14 && r2 === 13) || (r1 === 13 && r2 === 14);
    const isBigPair = r1 === r2 && r1 >= 12;
    if (isAK || isBigPair) return 'Premium';
    if (chen >= 9) return 'Strong';
    if (chen >= 7) return 'Playable';
    if (chen >= 5) return 'Marginal';
    return 'Weak';
  }

  function chenTableHtml(bd) {
    return '<table class="chen">' +
      bd.steps.map((s) => '<tr><td>' + s.label + '</td><td>' + s.value + '</td></tr>').join('') +
      '<tr class="tot"><td>Chen score (AA = 20)</td><td>' + bd.total + '</td></tr></table>';
  }

  // Shown as soon as cards are dealt, before it's your turn: Chen score first.
  function coachIdle() {
    if (!coachOn || !latest || latest.mode !== 'game') return;
    const hole = latest.hole;
    const st = ui.snap;
    if (!hole || hole.length < 2 || !st || st.phase !== 'betting') return;
    const me = st.seats[mySeat];
    if (!me || me.out || me.folded) return;
    let html = '<div class="hand-label">' + E.holeLabel(hole[0], hole[1]) +
      ' <span style="font-weight:400;color:var(--dim)">(' + cardsText(hole) + ')</span></div>';
    if (st.street === 0) {
      const bd = E.chenBreakdown(hole[0], hole[1]);
      html += chenTableHtml(bd);
      html += '<div>Strength: <span class="made">' + handTier(hole, bd.total) + '</span> — you\'re in ' + positionText() + '.</div>';
    } else {
      const made = E.describeMade(hole, st.board);
      html += '<div>You have: <span class="made">' + made.name + '</span></div>';
      const notes = made.notes.concat(E.findDraws(hole, st.board).notes);
      if (notes.length) html += '<ul>' + notes.map((n) => '<li>' + n + '</li>').join('') + '</ul>';
    }
    html += '<div class="off" style="margin-top:8px">Odds and advice appear when it\'s your turn.</div>';
    $('coach-body').innerHTML = html;
  }

  function updateCoach(resp) {
    $('coach-toggle').textContent = coachOn ? 'hide' : 'show';
    if (!coachOn || !resp.youTurn || !resp.hole || resp.hole.length < 2) return;
    const hole = resp.hole;
    const la = resp.legal;
    const board = ui.snap ? ui.snap.board : [];
    const pot = resp.pot || 0;
    const activeOpp = ui.snap ? ui.snap.seats.filter((s, i) => !s.out && !s.folded && i !== mySeat).length : 1;
    let html = '<div class="hand-label">' + E.holeLabel(hole[0], hole[1]) +
      ' <span style="font-weight:400;color:var(--dim)">(' + cardsText(hole) + ')</span></div>';

    if (resp.street === 0) {
      const bd = E.chenBreakdown(hole[0], hole[1]);
      const chen = bd.total;
      const raised = resp.currentBet > resp.bigBlind;
      const tier = handTier(hole, chen);
      let advice;
      if (!raised) {
        if (tier === 'Premium' || chen >= 9) advice = 'Raise to about $' + (resp.bigBlind * 3) + '. Strong hands want to build the pot.';
        else if (chen >= 7) advice = la.canCheck ? 'Checking is fine, or raise to pressure the limpers.' : 'Playable — calling is okay, especially in late position.';
        else if (chen >= 5) advice = la.canCheck ? 'Check and see a free flop.' : 'Marginal — late position call, early position fold.';
        else advice = la.canCheck ? 'Check — free look, but plan to give up on most flops.' : 'Fold. Weak hands lose money even when they hit.';
      } else {
        if (tier === 'Premium') advice = 'Re-raise (about 3× their raise). AA, KK, QQ and AK punish raisers.';
        else if (chen >= 10) advice = 'Calling is reasonable. Re-raising is optional.';
        else if (chen >= 8 && la.toCall <= resp.bigBlind * 3) advice = 'Small raise — calling to see a flop is fine.';
        else advice = 'Fold. Facing a raise, you need a genuinely strong hand — this isn\'t it.';
      }
      html += chenTableHtml(bd);
      html += '<div>Strength: <span class="made">' + tier + '</span> — you\'re in ' + positionText(resp) + '.</div>';
      html += '<div class="advice">' + advice + '</div>';
    } else {
      const made = E.describeMade(hole, board);
      const eq = E.equity(hole, board, activeOpp, 500);
      const eqPct = Math.round(eq.equity * 100);
      html += '<div>You have: <span class="made">' + made.name + '</span></div>';
      const notes = made.notes.slice();
      const draws = E.findDraws(hole, board);
      draws.notes.forEach((n) => notes.push(n));
      if (notes.length) html += '<ul>' + notes.map((n) => '<li>' + n + '</li>').join('') + '</ul>';
      html += '<div style="margin-top:6px">If opponents held <b>random</b> cards, you\'d win about <b>' + eqPct + '%</b> (vs ' + activeOpp + ' opponent' + (activeOpp > 1 ? 's' : '') + ').</div>';
      html += '<div class="eq-bar"><div class="eq-fill" style="width:' + eqPct + '%"></div></div>';
      html += '<div class="eq-nums"><span>0%</span><span>simulated 500 random deals</span><span>100%</span></div>';
      let advice;
      if (la.toCall > 0) {
        const needed = la.toCall / (pot + la.toCall);
        const neededPct = Math.round(needed * 100);
        html += '<div>Pot odds: call $' + la.toCall + ' into $' + pot + ' → you need <b>' + neededPct + '%</b> to break even.</div>';
        if (eq.equity > needed + 0.25 && eq.equity > 0.6) advice = 'Comfortably ahead of the price, even allowing for the bettor holding better than random — raise for value or call.';
        else if (eq.equity > needed + 0.1) advice = 'Ahead of the price vs random hands — but bettors usually have better than random. Fine call vs small bets; tighten up vs big raises.';
        else if (eq.equity > needed - 0.03) advice = 'Borderline at best — and bettors are rarely random. Folding is usually right.';
        else advice = 'Fold. You need ' + neededPct + '% but have only ~' + eqPct + '% even against random hands.';
        advice += '<div style="margin-top:6px;color:var(--dim);font-size:12px">⚠ The % assumes random opponent cards — a real bettor is usually stronger.</div>';
      } else {
        if (eq.equity > 0.62) advice = 'Big favorite — bet about ⅔ pot ($' + Math.round(pot * 0.66) + ') for value.';
        else if (eq.equity > 0.45) advice = 'Decent but not dominant. Checking is fine; a modest bet also works.';
        else if (draws.outs.length >= 8) advice = 'Weak made hand but a live draw — check, or semi-bluff.';
        else advice = 'Weak hand. Check, and fold to big bets.';
      }
      html += '<div class="advice">' + advice + '</div>';
    }
    $('coach-body').innerHTML = html;
  }

  // ---------- banners ----------
  function hideBanner() { $('banner').classList.remove('show'); }

  function showHandEndBanner() {
    const realWins = ui.awards.filter((a) => a.reason !== 'returned');
    const bySeat = new Map();
    realWins.forEach((a) => bySeat.set(a.seat, (bySeat.get(a.seat) || 0) + a.amount));
    const handNameOf = (seat) => {
      const a = realWins.find((x) => x.seat === seat && x.handName);
      return a ? a.handName : null;
    };
    let title, sub;
    if (bySeat.size === 0) { title = 'Hand over'; sub = ''; }
    else if (bySeat.size === 1) {
      const seat = bySeat.keys().next().value;
      const amt = bySeat.get(seat);
      title = seat === mySeat ? '🎉 You win $' + amt + '!' : esc(plainName(seat)) + ' wins $' + amt;
      sub = handNameOf(seat) ? 'Winning hand: ' + handNameOf(seat) : 'Everyone else folded.';
    } else {
      const youWon = bySeat.get(mySeat) || 0;
      title = youWon > 0 ? '🎉 Split pot — you win $' + youWon : 'The pot is split';
      sub = Array.from(bySeat.entries()).map(([seat, amt]) =>
        esc(plainName(seat)) + ' $' + amt + (handNameOf(seat) ? ' (' + handNameOf(seat) + ')' : '')
      ).join(' &nbsp;·&nbsp; ');
    }
    $('banner-title').textContent = title;
    $('banner-sub').innerHTML = sub;
    $('banner-btn2').style.display = 'none';
    const btn = $('banner-btn');
    btn.style.display = '';
    btn.disabled = false; // never leave it stuck from a failed previous click
    btn.textContent = 'Deal next hand ▸';
    btn.onclick = async () => {
      btn.disabled = true;
      try { await api('/api/next', {}); } finally { btn.disabled = false; poll(); }
    };
    $('banner').classList.add('show');
  }

  function showRebuyBanner() {
    const amt = latest.startingStack || 1000;
    $('banner-title').textContent = '💸 You\'re out of chips!';
    $('banner-sub').innerHTML = 'Buy back in for <b>$' + amt + '</b> to keep playing — the game goes on without you until you do.';
    const btn = $('banner-btn');
    btn.style.display = '';
    btn.disabled = false;
    btn.textContent = 'Rebuy $' + amt + ' ▸';
    btn.onclick = async () => { btn.disabled = true; try { await api('/api/rebuy', {}); } finally { btn.disabled = false; poll(); } };
    const btn2 = $('banner-btn2');
    btn2.style.display = '';
    btn2.disabled = false;
    btn2.textContent = '🚪 Leave table';
    btn2.onclick = () => leaveTable();
    $('banner').classList.add('show');
  }

  function showGameOverBanner() {
    $('banner-title').textContent = 'Game over';
    $('banner-sub').textContent = 'Anyone can take the table back to the lobby to play again.';
    $('banner-btn2').style.display = 'none';
    const btn = $('banner-btn');
    btn.style.display = '';
    btn.disabled = false;
    btn.textContent = '↩ Back to lobby';
    btn.onclick = async () => { btn.disabled = true; try { await api('/api/reset', {}); } finally { btn.disabled = false; poll(); } };
    $('banner').classList.add('show');
  }

  // ---------- polling ----------
  let pollTimer = null;
  let polling = false;

  let curGen = -1;

  async function poll() {
    if (polling) return;
    polling = true;
    try {
      if (!token) { showView('join'); return; }
      const r = await fetch('/api/state?token=' + encodeURIComponent(token) + '&since=' + lastSeq + '&gen=' + curGen);
      const resp = await r.json();
      if (!resp.ok) {
        token = null;
        try { localStorage.removeItem(TOKEN_KEY); } catch (e) {}
        showView('join');
        return;
      }
      if (resp.left) { // we left (or were removed) — go back to the join screen
        token = null;
        try { localStorage.removeItem(TOKEN_KEY); } catch (e) {}
        clock.seat = -1;
        showView('join');
        return;
      }
      latest = resp;
      if (resp.mode === 'lobby') {
        lastSeq = 0;
        curGen = resp.gen;
        seatsMeta = [];
        tableBuilt = 0;
        clock.seat = -1;
        flushQueue();         // drop any leftover animation from the finished game
        resetUiState();
        renderLobby(resp);
        return;
      }
      // game mode
      showView('table');
      mySeat = resp.you.seat;
      seatsMeta = resp.seatsMeta;
      // Snapshot the play clock: server tells us who's acting and how long they have.
      if (resp.actorSeat != null && resp.actorMsLeft != null) {
        clock.seat = resp.actorSeat; clock.ms = resp.actorMsLeft; clock.at = Date.now(); clock.max = resp.turnMaxMs || 0;
      } else {
        clock.seat = -1;
      }
      $('btn-reset').style.display = '';
      $('mp-status').textContent = 'You are ' + resp.you.name +
        (resp.you.spectating ? ' · watching' : (resp.difficulty ? ' · Bots: ' + resp.difficulty : ''));
      if (resp.smallBlind) $('blinds-label').textContent = resp.smallBlind + ' / ' + resp.bigBlind;
      const newGame = resp.gen !== curGen;
      if (resp.resync || newGame || (lastSeq === 0 && resp.events.length === 0)) {
        // fresh join / new game / trimmed history / big backlog: adopt state directly
        flushQueue();
        resetUiState();
        ui.snap = resp.state;
        lastSeq = resp.serverSeq;
        curGen = resp.gen;
        renderTable();
        onQueueEmpty();
      } else if (resp.events.length) {
        lastSeq = resp.events[resp.events.length - 1].seq;
        enqueue(resp.events);
      } else if (!uiBusy && uiQueue.length === 0) {
        onQueueEmpty();
      }
    } catch (e) {
      $('mp-status').textContent = 'Reconnecting…';
    } finally {
      polling = false;
      clearTimeout(pollTimer);
      pollTimer = setTimeout(poll, POLL_MS);
    }
  }

  poll();
})();
