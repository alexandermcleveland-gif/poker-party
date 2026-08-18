/* app.js — UI for the Poker Trainer: tabs, learn-page cards, quiz modes, play table + coach. */
(function () {
  'use strict';
  const E = window.PokerEngine;
  const $ = (id) => document.getElementById(id);

  // ============ shared: card DOM ============
  const R = { 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8, 9: 9, T: 10, J: 11, Q: 12, K: 13, A: 14 };
  const S = { s: 0, h: 1, d: 2, c: 3 };
  function parseCard(str) { return E.makeCard(R[str[0]], S[str[1]]); }

  function cardEl(id, opts) {
    opts = opts || {};
    const d = document.createElement('div');
    if (id == null) { d.className = 'card back' + (opts.sm ? ' sm' : ''); return d; }
    d.className = 'card ' + (E.isRed(id) ? 'red' : 'black') + (opts.sm ? ' sm' : '');
    d.dataset.card = id;
    const rank = E.RANK_CHAR[E.rankOf(id) - 2];
    const suit = E.SUIT_SYMBOL[E.suitOf(id)];
    d.innerHTML = '<span class="tl">' + rank + '<br>' + suit + '</span><span class="big">' + suit + '</span>';
    return d;
  }

  // Render all data-cards spans in the Learn tab (data-sm="1" → small cards)
  document.querySelectorAll('[data-cards]').forEach((el) => {
    const sm = el.dataset.sm === '1';
    el.dataset.cards.trim().split(/\s+/).forEach((cs) => el.appendChild(cardEl(parseCard(cs), { sm })));
  });

  // ============ tabs ============
  function activateTab(name) {
    document.querySelectorAll('nav button').forEach((x) => x.classList.toggle('active', x.dataset.tab === name));
    document.querySelectorAll('section.tab').forEach((s) => s.classList.toggle('active', s.id === 'tab-' + name));
  }
  document.querySelectorAll('nav button').forEach((b) => {
    b.addEventListener('click', () => activateTab(b.dataset.tab));
  });
  // Open the tab named in the URL (e.g. Poker Trainer.html#play from the main menu).
  const hashTab = (location.hash || '').replace('#', '');
  if (['learn', 'quiz', 'play'].includes(hashTab)) activateTab(hashTab);

  // ============ QUIZ ============
  const CATS_DESC = [8, 7, 6, 5, 4, 3, 2, 1, 0]; // strongest first
  let quizMode = 'name';
  let quiz = null; // current question
  const stats = loadStats();

  function loadStats() {
    try {
      const s = JSON.parse(localStorage.getItem('pokerTrainerStats') || '{}');
      return { best: s.best || 0, right: 0, total: 0, streak: 0 };
    } catch (e) { return { best: 0, right: 0, total: 0, streak: 0 }; }
  }
  function saveStats() {
    try { localStorage.setItem('pokerTrainerStats', JSON.stringify({ best: stats.best })); } catch (e) {}
  }
  function updateScorebox() {
    $('qz-session').textContent = stats.right + '/' + stats.total;
    $('qz-streak').textContent = stats.streak;
    $('qz-best').textContent = stats.best;
  }
  function recordAnswer(correct) {
    stats.total++;
    if (correct) { stats.right++; stats.streak++; if (stats.streak > stats.best) { stats.best = stats.streak; saveStats(); } }
    else stats.streak = 0;
    updateScorebox();
  }

  function randInt(n) { return Math.floor(Math.random() * n); }
  function dealRandom(n, exclude) {
    const used = new Set(exclude || []);
    const out = [];
    while (out.length < n) {
      const c = randInt(52);
      if (!used.has(c)) { used.add(c); out.push(c); }
    }
    return out;
  }

  // Build 7 cards whose best hand is the target category.
  function genTargetHand(cat) {
    for (let attempt = 0; attempt < 400; attempt++) {
      let cards = null;
      if (cat >= 4) {
        // recipe-based for the rarer hands
        if (cat === 8) {
          const s = randInt(4), low = 1 + randInt(10);
          const ranks = low === 1 ? [14, 2, 3, 4, 5] : [low, low + 1, low + 2, low + 3, low + 4];
          cards = ranks.map((r) => E.makeCard(r, s));
        } else if (cat === 7) {
          const r = 2 + randInt(13);
          cards = [0, 1, 2, 3].map((s) => E.makeCard(r, s));
        } else if (cat === 6) {
          let a = 2 + randInt(13), b = 2 + randInt(13);
          while (b === a) b = 2 + randInt(13);
          const su = E.shuffle([0, 1, 2, 3]);
          cards = [E.makeCard(a, su[0]), E.makeCard(a, su[1]), E.makeCard(a, su[2]),
            E.makeCard(b, su[0]), E.makeCard(b, su[1])];
        } else if (cat === 5) {
          const s = randInt(4);
          const ranks = E.shuffle([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]).slice(0, 5);
          cards = ranks.map((r) => E.makeCard(r, s));
        } else { // straight
          const low = 1 + randInt(10);
          const ranks = low === 1 ? [14, 2, 3, 4, 5] : [low, low + 1, low + 2, low + 3, low + 4];
          cards = ranks.map((r) => E.makeCard(r, randInt(4)));
          if (new Set(cards.map(E.suitOf)).size === 1) continue; // accidentally a straight flush
        }
        if (new Set(cards).size !== cards.length) continue;
        cards = cards.concat(dealRandom(2, cards));
      } else {
        cards = dealRandom(7);
      }
      if (E.categoryOf(E.bestScore(cards)) === cat) return cards;
    }
    return dealRandom(7); // fallback: whatever it is, question adapts
  }

  function newNameQuestion() {
    let cards;
    if (Math.random() < 0.72) {
      const cat = CATS_DESC[randInt(CATS_DESC.length)];
      cards = genTargetHand(cat);
    } else {
      cards = dealRandom(7);
    }
    const best = E.bestHand(cards);
    quiz = { kind: 'name', cards, best, answered: false };

    $('qz-question').textContent = 'These are your 2 cards plus the 5 community cards. What is the best 5-card hand you can make?';
    const zone = $('qz-cards'); zone.innerHTML = '';
    zone.appendChild(quizGroup('Your cards', cards.slice(0, 2)));
    zone.appendChild(quizGroup('Community cards', cards.slice(2)));

    const ans = $('qz-answers'); ans.innerHTML = '';
    CATS_DESC.forEach((cat) => {
      const b = document.createElement('button');
      b.textContent = E.CAT_NAME[cat];
      b.addEventListener('click', () => answerName(cat, b));
      ans.appendChild(b);
    });
    $('qz-feedback').innerHTML = '';
    $('qz-next').style.display = 'none';
  }

  function quizGroup(label, cards) {
    const g = document.createElement('div');
    g.className = 'quiz-group';
    const l = document.createElement('div'); l.className = 'lbl'; l.textContent = label;
    const row = document.createElement('div'); row.className = 'cards-row';
    cards.forEach((c) => row.appendChild(cardEl(c)));
    g.appendChild(l); g.appendChild(row);
    return g;
  }

  function highlightBest(container, best5) {
    const set = new Set(best5);
    container.querySelectorAll('.card').forEach((el) => {
      const id = Number(el.dataset.card);
      if (set.has(id)) el.classList.add('hl'); else el.classList.add('dim');
    });
  }

  function answerName(cat, btn) {
    if (quiz.answered) return;
    quiz.answered = true;
    const actual = E.categoryOf(quiz.best.score);
    const correct = cat === actual;
    recordAnswer(correct);
    $('qz-answers').querySelectorAll('button').forEach((b) => {
      b.disabled = true;
      if (b.textContent === E.CAT_NAME[actual]) b.classList.add('correct');
    });
    if (!correct) btn.classList.add('wrong');
    highlightBest($('qz-cards'), quiz.best.cards);
    $('qz-feedback').innerHTML = (correct
      ? '<span class="good">✓ Correct!</span> '
      : '<span class="bad">✗ Not quite.</span> ')
      + 'The best hand here is <b>' + E.handName(quiz.best.score) + '</b> — the five highlighted cards.';
    $('qz-next').style.display = 'inline-block';
  }

  function newWinsQuestion() {
    const deck = E.shuffle(E.newDeck());
    const a = [deck[0], deck[1]], b = [deck[2], deck[3]], board = deck.slice(4, 9);
    const sa = E.bestHand(a.concat(board)), sb = E.bestHand(b.concat(board));
    quiz = { kind: 'wins', a, b, board, sa, sb, answered: false };

    $('qz-question').textContent = 'Both players go to showdown. Who wins the pot?';
    const zone = $('qz-cards'); zone.innerHTML = '';
    zone.appendChild(quizGroup('Player A', a));
    zone.appendChild(quizGroup('Community cards', board));
    zone.appendChild(quizGroup('Player B', b));

    const ans = $('qz-answers'); ans.innerHTML = '';
    [['A', 'Player A wins'], ['B', 'Player B wins'], ['T', "Split pot — it's a tie"]].forEach(([key, label]) => {
      const btn = document.createElement('button');
      btn.textContent = label;
      btn.addEventListener('click', () => answerWins(key, btn));
      ans.appendChild(btn);
    });
    $('qz-feedback').innerHTML = '';
    $('qz-next').style.display = 'none';
  }

  function answerWins(key, btn) {
    if (quiz.answered) return;
    quiz.answered = true;
    const truth = quiz.sa.score > quiz.sb.score ? 'A' : quiz.sa.score < quiz.sb.score ? 'B' : 'T';
    const correct = key === truth;
    recordAnswer(correct);
    const labels = { A: 'Player A wins', B: 'Player B wins', T: "Split pot — it's a tie" };
    $('qz-answers').querySelectorAll('button').forEach((b) => {
      b.disabled = true;
      if (b.textContent === labels[truth]) b.classList.add('correct');
    });
    if (!correct) btn.classList.add('wrong');
    const winner = truth === 'A' ? quiz.sa : quiz.sb;
    if (truth !== 'T') highlightBest($('qz-cards'), winner.cards);
    $('qz-feedback').innerHTML = (correct
      ? '<span class="good">✓ Correct!</span><br>'
      : '<span class="bad">✗ Not quite.</span><br>')
      + 'Player A: <b>' + E.handName(quiz.sa.score) + '</b> &nbsp;·&nbsp; Player B: <b>' + E.handName(quiz.sb.score) + '</b>'
      + (truth === 'T' ? '<br>Identical five-card hands — the pot is split.' : '');
    $('qz-next').style.display = 'inline-block';
  }

  function newQuestion() { quizMode === 'name' ? newNameQuestion() : newWinsQuestion(); }
  $('qz-next').addEventListener('click', newQuestion);
  $('mode-name').addEventListener('click', () => {
    quizMode = 'name';
    $('mode-name').classList.add('active'); $('mode-wins').classList.remove('active');
    newQuestion();
  });
  $('mode-wins').addEventListener('click', () => {
    quizMode = 'wins';
    $('mode-wins').classList.add('active'); $('mode-name').classList.remove('active');
    newQuestion();
  });
  updateScorebox();
  newNameQuestion();

  // ============ PLAY ============
  // Seat positions adapt to the number of players (2 = heads-up, 3, or 4).
  const LAYOUTS = {
    1: ['seat-you'],
    2: ['seat-you', 'seat-top'],
    3: ['seat-you', 'seat-left', 'seat-right'],
    4: ['seat-you', 'seat-left', 'seat-top', 'seat-right'],
  };
  const seatClass = (i, n) => (LAYOUTS[n] || LAYOUTS[4])[i];
  const DEALER_POS = {
    'seat-you': { left: '38%', top: '69%' }, 'seat-left': { left: '21%', top: '34%' },
    'seat-top': { left: '40%', top: '20%' }, 'seat-right': { left: '76%', top: '34%' },
  };
  const BET_POS = {
    'seat-you': { left: '35%', top: '64%' }, 'seat-left': { left: '26%', top: '46%' },
    'seat-top': { left: '50%', top: '30%' }, 'seat-right': { left: '74%', top: '46%' },
  };
  const SPEEDS = {
    fast: { evt: 220, street: 450, bot: 380 },
    normal: { evt: 480, street: 850, bot: 950 },
    slow: { evt: 800, street: 1300, bot: 1700 },
  };

  // Difficulty presets + per-bot flavor (matches the multiplayer server so the
  // bots feel the same in both modes).
  const DIFFICULTIES = {
    easy: { base: { tight: 0.15, aggr: 0.20, bluff: 0.05 } },
    medium: { base: { tight: 0.50, aggr: 0.55, bluff: 0.20 } },
    hard: { base: { tight: 0.72, aggr: 0.80, bluff: 0.38 } },
  };
  const BOT_FLAVOR = [
    { name: 'Rosie', emoji: '🦊', d: { tight: -0.18, aggr: 0.12, bluff: 0.10 } },
    { name: 'Tex', emoji: '🤠', d: { tight: 0, aggr: 0, bluff: 0 } },
    { name: 'Doc', emoji: '🦉', d: { tight: 0.14, aggr: -0.15, bluff: -0.05 } },
  ];
  const DIFF_DESC = {
    easy: 'Loose and passive — call too much, rarely bluff. Easiest to beat.',
    medium: 'A balanced mix of styles. A fair challenge while you learn.',
    hard: 'Tight and aggressive — fold weak hands and punish yours. Toughest.',
  };
  const clamp01 = (x) => Math.max(0.02, Math.min(0.98, x));
  function botPersonality(flavor, diffKey) {
    const base = (DIFFICULTIES[diffKey] || DIFFICULTIES.medium).base;
    return {
      tight: clamp01(base.tight + flavor.d.tight),
      aggr: clamp01(base.aggr + flavor.d.aggr),
      bluff: clamp01(base.bluff + flavor.d.bluff),
    };
  }

  // Game setup (chosen on the setup screen)
  const setup = { bots: 3, difficulty: 'medium', smallBlind: 5, startingStack: 1000, speed: 'normal' };

  function buildPlayers() {
    const players = [{ name: 'You', isBot: false, emoji: '🙂' }];
    for (let i = 0; i < setup.bots; i++) {
      const f = BOT_FLAVOR[i % BOT_FLAVOR.length];
      players.push({ name: f.name, isBot: true, emoji: f.emoji, personality: botPersonality(f, setup.difficulty) });
    }
    return players;
  }

  let game = null;
  let ui = null; // per-hand UI state
  const uiQueue = [];
  let uiBusy = false;
  let botTimer = null;
  let coachOn = true;
  try { coachOn = localStorage.getItem('pokerTrainerCoach') !== 'off'; } catch (e) {}

  function speedCfg() { return SPEEDS[setup.speed] || SPEEDS.normal; }

  function resetUiState() {
    ui = { badges: {}, reveals: {}, shand: {}, awards: [], streetName: '', winners: new Set() };
  }

  function buildSeats() {
    const table = $('pokerTable');
    table.querySelectorAll('.seat, .dealer-chip, .bet-chip').forEach((el) => el.remove());
    const n = game.seats.length;
    game.seats.forEach((s, i) => {
      const d = document.createElement('div');
      d.className = 'seat ' + seatClass(i, n);
      d.id = 'seat-' + i;
      d.innerHTML =
        '<div class="badge" id="badge-' + i + '" style="display:none"></div>' +
        '<div class="avatar">' + s.emoji + '</div>' +
        '<div class="nameplate"><div class="nm">' + s.name + '</div><div class="stk" id="stk-' + i + '"></div></div>' +
        '<div class="hole" id="hole-' + i + '"></div>' +
        '<div class="shand" id="shand-' + i + '"></div>';
      table.appendChild(d);
    });
    const chip = document.createElement('div');
    chip.className = 'dealer-chip'; chip.id = 'dealer-chip'; chip.textContent = 'D';
    table.appendChild(chip);
  }

  // Render from the event snapshot (ui.snap) so paced replay never leaks the
  // engine's already-computed future state; fall back to live state if none.
  function liveSnap() {
    return {
      board: game.board.slice(), pot: game.totalPot(), street: game.street,
      actor: game.actor, phase: game.phase, handNum: game.handNum, button: game.button,
      seats: game.seats.map((s) => ({
        stack: s.stack, bet: s.bet, folded: s.folded, allIn: s.allIn, out: s.out, hole: s.hole.slice(),
      })),
    };
  }

  function renderTable() {
    if (!game) return;
    const st = ui.snap || liveSnap();
    st.seats.forEach((s, i) => {
      const seatEl = $('seat-' + i);
      seatEl.classList.toggle('turn', st.phase === 'betting' && st.actor === i);
      seatEl.classList.toggle('folded', s.folded && !s.out);
      seatEl.classList.toggle('busted', s.out);
      $('stk-' + i).textContent = s.out ? 'BUSTED' : '$' + s.stack + (s.allIn && s.stack === 0 ? ' (all-in)' : '');

      const hole = $('hole-' + i);
      hole.innerHTML = '';
      if (!s.out && s.hole.length && !s.folded) {
        const faceUp = i === 0 || ui.reveals[i];
        s.hole.forEach((c) => hole.appendChild(cardEl(faceUp ? c : null)));
      }
      const badge = $('badge-' + i);
      const btext = ui.badges[i];
      badge.style.display = btext ? '' : 'none';
      badge.textContent = btext || '';
      badge.className = 'badge' +
        (btext === 'Fold' ? ' fold' : ui.winners.has(i) ? ' win' : /Bet|Raise|All-in/.test(btext || '') ? ' aggr' : '');
      $('shand-' + i).textContent = ui.shand[i] || '';
    });

    // dealer chip
    const nSeats = st.seats.length;
    const dp = DEALER_POS[seatClass(st.button, nSeats)];
    const chip = $('dealer-chip');
    chip.style.left = dp.left; chip.style.top = dp.top;

    // bet chips
    document.querySelectorAll('.bet-chip').forEach((el) => el.remove());
    st.seats.forEach((s, i) => {
      if (s.bet > 0) {
        const b = document.createElement('div');
        b.className = 'bet-chip';
        const bp = BET_POS[seatClass(i, nSeats)];
        b.style.left = bp.left; b.style.top = bp.top;
        b.style.transform = 'translate(-50%,-50%)';
        b.textContent = s.bet;
        $('pokerTable').appendChild(b);
      }
    });

    // board + pot
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
  }
  function cardsText(cards) { return cards.map(E.cardText).join(' '); }
  function seatName(i) { return game.seats[i].name; }
  // "Doc calls" but "You call" — drop the -s for the human player
  function verb(seat, v) { return seat === 0 ? v.replace(/s( |$)/, '$1') : v; }

  // ---------- event pump ----------
  function enqueue(evts) { evts.forEach((e) => uiQueue.push(e)); pump(); }

  let pumpGen = 0; // bumped on New Game so stale pump timers die instead of double-pumping

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
    const cfg = speedCfg();
    if (ev.snap) ui.snap = ev.snap;
    switch (ev.type) {
      case 'hand-start': {
        resetUiState();
        ui.snap = ev.snap;
        ui.sbSeat = ev.sbSeat; ui.bbSeat = ev.bbSeat;
        hideBanner(); hideActionBar();
        log('<span class="hd">— Hand #' + ev.handNum + ' — button: ' + seatName(ev.button) + '</span>');
        renderTable();
        return cfg.evt;
      }
      case 'blind': {
        ui.badges[ev.seat] = (ev.kind === 'sb' ? 'SB ' : 'BB ') + ev.amount;
        log(seatName(ev.seat) + ' ' + verb(ev.seat, 'posts') + ' ' + (ev.kind === 'sb' ? 'small' : 'big') + ' blind $' + ev.amount);
        renderTable();
        return cfg.evt * 0.5;
      }
      case 'deal-hole': {
        const you = ev.snap ? ev.snap.seats[0] : game.seats[0];
        if (!you.out && you.hole.length) log('You are dealt <b>' + cardsText(you.hole) + '</b> (' + E.holeLabel(you.hole[0], you.hole[1]) + ')');
        renderTable();
        coachIdle(); // show the Chen score the moment cards land
        return cfg.evt;
      }
      case 'turn': { renderTable(); return 0; }
      case 'action': {
        const nm = seatName(ev.seat);
        const vb = (v) => verb(ev.seat, v);
        let txt, badge;
        if (ev.action === 'fold') { txt = nm + ' ' + vb('folds'); badge = 'Fold'; }
        else if (ev.action === 'check') { txt = nm + ' ' + vb('checks'); badge = 'Check'; }
        else if (ev.action === 'call') { txt = nm + ' ' + vb('calls') + ' $' + ev.amount; badge = 'Call ' + ev.amount; }
        else if (ev.action === 'bet') { txt = nm + ' ' + vb('bets') + ' $' + ev.amount; badge = 'Bet ' + ev.amount; }
        else { txt = nm + ' ' + vb('raises') + ' to $' + ev.amount; badge = 'Raise ' + ev.amount; }
        if (ev.allIn) { txt += ' — ALL-IN'; badge = 'All-in'; }
        ui.badges[ev.seat] = badge;
        log(txt);
        renderTable();
        return cfg.evt;
      }
      case 'street': {
        // keep only fold/all-in badges between streets
        Object.keys(ui.badges).forEach((k) => {
          if (ui.badges[k] !== 'Fold' && ui.badges[k] !== 'All-in') delete ui.badges[k];
        });
        ui.streetName = ev.name;
        log('<b>' + ev.name + ':</b> ' + cardsText(ev.board));
        renderTable();
        return cfg.street;
      }
      case 'runout': {
        ev.reveals.forEach((r) => { ui.reveals[r.seat] = true; });
        log('All-in — hands face up!');
        renderTable();
        return cfg.street;
      }
      case 'showdown': {
        ev.reveals.forEach((r) => {
          ui.reveals[r.seat] = true;
          ui.shand[r.seat] = r.name;
          log(seatName(r.seat) + ' ' + verb(r.seat, 'shows') + ' <b>' + cardsText(r.hole) + '</b> — ' + r.name);
        });
        renderTable();
        return cfg.street;
      }
      case 'pot-award': {
        ui.awards.push(ev);
        if (ev.reason === 'returned') {
          log(seatName(ev.seat) + ' ' + verb(ev.seat, 'takes') + ' back $' + ev.amount + ' (uncalled bet)');
        } else {
          ui.winners.add(ev.seat);
          ui.badges[ev.seat] = (ev.seat === 0 ? 'Win $' : 'Wins $') + ev.amount;
          log('<span class="win">' + seatName(ev.seat) + ' ' + verb(ev.seat, 'wins') + ' $' + ev.amount +
            (ev.reason === 'fold' ? ' — everyone folded' : (ev.sidePot ? ' (side pot)' : '') +
              (ev.handName ? ' with ' + ev.handName : '')) + '</span>');
        }
        renderTable();
        return cfg.evt;
      }
      case 'bust': { log('<b>' + ev.name + ' is out of chips!</b>'); return cfg.evt; }
      case 'hand-end': { renderTable(); return cfg.evt * 0.5; }
      case 'game-over': { renderTable(); return 0; }
      default: return 0;
    }
  }

  function onQueueEmpty() {
    if (!game) return;
    renderTable();
    if (game.phase === 'betting' && game.actor != null) {
      const actor = game.seats[game.actor];
      if (actor.isBot) {
        hideActionBar();
        coachIdle();
        if (!botTimer) {
          botTimer = setTimeout(() => {
            botTimer = null;
            botTurn();
          }, speedCfg().bot);
        }
      } else {
        showActionBar();
        updateCoach();
      }
    } else if (game.phase === 'handComplete') {
      hideActionBar();
      showHandEndBanner();
    } else if (game.phase === 'gameOver') {
      hideActionBar();
      showGameOverBanner();
    }
  }

  function botTurn() {
    if (!game || game.phase !== 'betting' || game.actor == null) return;
    const seat = game.actor;
    if (!game.seats[seat].isBot) return;
    const decision = E.botDecide(game, seat);
    if (!game.act(seat, decision)) {
      const la = game.legalActions(seat);
      game.act(seat, la.canCheck ? { type: 'check' } : (la.toCall > 0 && decision.type !== 'fold' ? { type: 'call' } : { type: 'fold' }));
    }
    enqueue(game.drainEvents());
  }

  // ---------- action bar ----------
  function hideActionBar() { $('action-bar').classList.remove('show'); }

  function showActionBar() {
    const la = game.legalActions(0);
    const bar = $('action-bar');
    bar.classList.add('show');
    $('btn-check').textContent = la.canCheck ? 'Check' : 'Call $' + la.toCall;
    $('tocall-label').textContent = la.canCheck ? '' :
      (la.toCall >= game.seats[0].stack ? 'Calling puts you all-in' : '$' + la.toCall + ' to call');
    $('raise-row').style.display = la.canRaise ? '' : 'none';
    $('btn-raise').style.display = la.canRaise ? '' : 'none';
    if (la.canRaise) {
      const slider = $('raiseSlider');
      slider.min = la.minRaiseTo;
      slider.max = la.maxRaiseTo;
      slider.step = 1; // step=5 would make off-grid all-in amounts unreachable
      slider.value = la.minRaiseTo;
      syncRaiseLabel();
    }
  }

  function syncRaiseLabel() {
    const la = game.legalActions(0);
    let v = Number($('raiseSlider').value);
    v = Math.max(la.minRaiseTo, Math.min(la.maxRaiseTo, v));
    const allIn = v >= la.maxRaiseTo;
    $('raiseAmt').textContent = (allIn ? 'All-in $' : '$') + v;
    $('btn-raise').textContent = (game.currentBet === 0 ? 'Bet $' : 'Raise to $') + v;
  }
  $('raiseSlider').addEventListener('input', syncRaiseLabel);

  document.querySelectorAll('.quickbet').forEach((b) => {
    b.addEventListener('click', () => {
      const la = game.legalActions(0);
      const pot = game.totalPot();
      let v;
      if (b.dataset.qb === 'min') v = la.minRaiseTo;
      else if (b.dataset.qb === 'half') v = game.currentBet + Math.round((pot + la.toCall) / 2);
      else if (b.dataset.qb === 'pot') v = game.currentBet + pot + la.toCall;
      else v = la.maxRaiseTo; // all-in: never round — commit the exact stack
      if (b.dataset.qb !== 'allin') {
        v = Math.round(v / 5) * 5;
        if (la.maxRaiseTo - v < 5) v = la.maxRaiseTo; // snap to true all-in when close
      }
      $('raiseSlider').value = Math.max(la.minRaiseTo, Math.min(la.maxRaiseTo, v));
      syncRaiseLabel();
    });
  });

  function humanAct(action) {
    if (!game || game.phase !== 'betting' || game.actor !== 0) return;
    if (game.act(0, action)) {
      hideActionBar();
      enqueue(game.drainEvents());
    }
  }
  $('btn-fold').addEventListener('click', () => humanAct({ type: 'fold' }));
  $('btn-check').addEventListener('click', () => {
    const la = game.legalActions(0);
    humanAct(la.canCheck ? { type: 'check' } : { type: 'call' });
  });
  $('btn-raise').addEventListener('click', () => humanAct({ type: 'raise', amount: Number($('raiseSlider').value) }));

  // ---------- coach ----------
  $('coach-toggle').addEventListener('click', () => {
    coachOn = !coachOn;
    try { localStorage.setItem('pokerTrainerCoach', coachOn ? 'on' : 'off'); } catch (e) {}
    $('coach-toggle').textContent = coachOn ? 'hide' : 'show';
    if (!coachOn) $('coach-body').innerHTML = '<span class="off">Coach hidden — click "show" to bring the advice back.</span>';
    else updateCoach();
  });

  function positionText() {
    if (game.button === 0) return 'the button (best position — you act last after the flop)';
    if (ui.sbSeat === 0) return 'the small blind (out of position all hand)';
    if (ui.bbSeat === 0) return 'the big blind';
    return game.positionFactor(0) > 0.5 ? 'late position (good)' : 'early position (be selective)';
  }

  function handTier(hole, chen) {
    const r1 = E.rankOf(hole[0]), r2 = E.rankOf(hole[1]);
    const isAK = (r1 === 14 && r2 === 13) || (r1 === 13 && r2 === 14);
    const isBigPair = r1 === r2 && r1 >= 12; // QQ, KK, AA
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
    if (!coachOn || !game) return;
    const you = game.seats[0];
    if (you.out || you.folded || you.hole.length < 2 || game.phase !== 'betting') return;
    let html = '<div class="hand-label">' + E.holeLabel(you.hole[0], you.hole[1]) +
      ' <span style="font-weight:400;color:var(--dim)">(' + cardsText(you.hole) + ')</span></div>';
    if (game.street === 0) {
      const bd = E.chenBreakdown(you.hole[0], you.hole[1]);
      html += chenTableHtml(bd);
      html += '<div>Strength: <span class="made">' + handTier(you.hole, bd.total) + '</span> — you\'re in ' + positionText() + '.</div>';
    } else {
      const made = E.describeMade(you.hole, game.board);
      html += '<div>You have: <span class="made">' + made.name + '</span></div>';
      const notes = made.notes.concat(E.findDraws(you.hole, game.board).notes);
      if (notes.length) html += '<ul>' + notes.map((n) => '<li>' + n + '</li>').join('') + '</ul>';
    }
    html += '<div class="off" style="margin-top:8px">Odds and advice appear when it\'s your turn.</div>';
    $('coach-body').innerHTML = html;
  }

  function updateCoach() {
    $('coach-toggle').textContent = coachOn ? 'hide' : 'show';
    if (!coachOn || !game || game.phase !== 'betting' || game.actor !== 0) return;
    const body = $('coach-body');
    const you = game.seats[0];
    const la = game.legalActions(0);
    const pot = game.totalPot();
    const activeOpp = game.seats.filter((s) => !s.out && !s.folded && s.seat !== 0).length;
    let html = '<div class="hand-label">' + E.holeLabel(you.hole[0], you.hole[1]) +
      ' <span style="font-weight:400;color:var(--dim)">(' + cardsText(you.hole) + ')</span></div>';

    if (game.street === 0) {
      // ----- preflop -----
      const bd = E.chenBreakdown(you.hole[0], you.hole[1]);
      const chen = bd.total;
      const raised = game.currentBet > game.bigBlind;
      // Tiers match the Learn tab: Premium = AA, KK, QQ, AK.
      const tier = handTier(you.hole, chen);
      let advice;
      if (!raised) {
        if (tier === 'Premium' || chen >= 9) advice = 'Raise to about $' + (game.bigBlind * 3) + '. Strong hands want to build the pot and thin the field.';
        else if (chen >= 7) advice = la.canCheck ? 'Checking is fine, or raise to pressure the limpers.' : 'Playable — calling is okay, especially in late position. Fold to heavy action later.';
        else if (chen >= 5) advice = la.canCheck ? 'Check and see a free flop.' : 'Marginal. Late position: okay to call. Early position: folding is better.';
        else advice = la.canCheck ? 'Check — you got a free look. Plan to give up unless the flop is great.' : 'Fold. Weak hands lose money even when they hit.';
      } else {
        if (tier === 'Premium') advice = 'Re-raise (about 3× their raise). AA, KK, QQ and AK are the hands that punish raisers — play a big pot.';
        else if (chen >= 10) advice = 'Calling is reasonable. Re-raising with strong hands is optional.';
        else if (chen >= 8 && la.toCall <= game.bigBlind * 3) advice = 'The raise is small — calling to see a flop is fine. Fold to a re-raise.';
        else advice = 'Fold. Facing a raise, you need a genuinely strong hand — this isn\'t it.';
      }
      html += chenTableHtml(bd);
      html += '<div>Strength: <span class="made">' + tier + '</span> — you\'re in ' + positionText() + '.</div>';
      html += '<div class="advice">' + advice + '</div>';
    } else {
      // ----- postflop -----
      const made = E.describeMade(you.hole, game.board);
      const eq = E.equity(you.hole, game.board, activeOpp, 600);
      const eqPct = Math.round(eq.equity * 100);
      html += '<div>You have: <span class="made">' + made.name + '</span></div>';
      const notes = made.notes.slice();
      const draws = E.findDraws(you.hole, game.board);
      draws.notes.forEach((n) => notes.push(n));
      if (notes.length) html += '<ul>' + notes.map((n) => '<li>' + n + '</li>').join('') + '</ul>';

      html += '<div style="margin-top:6px">If opponents held <b>random</b> cards, you\'d win about <b>' + eqPct + '%</b> of the time (vs ' + activeOpp + ' opponent' + (activeOpp > 1 ? 's' : '') + ').</div>';
      html += '<div class="eq-bar"><div class="eq-fill" style="width:' + eqPct + '%"></div></div>';
      html += '<div class="eq-nums"><span>0%</span><span>simulated 600 random deals</span><span>100%</span></div>';

      let advice;
      if (la.toCall > 0) {
        const needed = la.toCall / (pot + la.toCall);
        const neededPct = Math.round(needed * 100);
        html += '<div>Pot odds: call $' + la.toCall + ' into $' + pot + ' → you need <b>' + neededPct + '%</b> to break even.</div>';
        if (eq.equity > needed + 0.25 && eq.equity > 0.6) advice = 'Comfortably ahead of the price, even allowing for the bettor holding better than random — raise for value or call.';
        else if (eq.equity > needed + 0.1) advice = 'Ahead of the price against random hands — but someone who bets usually has better than random. Calling is fine against a small bet; tighten up against big raises.';
        else if (eq.equity > needed - 0.03) advice = 'Borderline at best — and bettors are rarely random. Folding is usually right unless the bet is tiny.';
        else advice = 'Fold. You need ' + neededPct + '% but have only ~' + eqPct + '% even against random hands.';
        advice += '<div style="margin-top:6px;color:var(--dim);font-size:12px">⚠ The % assumes random opponent cards. A bet or raise usually means a stronger-than-random hand — discount accordingly.</div>';
      } else {
        if (eq.equity > 0.62) advice = 'You\'re a big favorite — bet about ⅔ of the pot ($' + Math.round(pot * 0.66) + ') for value.';
        else if (eq.equity > 0.45) advice = 'Decent but not dominant. Checking is fine; a modest bet also works.';
        else if (draws.outs.length >= 8) advice = 'Your made hand is weak but your draw is live — check, or make a "semi-bluff" bet.';
        else advice = 'Weak hand. Check, and fold if someone bets big.';
      }
      html += '<div class="advice">' + advice + '</div>';
    }
    body.innerHTML = html;
  }

  // ---------- banners ----------
  function hideBanner() { $('banner').classList.remove('show'); }

  function showHandEndBanner() {
    const you = game.seats[0];
    const realWins = ui.awards.filter((a) => a.reason !== 'returned');
    // Group awards by seat: split pots / side pots can have several winners.
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
      title = seat === 0 ? '🎉 You win $' + amt + '!' : seatName(seat) + ' wins $' + amt;
      sub = handNameOf(seat) ? 'Winning hand: ' + handNameOf(seat) : 'Everyone else folded.';
    } else {
      const youWon = bySeat.get(0) || 0;
      title = youWon > 0 ? '🎉 Split pot — you win $' + youWon : 'The pot is split';
      sub = Array.from(bySeat.entries()).map(([seat, amt]) =>
        seatName(seat) + ' $' + amt + (handNameOf(seat) ? ' (' + handNameOf(seat) + ')' : '')
      ).join(' &nbsp;·&nbsp; ');
    }

    const btn = $('banner-btn');
    if (you.stack <= 0) {
      const buyIn = setup.startingStack;
      title += ' — you\'re out of chips!';
      sub += ' Rebuy to keep practicing.';
      btn.textContent = 'Rebuy $' + buyIn + ' & deal ▸';
      btn.onclick = () => {
        you.stack = buyIn; you.out = false;
        log('<b>You rebuy for $' + buyIn + '.</b>');
        hideBanner(); game.startHand(); enqueue(game.drainEvents());
      };
    } else {
      btn.textContent = 'Deal next hand ▸';
      btn.onclick = () => { hideBanner(); game.startHand(); enqueue(game.drainEvents()); };
    }
    $('banner-title').textContent = title;
    $('banner-sub').innerHTML = sub;
    $('banner').classList.add('show');
  }

  function showGameOverBanner() {
    const alive = game.seats.filter((s) => !s.out);
    const youWon = alive.length === 1 && alive[0].seat === 0;
    $('banner-title').textContent = youWon ? '🏆 You win the whole table!' : 'Game over';
    $('banner-sub').textContent = youWon
      ? 'Every opponent is busted. Start a new game to keep sharpening your skills.'
      : (alive.length ? alive.map((s) => s.name).join(', ') + ' takes the table.' : '');
    const btn = $('banner-btn');
    btn.textContent = '↻ New game';
    btn.onclick = newGame;
    $('banner').classList.add('show');
  }

  // ---------- game lifecycle ----------
  function newGame() {
    if (botTimer) { clearTimeout(botTimer); botTimer = null; }
    pumpGen++; // invalidate any in-flight pump timer from the old game
    uiQueue.length = 0; uiBusy = false;
    const sb = setup.smallBlind, bb = sb * 2, stack = setup.startingStack;
    game = new E.Game({ players: buildPlayers(), startingStack: stack, smallBlind: sb, bigBlind: bb });
    $('solo-blinds-label').textContent = sb + ' / ' + bb;
    resetUiState();
    buildSeats();
    $('log-body').innerHTML = '';
    log('<b>New game.</b> Everyone starts with $' + stack + '. Blinds are $' + sb + '/$' + bb + '. Good luck!');
    hideBanner();
    game.startHand();
    enqueue(game.drainEvents());
  }

  // ---------- setup screen ----------
  const BOT_ORDER = ['Rosie', 'Tex', 'Doc'];
  function showSetup() {
    $('solo-setup').style.display = '';
    $('solo-game').style.display = 'none';
    if (botTimer) { clearTimeout(botTimer); botTimer = null; }
    renderSetup();
  }
  function startGame() {
    $('solo-setup').style.display = 'none';
    $('solo-game').style.display = '';
    newGame();
  }
  function renderSetup() {
    $('solo-bots').querySelectorAll('button').forEach((b) => b.classList.toggle('sel', Number(b.dataset.bots) === setup.bots));
    $('solo-bot-names').textContent = 'Playing: ' + BOT_ORDER.slice(0, setup.bots).join(', ');
    $('solo-diff').querySelectorAll('button').forEach((b) => b.classList.toggle('sel', b.dataset.diff === setup.difficulty));
    $('solo-diff-desc').textContent = DIFF_DESC[setup.difficulty];
    $('solo-blinds').querySelectorAll('button').forEach((b) => b.classList.toggle('sel', Number(b.dataset.sb) === setup.smallBlind));
    $('solo-buyin').querySelectorAll('button').forEach((b) => b.classList.toggle('sel', Number(b.dataset.buyin) === setup.startingStack));
    $('solo-speed').querySelectorAll('button').forEach((b) => b.classList.toggle('sel', b.dataset.speed === setup.speed));
  }
  $('solo-bots').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => { setup.bots = Number(b.dataset.bots); renderSetup(); }));
  $('solo-diff').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => { setup.difficulty = b.dataset.diff; renderSetup(); }));
  $('solo-blinds').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => { setup.smallBlind = Number(b.dataset.sb); renderSetup(); }));
  $('solo-buyin').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => { setup.startingStack = Number(b.dataset.buyin); renderSetup(); }));
  $('solo-speed').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => { setup.speed = b.dataset.speed; renderSetup(); }));
  $('solo-start').addEventListener('click', startGame);
  $('btn-newgame').addEventListener('click', showSetup); // "New game" reopens the setup

  showSetup(); // begin on the setup screen instead of auto-starting a game
})();
