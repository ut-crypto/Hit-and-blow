/*
 * 将棋のルール(盤面・合法手・王手・詰み・千日手・USI/SFEN/棋譜表記)
 * ブラウザでは window.ShogiCore、Node.js では module.exports として使える。
 *
 * 座標: idx = row * 9 + col
 *   row 0..8 = 一段目..九段目(上が後手陣)
 *   col 0..8 = 9筋..1筋(左が9筋)
 * 手番: 0 = 先手(▲, SFEN の大文字), 1 = 後手(△, 小文字)
 * 駒: { c: 手番, t: 'P'|'L'|'N'|'S'|'G'|'B'|'R'|'K', p: 成っているか }
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ShogiCore = factory();
})(typeof self !== 'undefined' ? self : this, () => {
  'use strict';

  const BLACK = 0;
  const WHITE = 1;
  const HAND_TYPES = ['R', 'B', 'G', 'S', 'N', 'L', 'P'];
  const PROMOTABLE = { P: true, L: true, N: true, S: true, B: true, R: true };
  const STARTPOS_SFEN = 'lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1';
  const MAX_MOVES = 512; // これを超えたら引き分け(持将棋扱い)

  // 先手から見た移動方向 [行, 列](行がマイナス = 前進)
  const DIAG = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
  const ORTH = [[-1, 0], [1, 0], [0, -1], [0, 1]];
  const GOLD = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, 0]];
  const KING = [...DIAG, ...ORTH];
  const MOVES = {
    P: { steps: [[-1, 0]], slides: [] },
    L: { steps: [], slides: [[-1, 0]] },
    N: { steps: [[-2, -1], [-2, 1]], slides: [] },
    S: { steps: [[-1, -1], [-1, 0], [-1, 1], [1, -1], [1, 1]], slides: [] },
    G: { steps: GOLD, slides: [] },
    K: { steps: KING, slides: [] },
    B: { steps: [], slides: DIAG },
    R: { steps: [], slides: ORTH },
    '+B': { steps: ORTH, slides: DIAG },
    '+R': { steps: DIAG, slides: ORTH },
  };
  const movesOf = (pc) => (pc.p ? MOVES[`+${pc.t}`] || MOVES.G : MOVES[pc.t]);

  const PIECE_CHAR = { P: '歩', L: '香', N: '桂', S: '銀', G: '金', B: '角', R: '飛', K: '玉' };
  const PROMOTED_CHAR = { P: 'と', L: '杏', N: '圭', S: '全', B: '馬', R: '龍' };
  const PROMOTED_NAME = { P: 'と', L: '成香', N: '成桂', S: '成銀', B: '馬', R: '龍' };
  const ZEN_DIGIT = ['', '１', '２', '３', '４', '５', '６', '７', '８', '９'];
  const KAN_DIGIT = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九'];

  const rowOf = (i) => Math.floor(i / 9);
  const colOf = (i) => i % 9;
  const fileOf = (i) => 9 - colOf(i);
  const rankOf = (i) => rowOf(i) + 1;
  const inBoard = (r, c) => r >= 0 && r < 9 && c >= 0 && c < 9;
  const inZone = (color, row) => (color === BLACK ? row <= 2 : row >= 6);

  function mustPromote(t, color, row) {
    const fromLast = color === BLACK ? row : 8 - row; // 敵陣最奥からの距離
    if (t === 'P' || t === 'L') return fromLast === 0;
    if (t === 'N') return fromLast <= 1;
    return false;
  }

  const emptyHand = () => ({ R: 0, B: 0, G: 0, S: 0, N: 0, L: 0, P: 0 });

  // ---------- USI 表記 ----------

  function sqToUsi(i) {
    return `${fileOf(i)}${String.fromCharCode(97 + rowOf(i))}`;
  }

  function usiToSq(s) {
    const file = Number(s[0]);
    const row = s.charCodeAt(1) - 97;
    if (!(file >= 1 && file <= 9) || !(row >= 0 && row <= 8)) return -1;
    return row * 9 + (9 - file);
  }

  function moveToUsi(m) {
    if (m.drop) return `${m.drop}*${sqToUsi(m.to)}`;
    return `${sqToUsi(m.from)}${sqToUsi(m.to)}${m.promote ? '+' : ''}`;
  }

  // ---------- 局面 ----------

  class Position {
    constructor() {
      this.board = new Array(81).fill(null);
      this.hands = [emptyHand(), emptyHand()];
      this.side = BLACK;
    }

    static startpos() {
      return Position.fromSfen(STARTPOS_SFEN);
    }

    static fromSfen(sfen) {
      const [boardPart, side, handPart] = sfen.trim().split(/\s+/);
      const pos = new Position();
      const rows = boardPart.split('/');
      if (rows.length !== 9) throw new Error('bad sfen');
      rows.forEach((rowStr, r) => {
        let c = 0;
        for (let k = 0; k < rowStr.length; k++) {
          const ch = rowStr[k];
          if (/\d/.test(ch)) { c += Number(ch); continue; }
          let promoted = false;
          let pch = ch;
          if (ch === '+') { promoted = true; pch = rowStr[++k]; }
          const t = pch.toUpperCase();
          if (!MOVES[t]) throw new Error('bad sfen piece');
          pos.board[r * 9 + c] = { c: pch === t ? BLACK : WHITE, t, p: promoted };
          c++;
        }
        if (c !== 9) throw new Error('bad sfen row');
      });
      pos.side = side === 'w' ? WHITE : BLACK;
      if (handPart && handPart !== '-') {
        let n = 0;
        for (const ch of handPart) {
          if (/\d/.test(ch)) { n = n * 10 + Number(ch); continue; }
          const t = ch.toUpperCase();
          pos.hands[ch === t ? BLACK : WHITE][t] += n || 1;
          n = 0;
        }
      }
      return pos;
    }

    toSfen(ply = 1) {
      return `${this.key()} ${ply}`;
    }

    /** 千日手判定に使う局面キー(手数を除いた SFEN) */
    key() {
      const rows = [];
      for (let r = 0; r < 9; r++) {
        let s = '';
        let empty = 0;
        for (let c = 0; c < 9; c++) {
          const pc = this.board[r * 9 + c];
          if (!pc) { empty++; continue; }
          if (empty) { s += empty; empty = 0; }
          const ch = pc.c === BLACK ? pc.t : pc.t.toLowerCase();
          s += (pc.p ? '+' : '') + ch;
        }
        if (empty) s += empty;
        rows.push(s);
      }
      let hand = '';
      for (const color of [BLACK, WHITE]) {
        for (const t of HAND_TYPES) {
          const n = this.hands[color][t];
          if (n) hand += (n > 1 ? n : '') + (color === BLACK ? t : t.toLowerCase());
        }
      }
      return `${rows.join('/')} ${this.side === BLACK ? 'b' : 'w'} ${hand || '-'}`;
    }

    clone() {
      const pos = new Position();
      pos.board = this.board.slice();
      pos.hands = [{ ...this.hands[0] }, { ...this.hands[1] }];
      pos.side = this.side;
      return pos;
    }

    kingSq(color) {
      return this.board.findIndex((pc) => pc && pc.t === 'K' && pc.c === color);
    }

    /** sq の駒が利いているマス(自駒の有無は問わない) */
    targetsFrom(sq) {
      const pc = this.board[sq];
      const dir = pc.c === BLACK ? 1 : -1;
      const r0 = rowOf(sq);
      const c0 = colOf(sq);
      const out = [];
      const mv = movesOf(pc);
      for (const [dr, dc] of mv.steps) {
        const r = r0 + dr * dir;
        const c = c0 + dc * dir;
        if (inBoard(r, c)) out.push(r * 9 + c);
      }
      for (const [dr, dc] of mv.slides) {
        let r = r0 + dr * dir;
        let c = c0 + dc * dir;
        while (inBoard(r, c)) {
          out.push(r * 9 + c);
          if (this.board[r * 9 + c]) break;
          r += dr * dir;
          c += dc * dir;
        }
      }
      return out;
    }

    isAttacked(sq, by) {
      for (let i = 0; i < 81; i++) {
        const pc = this.board[i];
        if (pc && pc.c === by && this.targetsFrom(i).includes(sq)) return true;
      }
      return false;
    }

    inCheck(color = this.side) {
      const k = this.kingSq(color);
      return k >= 0 && this.isAttacked(k, 1 - color);
    }

    /** 自玉を取られる手も含む手の一覧(二歩・行き所のない駒は除外済み) */
    pseudoMoves() {
      const me = this.side;
      const moves = [];
      for (let from = 0; from < 81; from++) {
        const pc = this.board[from];
        if (!pc || pc.c !== me) continue;
        for (const to of this.targetsFrom(from)) {
          const cap = this.board[to];
          if (cap && cap.c === me) continue;
          const canPromote = !pc.p && PROMOTABLE[pc.t] && (inZone(me, rowOf(from)) || inZone(me, rowOf(to)));
          if (canPromote) moves.push({ from, to, drop: null, promote: true });
          if (!mustPromote(pc.p ? 'G' : pc.t, me, rowOf(to))) moves.push({ from, to, drop: null, promote: false });
        }
      }
      const hand = this.hands[me];
      const pawnFiles = new Set();
      for (let i = 0; i < 81; i++) {
        const pc = this.board[i];
        if (pc && pc.c === me && pc.t === 'P' && !pc.p) pawnFiles.add(colOf(i));
      }
      for (const t of HAND_TYPES) {
        if (!hand[t]) continue;
        for (let to = 0; to < 81; to++) {
          if (this.board[to]) continue;
          if (mustPromote(t, me, rowOf(to))) continue;
          if (t === 'P' && pawnFiles.has(colOf(to))) continue; // 二歩
          moves.push({ from: null, to, drop: t, promote: false });
        }
      }
      return moves;
    }

    /** 手を指した後の新しい局面を返す(合法性は確認しない) */
    apply(m) {
      const pos = this.clone();
      const me = this.side;
      if (m.drop) {
        pos.hands[me][m.drop]--;
        pos.board[m.to] = { c: me, t: m.drop, p: false };
      } else {
        const pc = pos.board[m.from];
        const cap = pos.board[m.to];
        if (cap) pos.hands[me][cap.t]++;
        pos.board[m.from] = null;
        pos.board[m.to] = m.promote ? { c: pc.c, t: pc.t, p: true } : pc;
      }
      pos.side = 1 - me;
      return pos;
    }

    legalMoves({ checkUchifuzume = true } = {}) {
      const me = this.side;
      const out = [];
      for (const m of this.pseudoMoves()) {
        const next = this.apply(m);
        if (next.inCheck(me)) continue;
        // 打ち歩詰め
        if (checkUchifuzume && m.drop === 'P' && next.inCheck(next.side) && !next.hasLegalMove()) continue;
        out.push(m);
      }
      return out;
    }

    hasLegalMove() {
      const me = this.side;
      for (const m of this.pseudoMoves()) {
        if (!this.apply(m).inCheck(me)) return true;
      }
      return false;
    }

    findMove(usi) {
      return this.legalMoves().find((m) => moveToUsi(m) === usi) || null;
    }

    /** 棋譜表記(例: ▲７六歩(77) / △同　角成 / ▲５五角打) */
    moveToKif(m, prevTo = null) {
      const mark = this.side === BLACK ? '▲' : '△';
      const dest = m.to === prevTo ? '同　' : ZEN_DIGIT[fileOf(m.to)] + KAN_DIGIT[rankOf(m.to)];
      if (m.drop) return `${mark}${dest}${PIECE_CHAR[m.drop]}打`;
      const pc = this.board[m.from];
      const name = pc.p ? PROMOTED_NAME[pc.t] : PIECE_CHAR[pc.t];
      const me = pc.c;
      const couldPromote = !pc.p && PROMOTABLE[pc.t] && (inZone(me, rowOf(m.from)) || inZone(me, rowOf(m.to)));
      const suffix = m.promote ? '成' : couldPromote ? '不成' : '';
      return `${mark}${dest}${name}${suffix}(${fileOf(m.from)}${rankOf(m.from)})`;
    }
  }

  // ---------- 対局(履歴・終局判定) ----------

  class Game {
    constructor(sfen = STARTPOS_SFEN) {
      this.initialSfen = sfen;
      this.positions = [Position.fromSfen(sfen)];
      this.moves = [];   // 指し手
      this.kifs = [];    // 棋譜表記
      this.checks = [];  // その手が王手だったか
      this.result = null; // { winner: 0|1|null, reason }
    }

    get pos() { return this.positions[this.positions.length - 1]; }
    get ply() { return this.moves.length; }

    usiMoves() { return this.moves.map(moveToUsi); }

    /** エンジンに送る position コマンド */
    usiPosition() {
      const head = this.initialSfen === STARTPOS_SFEN ? 'position startpos' : `position sfen ${this.initialSfen}`;
      return this.moves.length ? `${head} moves ${this.usiMoves().join(' ')}` : head;
    }

    /** USI 文字列の手を指す。非合法なら false */
    playUsi(usi) {
      if (this.result) return false;
      const m = this.pos.findMove(usi);
      if (!m) return false;
      this.play(m);
      return true;
    }

    /** 合法手であることが確認済みの手を指す */
    play(m) {
      const pos = this.pos;
      const prevTo = this.moves.length ? this.moves[this.moves.length - 1].to : null;
      this.kifs.push(pos.moveToKif(m, prevTo));
      const next = pos.apply(m);
      this.moves.push(m);
      this.positions.push(next);
      this.checks.push(next.inCheck(next.side));
      this.result = this.judge();
      return this.result;
    }

    undo(n = 1) {
      for (let i = 0; i < n && this.moves.length; i++) {
        this.moves.pop();
        this.kifs.pop();
        this.checks.pop();
        this.positions.pop();
      }
      this.result = null;
    }

    resign(color) {
      this.result = { winner: 1 - color, reason: 'resign' };
    }

    judge() {
      const pos = this.pos;
      const mover = 1 - pos.side;
      if (!pos.hasLegalMove()) return { winner: mover, reason: 'checkmate' };

      const key = pos.key();
      const keys = this.positions.map((p) => p.key());
      const hits = keys.reduce((a, k, i) => (k === key ? [...a, i] : a), []);
      if (hits.length >= 4) {
        // 千日手: 同一局面4回。その間ずっと王手をかけ続けた側の負け
        const first = hits[0];
        const allChecks = (color) => {
          let any = false;
          for (let j = first; j < this.moves.length; j++) {
            if (this.positions[j].side !== color) continue;
            any = true;
            if (!this.checks[j]) return false;
          }
          return any;
        };
        if (allChecks(mover)) return { winner: 1 - mover, reason: 'perpetual-check' };
        if (allChecks(1 - mover)) return { winner: mover, reason: 'perpetual-check' };
        return { winner: null, reason: 'sennichite' };
      }
      if (this.moves.length >= MAX_MOVES) return { winner: null, reason: 'max-moves' };
      return null;
    }
  }

  function perft(pos, depth) {
    if (depth === 0) return 1;
    const moves = pos.legalMoves();
    if (depth === 1) return moves.length;
    let n = 0;
    for (const m of moves) n += perft(pos.apply(m), depth - 1);
    return n;
  }

  return {
    BLACK,
    WHITE,
    HAND_TYPES,
    STARTPOS_SFEN,
    MAX_MOVES,
    PIECE_CHAR,
    PROMOTED_CHAR,
    ZEN_DIGIT,
    KAN_DIGIT,
    Position,
    Game,
    moveToUsi,
    sqToUsi,
    usiToSq,
    fileOf,
    rankOf,
    rowOf,
    colOf,
    inZone,
    mustPromote,
    perft,
  };
});
