/* engine.js — Texas Hold'em core engine: cards, hand evaluation, equity, bots, game state.
   Works in the browser (window.PokerEngine) and in Node (module.exports) so it can be unit-tested. */
(function (global) {
  'use strict';

  // ===== Cards =====
  // Card id: 0..51.  id = (rank-2)*4 + suit.  rank: 2..14 (14 = Ace).  suit: 0=♠ 1=♥ 2=♦ 3=♣
  const SUIT_SYMBOL = ['♠', '♥', '♦', '♣'];
  const RANK_CHAR = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
  const RANK_WORD = ['Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Jack', 'Queen', 'King', 'Ace'];
  const RANK_PLURAL = ['Twos', 'Threes', 'Fours', 'Fives', 'Sixes', 'Sevens', 'Eights', 'Nines', 'Tens', 'Jacks', 'Queens', 'Kings', 'Aces'];

  const rankOf = (c) => (c >> 2) + 2;
  const suitOf = (c) => c & 3;
  const makeCard = (rank, suit) => (rank - 2) * 4 + suit;
  const cardText = (c) => RANK_CHAR[rankOf(c) - 2] + SUIT_SYMBOL[suitOf(c)];
  const isRed = (c) => suitOf(c) === 1 || suitOf(c) === 2;
  const rankWord = (r) => RANK_WORD[r - 2];
  const rankPlural = (r) => RANK_PLURAL[r - 2];

  function newDeck() {
    const d = [];
    for (let i = 0; i < 52; i++) d.push(i);
    return d;
  }

  function shuffle(a, rand) {
    rand = rand || Math.random;
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      const t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  // ===== Hand evaluation =====
  const CAT_NAME = ['High Card', 'Pair', 'Two Pair', 'Three of a Kind', 'Straight',
    'Flush', 'Full House', 'Four of a Kind', 'Straight Flush'];

  // Packed score: category then 5 tiebreak slots, base 15. Higher = better hand.
  function score5(cards) {
    const rs = [rankOf(cards[0]), rankOf(cards[1]), rankOf(cards[2]), rankOf(cards[3]), rankOf(cards[4])]
      .sort((a, b) => b - a);
    const s0 = suitOf(cards[0]);
    const flush = suitOf(cards[1]) === s0 && suitOf(cards[2]) === s0 &&
      suitOf(cards[3]) === s0 && suitOf(cards[4]) === s0;

    const cnt = {};
    for (const r of rs) cnt[r] = (cnt[r] || 0) + 1;
    const groups = Object.keys(cnt).map(Number).sort((a, b) => (cnt[b] - cnt[a]) || (b - a));

    let straightHigh = 0;
    if (groups.length === 5) {
      if (rs[0] - rs[4] === 4) straightHigh = rs[0];
      else if (rs[0] === 14 && rs[1] === 5) straightHigh = 5; // wheel A-2-3-4-5
    }

    let cat, tb;
    if (flush && straightHigh) { cat = 8; tb = [straightHigh]; }
    else if (cnt[groups[0]] === 4) { cat = 7; tb = [groups[0], groups[1]]; }
    else if (cnt[groups[0]] === 3 && cnt[groups[1]] === 2) { cat = 6; tb = [groups[0], groups[1]]; }
    else if (flush) { cat = 5; tb = rs; }
    else if (straightHigh) { cat = 4; tb = [straightHigh]; }
    else if (cnt[groups[0]] === 3) { cat = 3; tb = groups; }
    else if (cnt[groups[0]] === 2 && cnt[groups[1]] === 2) { cat = 2; tb = groups; }
    else if (cnt[groups[0]] === 2) { cat = 1; tb = groups; }
    else { cat = 0; tb = rs; }

    let s = cat;
    for (let i = 0; i < 5; i++) s = s * 15 + (tb[i] || 0);
    return s;
  }

  // All C(n,5) index combinations, cached per n.
  const _combosCache = {};
  function combos5(n) {
    if (_combosCache[n]) return _combosCache[n];
    const out = [];
    for (let a = 0; a < n - 4; a++)
      for (let b = a + 1; b < n - 3; b++)
        for (let c = b + 1; c < n - 2; c++)
          for (let d = c + 1; d < n - 1; d++)
            for (let e = d + 1; e < n; e++) out.push([a, b, c, d, e]);
    _combosCache[n] = out;
    return out;
  }

  // Best 5-card hand from 5, 6, or 7 cards. Returns {score, cards} (cards = the winning 5).
  function bestHand(cards) {
    const n = cards.length;
    if (n === 5) return { score: score5(cards), cards: cards.slice() };
    let best = -1, bestCards = null;
    const pick = [0, 0, 0, 0, 0];
    for (const idx of combos5(n)) {
      pick[0] = cards[idx[0]]; pick[1] = cards[idx[1]]; pick[2] = cards[idx[2]];
      pick[3] = cards[idx[3]]; pick[4] = cards[idx[4]];
      const s = score5(pick);
      if (s > best) { best = s; bestCards = pick.slice(); }
    }
    return { score: best, cards: bestCards };
  }

  function bestScore(cards) {
    return cards.length === 5 ? score5(cards) : bestHand(cards).score;
  }

  function unpackScore(s) {
    const tb = [];
    for (let i = 0; i < 5; i++) { tb.unshift(s % 15); s = Math.floor(s / 15); }
    return { cat: s, tb };
  }

  const categoryOf = (score) => unpackScore(score).cat;

  function handName(score) {
    const { cat, tb } = unpackScore(score);
    switch (cat) {
      case 8: return tb[0] === 14 ? 'Royal Flush' : 'Straight Flush, ' + rankWord(tb[0]) + ' high';
      case 7: return 'Four of a Kind, ' + rankPlural(tb[0]);
      case 6: return 'Full House, ' + rankPlural(tb[0]) + ' full of ' + rankPlural(tb[1]);
      case 5: return 'Flush, ' + rankWord(tb[0]) + ' high';
      case 4: return 'Straight, ' + rankWord(tb[0]) + ' high';
      case 3: return 'Three of a Kind, ' + rankPlural(tb[0]);
      case 2: return 'Two Pair, ' + rankPlural(tb[0]) + ' and ' + rankPlural(tb[1]);
      case 1: return 'Pair of ' + rankPlural(tb[0]);
      default: return rankWord(tb[0]) + ' High';
    }
  }

  // ===== Equity (Monte Carlo) =====
  // Chance our hand wins (counting split pots fractionally) vs nOpp random hands.
  function equity(hole, board, nOpp, trials) {
    trials = trials || 400;
    nOpp = Math.max(1, nOpp);
    const used = new Set(hole.concat(board));
    const pool = [];
    for (let c = 0; c < 52; c++) if (!used.has(c)) pool.push(c);
    const needBoard = 5 - board.length;
    const need = nOpp * 2 + needBoard;
    let total = 0, wins = 0, ties = 0;

    for (let t = 0; t < trials; t++) {
      // Partial Fisher-Yates: randomize the first `need` slots of the pool.
      for (let i = 0; i < need; i++) {
        const j = i + Math.floor(Math.random() * (pool.length - i));
        const tmp = pool[i]; pool[i] = pool[j]; pool[j] = tmp;
      }
      const fullBoard = board.slice();
      for (let i = 0; i < needBoard; i++) fullBoard.push(pool[i]);
      const myScore = bestScore(hole.concat(fullBoard));

      let beaten = false, tiedCount = 0;
      for (let o = 0; o < nOpp; o++) {
        const oppHole = [pool[needBoard + o * 2], pool[needBoard + o * 2 + 1]];
        const os = bestScore(oppHole.concat(fullBoard));
        if (os > myScore) { beaten = true; break; }
        if (os === myScore) tiedCount++;
      }
      if (!beaten) {
        if (tiedCount === 0) { wins++; total += 1; }
        else { ties++; total += 1 / (1 + tiedCount); }
      }
    }
    return { equity: total / trials, winPct: wins / trials, tiePct: ties / trials };
  }

  // ===== Preflop hand strength (Chen formula) =====
  // Returns the score plus the individual steps, so a UI can show the math.
  function chenBreakdown(c1, c2) {
    const r1 = rankOf(c1), r2 = rankOf(c2);
    const hi = Math.max(r1, r2), lo = Math.min(r1, r2);
    const steps = [];
    let pts;
    if (hi === 14) pts = 10;
    else if (hi === 13) pts = 8;
    else if (hi === 12) pts = 7;
    else if (hi === 11) pts = 6;
    else pts = hi / 2;
    steps.push({ label: 'Highest card: ' + rankWord(hi) + (hi <= 10 ? ' (half its value)' : ''), value: '+' + pts });
    if (r1 === r2) {
      const doubled = pts * 2;
      steps.push({ label: 'A pair — double the points', value: '×2 = ' + doubled });
      if (doubled < 5) steps.push({ label: 'Every pair scores at least 5', value: '→ 5' });
      return { steps, total: Math.max(5, doubled) };
    }
    if (suitOf(c1) === suitOf(c2)) { pts += 2; steps.push({ label: 'Suited — flush potential', value: '+2' }); }
    const gap = hi - lo - 1;
    let pen = 0;
    if (gap === 1) pen = 1;
    else if (gap === 2) pen = 2;
    else if (gap === 3) pen = 4;
    else if (gap >= 4) pen = 5;
    if (pen > 0) {
      pts -= pen;
      steps.push({ label: gap >= 4 ? '4+ gaps between the cards' : gap + ' gap' + (gap > 1 ? 's' : '') + ' between the cards', value: '−' + pen });
    } else {
      steps.push({ label: 'Connected — no gap penalty', value: '+0' });
    }
    if (gap <= 1 && hi < 12) { pts += 1; steps.push({ label: 'Close cards below a Queen — straight potential', value: '+1' }); }
    const total = Math.ceil(pts);
    if (total !== pts) steps.push({ label: 'Round the half point up', value: pts + ' → ' + total });
    return { steps, total };
  }

  function chenScore(c1, c2) { return chenBreakdown(c1, c2).total; }

  // Short label like "A-K suited" / "Pocket Queens"
  function holeLabel(c1, c2) {
    const r1 = rankOf(c1), r2 = rankOf(c2);
    if (r1 === r2) return 'Pocket ' + rankPlural(r1);
    const hi = Math.max(r1, r2), lo = Math.min(r1, r2);
    const suited = suitOf(c1) === suitOf(c2) ? ' suited' : ' offsuit';
    return RANK_CHAR[hi - 2] + '-' + RANK_CHAR[lo - 2] + suited;
  }

  // ===== Draw detection (for the coach) =====
  function findDraws(hole, board) {
    const cards = hole.concat(board);
    const visible = new Set(cards);
    const outs = new Set();
    const notes = [];
    if (board.length < 3 || board.length >= 5) return { outs: [], notes: [] };

    // Flush draw: exactly 4 of one suit among our cards + board (using at least one hole card).
    const suitCount = [0, 0, 0, 0];
    cards.forEach((c) => suitCount[suitOf(c)]++);
    for (let s = 0; s < 4; s++) {
      if (suitCount[s] === 4 && (suitOf(hole[0]) === s || suitOf(hole[1]) === s)) {
        for (let r = 2; r <= 14; r++) {
          const c = makeCard(r, s);
          if (!visible.has(c)) outs.add(c);
        }
        notes.push('Flush draw (9 outs — any ' + SUIT_SYMBOL[s] + ')');
      }
    }

    // Straight draws. Treat Ace as high and low. A window only counts if one of
    // OUR hole cards is part of it — a straight sitting entirely on the board
    // belongs to everyone and is not a draw for us.
    const have = new Set(cards.map(rankOf));
    if (have.has(14)) have.add(1);
    const boardHas = new Set(board.map(rankOf));
    if (boardHas.has(14)) boardHas.add(1);
    let madeStraight = false;
    const completing = new Set();
    for (let low = 1; low <= 10; low++) {
      const missing = [];
      let usesHole = false;
      for (let r = low; r < low + 5; r++) {
        if (!have.has(r)) missing.push(r);
        else if (!boardHas.has(r)) usesHole = true;
      }
      if (missing.length === 0) madeStraight = true;
      else if (missing.length === 1 && usesHole) completing.add(missing[0] === 1 ? 14 : missing[0]);
    }
    if (!madeStraight && completing.size > 0) {
      let n = 0;
      for (const r of completing) {
        for (let s = 0; s < 4; s++) {
          const c = makeCard(r, s);
          if (!visible.has(c)) { outs.add(c); n++; }
        }
      }
      // "Open-ended" = a contiguous 4-card run whose BOTH end cards complete it;
      // two non-adjacent completing ranks are a double gutshot.
      let openEnded = false;
      if (completing.size >= 2) {
        const compW = new Set();
        completing.forEach((c) => { compW.add(c); if (c === 14) compW.add(1); });
        for (let r = 2; r <= 10; r++) {
          if (have.has(r) && have.has(r + 1) && have.has(r + 2) && have.has(r + 3) &&
            compW.has(r - 1) && compW.has(r + 4)) { openEnded = true; break; }
        }
      }
      notes.push((completing.size >= 2
        ? (openEnded ? 'Open-ended straight draw' : 'Double-gutshot straight draw')
        : 'Gutshot straight draw') + ' (' + n + ' outs)');
    }
    return { outs: Array.from(outs), notes };
  }

  // Contextual description of a made hand for coaching, e.g. "top pair".
  function describeMade(hole, board) {
    const ev = bestHand(hole.concat(board));
    const { cat, tb } = unpackScore(ev.score);
    const name = handName(ev.score);
    const notes = [];
    const boardRanks = board.map(rankOf);
    const maxBoard = boardRanks.length ? Math.max.apply(null, boardRanks) : 0;
    const r1 = rankOf(hole[0]), r2 = rankOf(hole[1]);

    if (cat === 1) {
      const pr = tb[0];
      const pocket = r1 === r2 && r1 === pr;
      if (pocket && !boardRanks.includes(pr)) {
        notes.push(pr > maxBoard ? 'An overpair — higher than every board card. Strong.'
          : 'A pocket pair below the top board card — be careful.');
      } else if ((r1 === pr || r2 === pr) && boardRanks.includes(pr)) {
        if (pr === maxBoard) notes.push('Top pair — you paired the highest board card.');
        else notes.push('You paired the board, but not its top card — middle/bottom pair.');
        const kicker = r1 === pr ? r2 : r1;
        notes.push('Your kicker is the ' + rankWord(kicker) + '.');
      } else if (boardRanks.filter((r) => r === pr).length >= 2) {
        notes.push('That pair is on the board — everyone has it. You really just have high card.');
      }
    }
    if (cat === 0 && board.length >= 3) {
      notes.push('No pair yet. High card rarely wins at showdown — look at your draws and odds.');
    }
    return { score: ev.score, cards: ev.cards, cat, name, notes };
  }

  // ===== Bot decision-making =====
  // personality: { tight: 0..1 (higher folds more), aggr: 0..1, bluff: 0..1 }
  function botDecide(game, seat) {
    const p = game.seats[seat];
    const la = game.legalActions(seat);
    const pot = game.totalPot();
    const rnd = Math.random;
    const pers = p.personality || { tight: 0.5, aggr: 0.5, bluff: 0.2 };
    const activeOpp = game.seats.filter((s) => !s.out && !s.folded && s.seat !== seat).length;

    const clampRaise = (to) => Math.max(la.minRaiseTo, Math.min(la.maxRaiseTo, Math.round(to)));

    if (game.street === 0) {
      // --- Preflop: Chen score + position + noise ---
      const chen = chenScore(p.hole[0], p.hole[1]);
      const posBonus = game.positionFactor(seat) * 1.5; // 0 early .. 1.5 button
      const eff = chen + posBonus + (rnd() * 3 - 1.5) - pers.tight * 1.5;
      const raised = game.currentBet > game.bigBlind;

      if (!raised) {
        if (la.canRaise && eff >= 9) {
          const to = clampRaise(game.bigBlind * (2.5 + rnd() * 1.5) + game.currentBet - game.bigBlind);
          return { type: 'raise', amount: to };
        }
        if (la.canRaise && la.toCall > 0 && eff >= 12 - pers.bluff * 3 && rnd() < pers.bluff * 0.5) {
          return { type: 'raise', amount: clampRaise(game.bigBlind * 3) };
        }
        if (la.toCall === 0) return { type: 'check' };
        if (eff >= 6.5 - (1 - pers.tight) * 1.5) return { type: 'call' };
        return { type: 'fold' };
      } else {
        // Facing a raise
        if (la.canRaise && eff >= 13 + pers.tight) {
          return { type: 'raise', amount: clampRaise(game.currentBet * 2.8) };
        }
        const priced = la.toCall <= pot * 0.6;
        if (eff >= (priced ? 9 : 10.5)) return la.toCall === 0 ? { type: 'check' } : { type: 'call' };
        if (la.toCall === 0) return { type: 'check' };
        if (la.toCall <= game.bigBlind * 2 && eff >= 7 && rnd() < 0.5) return { type: 'call' };
        return { type: 'fold' };
      }
    }

    // --- Postflop: Monte Carlo equity vs random hands ---
    const eq = equity(p.hole, game.board, activeOpp, 150).equity;
    const noise = (rnd() * 0.08) - 0.04;
    const e = eq + noise;

    if (la.toCall === 0) {
      if (la.canRaise) {
        if (e > 0.78) return { type: 'raise', amount: clampRaise(pot * (0.7 + pers.aggr * 0.4)) };
        if (e > 0.58 && rnd() < 0.5 + pers.aggr * 0.4) {
          return { type: 'raise', amount: clampRaise(pot * (0.5 + pers.aggr * 0.3)) };
        }
        if (e < 0.40 && rnd() < pers.bluff * 0.3 && game.street >= 1) {
          return { type: 'raise', amount: clampRaise(pot * 0.55) }; // bluff
        }
      }
      return { type: 'check' };
    }

    const potOdds = la.toCall / (pot + la.toCall);
    const margin = 0.02 + pers.tight * 0.08;
    if (la.canRaise && e > potOdds + 0.28 && e > 0.6 && rnd() < 0.4 + pers.aggr * 0.4) {
      return { type: 'raise', amount: clampRaise(game.currentBet * 2.5 + pot * 0.3) };
    }
    if (e >= potOdds + margin) return { type: 'call' };
    if (e >= potOdds - 0.05 && la.toCall <= p.stack * 0.08 && rnd() < 0.4) return { type: 'call' };
    return { type: 'fold' };
  }

  // ===== Side pots =====
  // From each seat's total committed chips, build pots with eligibility.
  function computePots(seats) {
    const contrib = seats.map((s) => s.committed);
    const pots = [];
    for (;;) {
      let lvl = Infinity;
      for (let i = 0; i < seats.length; i++) if (contrib[i] > 0) lvl = Math.min(lvl, contrib[i]);
      if (lvl === Infinity) break;
      let amount = 0;
      const eligible = [];
      for (let i = 0; i < seats.length; i++) {
        if (contrib[i] > 0) {
          amount += lvl;
          contrib[i] -= lvl;
          if (!seats[i].folded && !seats[i].out) eligible.push(i);
        }
      }
      const prev = pots[pots.length - 1];
      if (prev && prev.eligible.length === eligible.length &&
        prev.eligible.every((e, i) => e === eligible[i])) {
        prev.amount += amount; // merge layers with identical eligibility
      } else {
        pots.push({ amount, eligible });
      }
    }
    return pots;
  }

  // ===== Game =====
  const STREET_NAME = ['Pre-flop', 'Flop', 'Turn', 'River'];

  class Game {
    constructor(opts) {
      this.smallBlind = opts.smallBlind || 5;
      this.bigBlind = opts.bigBlind || 10;
      this.seats = opts.players.map((p, i) => ({
        seat: i, name: p.name, isBot: !!p.isBot, emoji: p.emoji || '',
        personality: p.personality || null,
        stack: p.stack != null ? p.stack : (opts.startingStack || 1000),
        hole: [], folded: true, allIn: false, out: false,
        bet: 0,        // chips in front this street
        committed: 0,  // total chips put in this hand
        needsAction: false,
        lastActedAt: null, // currentBet level when this player last acted this street
      }));
      this.button = opts.button != null ? opts.button : Math.floor(Math.random() * this.seats.length);
      this.handNum = 0;
      this.phase = 'idle'; // idle | betting | handComplete | gameOver
      this.street = 0;
      this.board = [];
      this.deck = [];
      this.currentBet = 0;
      this.minRaiseIncrement = this.bigBlind;
      this.actor = null;
      this.events = [];
      this.lastResult = null;
    }

    // Every event carries a snapshot of the table as it looked at that moment, so
    // the UI can replay events with delays without leaking future state.
    _snapshot() {
      return {
        board: this.board.slice(),
        pot: this.totalPot(),
        street: this.street,
        actor: this.actor,
        phase: this.phase,
        handNum: this.handNum,
        button: this.button,
        seats: this.seats.map((s) => ({
          stack: s.stack, bet: s.bet, folded: s.folded,
          allIn: s.allIn, out: s.out, hole: s.hole.slice(),
        })),
      };
    }
    _emit(type, data) {
      const ev = Object.assign({ type }, data || {});
      ev.snap = this._snapshot();
      this.events.push(ev);
    }
    drainEvents() { const e = this.events; this.events = []; return e; }

    inHandSeats() { return this.seats.filter((s) => !s.out && !s.folded); }
    livingSeats() { return this.seats.filter((s) => !s.out); }

    totalPot() { return this.seats.reduce((a, s) => a + s.committed, 0); }

    _nextLiving(from) {
      for (let k = 1; k <= this.seats.length; k++) {
        const i = (from + k) % this.seats.length;
        if (!this.seats[i].out) return i;
      }
      return null;
    }

    // 0 = earliest position, 1 = button (latest)
    positionFactor(seat) {
      const living = this.livingSeats().map((s) => s.seat);
      const n = living.length;
      if (n <= 2) return seat === this.button ? 1 : 0;
      let stepsFromButton = 0;
      let i = this.button;
      while (i !== seat) { i = this._nextLiving(i); stepsFromButton++; }
      // seats right after button (blinds) act early; button acts last
      return stepsFromButton === 0 ? 1 : (stepsFromButton - 1) / Math.max(1, n - 1);
    }

    startHand() {
      // Bust check
      for (const s of this.seats) {
        if (!s.out && s.stack <= 0) { s.out = true; this._emit('bust', { seat: s.seat, name: s.name }); }
      }
      const living = this.livingSeats();
      if (living.length < 2) {
        this.phase = 'gameOver';
        this._emit('game-over', { seat: living.length ? living[0].seat : null });
        return;
      }

      this.handNum++;
      if (this.handNum > 1) this.button = this._nextLiving(this.button);
      else if (this.seats[this.button].out) this.button = this._nextLiving(this.button);

      this.board = [];
      this.street = 0;
      this.deck = shuffle(newDeck());
      this.currentBet = 0;
      this.minRaiseIncrement = this.bigBlind;
      this.lastResult = null;
      for (const s of this.seats) {
        s.hole = []; s.bet = 0; s.committed = 0;
        s.folded = s.out; s.allIn = false;
        s.needsAction = false; s.lastActedAt = null;
      }

      // Blinds. Heads-up: the button IS the small blind.
      const headsUp = living.length === 2;
      const sbSeat = headsUp ? this.button : this._nextLiving(this.button);
      const bbSeat = this._nextLiving(sbSeat);
      this._emit('hand-start', {
        handNum: this.handNum, button: this.button, sbSeat, bbSeat,
        sb: this.smallBlind, bb: this.bigBlind,
      });
      this._postBlind(sbSeat, this.smallBlind, 'sb');
      this._postBlind(bbSeat, this.bigBlind, 'bb');
      this.currentBet = this.bigBlind;

      // Deal hole cards
      for (const s of this.livingSeats()) s.hole = [this.deck.pop(), this.deck.pop()];
      this._emit('deal-hole', {});

      for (const s of this.livingSeats()) if (!s.allIn) s.needsAction = true;
      this.phase = 'betting';
      this.actor = this._firstActor(this._nextLiving(bbSeat));
      if (this.actor === null) this._streetDone();
      else this._emit('turn', { seat: this.actor });
    }

    _postBlind(seat, amount, kind) {
      const s = this.seats[seat];
      const paid = Math.min(amount, s.stack);
      s.stack -= paid; s.bet += paid; s.committed += paid;
      if (s.stack === 0) s.allIn = true;
      this._emit('blind', { seat, kind, amount: paid, allIn: s.allIn });
    }

    _firstActor(startSeat) {
      let i = startSeat;
      for (let k = 0; k < this.seats.length; k++) {
        const s = this.seats[i];
        if (!s.out && !s.folded && !s.allIn && s.needsAction) return i;
        i = (i + 1) % this.seats.length;
      }
      return null;
    }

    legalActions(seat) {
      const p = this.seats[seat];
      const toCall = Math.min(this.currentBet - p.bet, p.stack);
      const canCheck = toCall === 0;
      const maxRaiseTo = p.bet + p.stack; // all-in
      let minRaiseTo = this.currentBet === 0
        ? this.bigBlind
        : this.currentBet + this.minRaiseIncrement;
      minRaiseTo = Math.min(minRaiseTo, maxRaiseTo);
      // Betting is reopened for a player if the bet has grown by at least a full
      // raise (possibly across several short all-ins) since they last acted.
      const reopened = p.lastActedAt === null ||
        (this.currentBet - p.lastActedAt) >= this.minRaiseIncrement;
      const canRaise = maxRaiseTo > this.currentBet && p.stack > toCall &&
        (this.currentBet === 0 || reopened);
      return { toCall, canCheck, canRaise, minRaiseTo, maxRaiseTo };
    }

    // action: {type:'fold'|'check'|'call'|'raise', amount?} — amount = TOTAL bet this street ("raise to")
    act(seat, action) {
      if (this.phase !== 'betting' || seat !== this.actor) return false;
      const p = this.seats[seat];
      const la = this.legalActions(seat);

      if (action.type === 'fold') {
        p.folded = true; p.needsAction = false;
        this._emit('action', { seat, action: 'fold' });
      } else if (action.type === 'check') {
        if (!la.canCheck) return false;
        p.needsAction = false; p.lastActedAt = this.currentBet;
        this._emit('action', { seat, action: 'check' });
      } else if (action.type === 'call') {
        if (la.toCall <= 0) return false;
        p.stack -= la.toCall; p.bet += la.toCall; p.committed += la.toCall;
        if (p.stack === 0) p.allIn = true;
        p.needsAction = false; p.lastActedAt = this.currentBet;
        this._emit('action', { seat, action: 'call', amount: la.toCall, allIn: p.allIn });
      } else if (action.type === 'raise') {
        if (!la.canRaise) return false;
        let to = Math.round(action.amount);
        to = Math.max(la.minRaiseTo, Math.min(la.maxRaiseTo, to));
        // A raise below the legal minimum is only allowed as an all-in.
        if (to < la.minRaiseTo && to < la.maxRaiseTo) return false;
        const add = to - p.bet;
        if (add <= 0 || add > p.stack) return false;
        const raiseSize = to - this.currentBet;
        const fullRaise = raiseSize >= this.minRaiseIncrement;
        p.stack -= add; p.bet = to; p.committed += add;
        if (p.stack === 0) p.allIn = true;
        p.needsAction = false;
        const prevBet = this.currentBet;
        this.currentBet = to;
        p.lastActedAt = to;
        if (fullRaise) {
          this.minRaiseIncrement = raiseSize;
          for (const s of this.seats) {
            if (s.seat !== seat && !s.out && !s.folded && !s.allIn) {
              s.needsAction = true;
            }
          }
        } else {
          // Under-raise all-in: others must match, but raising rights don't re-open.
          for (const s of this.seats) {
            if (s.seat !== seat && !s.out && !s.folded && !s.allIn && s.bet < this.currentBet) {
              s.needsAction = true;
            }
          }
        }
        this._emit('action', {
          seat, action: prevBet === 0 ? 'bet' : 'raise', amount: to, allIn: p.allIn,
        });
      } else {
        return false;
      }

      // Hand over by folds?
      const alive = this.inHandSeats();
      if (alive.length === 1) { this._winByFold(alive[0].seat); return true; }

      const next = this._firstActor((seat + 1) % this.seats.length);
      if (next === null) this._streetDone();
      else { this.actor = next; this._emit('turn', { seat: next }); }
      return true;
    }

    _streetDone() {
      for (const s of this.seats) { s.bet = 0; s.needsAction = false; s.lastActedAt = null; }
      this.currentBet = 0;
      this.minRaiseIncrement = this.bigBlind;
      this.actor = null;

      const alive = this.inHandSeats();
      const canBet = alive.filter((s) => !s.allIn);

      if (this.street >= 3) { this._showdown(); return; }

      // Everyone (or all but one) all-in: run out the rest of the board.
      if (canBet.length <= 1) {
        this._emit('runout', { reveals: alive.map((s) => ({ seat: s.seat, hole: s.hole.slice() })) });
        while (this.street < 3) this._dealStreet();
        this._showdown();
        return;
      }

      this._dealStreet();
      for (const s of canBet) s.needsAction = true;
      this.phase = 'betting';
      this.actor = this._firstActor(this._nextLiving(this.button));
      if (this.actor === null) this._streetDone();
      else this._emit('turn', { seat: this.actor });
    }

    _dealStreet() {
      this.street++;
      this.deck.pop(); // burn
      const n = this.street === 1 ? 3 : 1;
      const cards = [];
      for (let i = 0; i < n; i++) cards.push(this.deck.pop());
      this.board.push.apply(this.board, cards);
      this._emit('street', { street: this.street, name: STREET_NAME[this.street], cards, board: this.board.slice() });
    }

    _winByFold(seat) {
      // Return the uncalled portion of the winner's bet first, like a real room.
      const winner = this.seats[seat];
      let maxOther = 0;
      for (const s of this.seats) if (s.seat !== seat && s.committed > maxOther) maxOther = s.committed;
      const uncalled = Math.max(0, winner.committed - maxOther);
      const amount = this.totalPot() - uncalled;
      winner.stack += amount + uncalled;
      for (const s of this.seats) s.committed = 0;
      this.phase = 'handComplete';
      this.actor = null;
      this.lastResult = { type: 'fold', winners: [{ seat, amount }] };
      if (uncalled > 0) this._emit('pot-award', { seat, amount: uncalled, reason: 'returned' });
      this._emit('pot-award', { seat, amount, reason: 'fold' });
      this._emit('hand-end', {});
    }

    _showdown() {
      const alive = this.inHandSeats();
      const reveals = alive.map((s) => {
        const ev = bestHand(s.hole.concat(this.board));
        return { seat: s.seat, hole: s.hole.slice(), score: ev.score, best5: ev.cards, name: handName(ev.score) };
      });
      this._emit('showdown', { reveals, board: this.board.slice() });

      const scoreBySeat = {};
      for (const r of reveals) scoreBySeat[r.seat] = r.score;
      const pots = computePots(this.seats);
      // Clear the pot before emitting awards so event snapshots don't show the
      // pot still full while winners' stacks are already paid.
      for (const s of this.seats) s.committed = 0;
      const winners = [];
      pots.forEach((pot, pi) => {
        const eligible = pot.eligible.filter((i) => scoreBySeat[i] != null);
        if (!eligible.length) return; // shouldn't happen
        const bestS = Math.max.apply(null, eligible.map((i) => scoreBySeat[i]));
        const potWinners = eligible.filter((i) => scoreBySeat[i] === bestS);
        // Odd chips go to the first winner left of the button (button itself last).
        const n = this.seats.length, btn = this.button;
        potWinners.sort((a, b) => ((a - btn - 1 + n) % n) - ((b - btn - 1 + n) % n));
        const share = Math.floor(pot.amount / potWinners.length);
        let remainder = pot.amount - share * potWinners.length;
        const returned = pot.eligible.length === 1; // uncalled chips go back to the bettor
        for (const w of potWinners) {
          let amt = share;
          if (remainder > 0) { amt++; remainder--; }
          this.seats[w].stack += amt;
          winners.push({ seat: w, amount: amt, potIndex: pi, returned, handName: handName(scoreBySeat[w]) });
          this._emit('pot-award', {
            seat: w, amount: amt, reason: returned ? 'returned' : 'showdown', potIndex: pi,
            sidePot: pots.length > 1 && pi > 0, handName: handName(scoreBySeat[w]),
          });
        }
      });
      this.phase = 'handComplete';
      this.actor = null;
      this.lastResult = { type: 'showdown', winners, reveals };
      this._emit('hand-end', {});
    }
  }

  const api = {
    SUIT_SYMBOL, RANK_CHAR, RANK_WORD, RANK_PLURAL, CAT_NAME, STREET_NAME,
    rankOf, suitOf, makeCard, cardText, isRed, rankWord, rankPlural,
    newDeck, shuffle, score5, bestHand, bestScore, unpackScore, categoryOf, handName,
    equity, chenScore, chenBreakdown, holeLabel, findDraws, describeMade, botDecide, computePots, Game,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.PokerEngine = api;
})(typeof window !== 'undefined' ? window : globalThis);
