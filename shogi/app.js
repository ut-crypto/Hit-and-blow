'use strict';

const { Game, BLACK, WHITE, HAND_TYPES, PIECE_CHAR, PROMOTED_CHAR, ZEN_DIGIT, KAN_DIGIT, moveToUsi } = ShogiCore;
const { LEVELS, CpuPlayer, Evaluator } = ShogiEngine;

const PEER_PREFIX = 'ut-crypto-shogi-';
const COLOR_NAME = ['▲先手', '△後手'];
const $ = (sel) => document.querySelector(sel);

const app = {
  mode: null,          // 'cpu' | 'online' | 'local'
  game: null,
  myColor: BLACK,      // cpu / online で自分の手番
  flipped: false,
  selected: null,      // { from: sq } | { drop: 'P' など }
  legalCache: null,    // { ply, moves }
  // CPU
  level: 'normal',
  maxTimeMs: 5000,
  colorChoice: '0',
  cpu: null,
  cpuThinking: false,
  thinkText: '',
  // 形勢バー
  showEval: loadPref('shogi-evalbar', true),
  evalInfo: null,      // { blackScore, mate: 'black'|'white'|null }
  evalUnavailable: '',
  token: 0,            // 対局ごとに増やし、古い非同期処理の結果を捨てる
  loading: false,
  // オンライン
  roomKey: '',
  hostColor: BLACK,
  myRematch: false,
  oppRematch: false,
  notice: '',
  lastMoveSq: null,
};

// ---------- 共通 ----------

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

function loadPref(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === '1';
  } catch {
    return fallback;
  }
}

function savePref(key, value) {
  try { localStorage.setItem(key, value ? '1' : '0'); } catch { /* 無視 */ }
}

let noticeTimer = null;
function flash(text) {
  app.notice = text;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { app.notice = ''; render(); }, 3000);
  render();
}

function legalMoves() {
  const g = app.game;
  if (!app.legalCache || app.legalCache.ply !== g.ply || app.legalCache.game !== g) {
    app.legalCache = { game: g, ply: g.ply, moves: g.pos.legalMoves() };
  }
  return app.legalCache.moves;
}

function isHumanTurn() {
  const g = app.game;
  if (!g || g.result || app.cpuThinking || app.loading) return false;
  return app.mode === 'local' || g.pos.side === app.myColor;
}

function bottomColor() {
  return app.flipped ? WHITE : BLACK;
}

function newGame(myColor) {
  app.token++;
  app.game = new Game();
  app.myColor = myColor;
  app.flipped = app.mode !== 'local' && myColor === WHITE;
  app.selected = null;
  app.legalCache = null;
  app.lastMoveSq = null;
  app.cpuThinking = false;
  app.thinkText = '';
  app.evalInfo = null;
  app.myRematch = false;
  app.oppRematch = false;
  showPlay();
  requestEval();
}

function showPlay() {
  $('#screen-menu').classList.add('hidden');
  $('#screen-play').classList.remove('hidden');
  render();
}

function showMenu() {
  app.token++;
  if (app.cpu) app.cpu.abort();
  leaveOnline();
  app.mode = null;
  app.game = null;
  app.loading = false;
  app.cpuThinking = false;
  if (evaluator) evaluator.cancel();
  $('#loading').classList.add('hidden');
  $('#screen-play').classList.add('hidden');
  $('#screen-menu').classList.remove('hidden');
  closePromotion(null);
}

// ---------- 指し手 ----------

function sameOrigin(m, sel) {
  return sel.drop ? m.drop === sel.drop : m.from === sel.from;
}

async function onCellClick(sq) {
  if (!isHumanTurn()) return;
  const pos = app.game.pos;
  const sel = app.selected;
  if (sel) {
    const cands = legalMoves().filter((m) => sameOrigin(m, sel) && m.to === sq);
    if (cands.length) {
      let move = cands[0];
      if (cands.length > 1) {
        const pc = pos.board[sel.from];
        const promote = await askPromotion(pc);
        if (promote === null) return;
        move = cands.find((m) => m.promote === promote);
      }
      humanPlay(move);
      return;
    }
  }
  const pc = pos.board[sq];
  if (pc && pc.c === pos.side && !(sel && sel.from === sq)) {
    app.selected = { from: sq };
  } else {
    app.selected = null;
  }
  render();
}

function onHandClick(color, type) {
  if (!isHumanTurn() || color !== app.game.pos.side) return;
  const sel = app.selected;
  app.selected = sel && sel.drop === type ? null : { drop: type };
  render();
}

function humanPlay(move) {
  const g = app.game;
  const ply = g.ply;
  g.play(move);
  app.selected = null;
  app.lastMoveSq = move.to;
  if (app.mode === 'online') room.send({ type: 'move', usi: moveToUsi(move), ply });
  afterMove();
}

function afterMove() {
  render();
  if (app.game.result) return;
  requestEval();
  if (app.mode === 'cpu') cpuMove();
}

// ---------- 成り選択 ----------

let promoResolve = null;
function askPromotion(pc) {
  const face = (promoted) => {
    const f = promoted ? $('#promo-yes-face') : $('#promo-no-face');
    f.textContent = promoted ? PROMOTED_CHAR[pc.t] : PIECE_CHAR[pc.t];
    f.className = `piece-face ${pc.c === BLACK ? 'black' : 'white'}${promoted ? ' promoted' : ''}`;
  };
  face(true);
  face(false);
  $('#promo').classList.remove('hidden');
  $('#promo-yes').focus();
  return new Promise((resolve) => { promoResolve = resolve; });
}

function closePromotion(value) {
  $('#promo').classList.add('hidden');
  if (promoResolve) {
    const r = promoResolve;
    promoResolve = null;
    r(value);
  }
}

// ---------- CPU 対戦 ----------

async function startCpuGame() {
  const choice = app.colorChoice;
  const myColor = choice === 'random' ? (Math.random() < 0.5 ? BLACK : WHITE) : Number(choice);
  app.mode = 'cpu';
  newGame(myColor);
  const token = app.token;
  const level = LEVELS[app.level];

  if (!app.cpu || app.cpu.levelKey !== app.level) {
    if (app.cpu) app.cpu.abort();
    app.cpu = new CpuPlayer(app.level, { maxTimeMs: app.maxTimeMs, onInfo: onThinkInfo });
  }
  app.cpu.maxTimeMs = app.maxTimeMs;

  app.loading = true;
  $('#loading').classList.remove('hidden');
  setLoading(`${level.label} のエンジンを準備中…`, 0);
  render();
  try {
    await app.cpu.init((loaded, total) => {
      const mb = (n) => (n / 1048576).toFixed(1);
      setLoading(
        total ? `エンジンを読み込み中… ${mb(loaded)} / ${mb(total)} MB` : `エンジンを読み込み中… ${mb(loaded)} MB`,
        total ? loaded / total : 0,
      );
    });
  } catch (err) {
    if (token !== app.token) return;
    app.cpu = null;
    showMenu();
    $('#cpu-status').textContent = err.message || String(err);
    $('#cpu-status').classList.add('error');
    return;
  }
  if (token !== app.token) return;
  app.loading = false;
  $('#loading').classList.add('hidden');
  render();
  cpuMove();
}

function setLoading(label, ratio) {
  $('#loading-label').textContent = label;
  $('#loading-bar').style.width = `${Math.round(ratio * 100)}%`;
}

async function cpuMove() {
  const g = app.game;
  if (app.mode !== 'cpu' || !g || g.result || g.pos.side === app.myColor || app.cpuThinking) return;
  const token = app.token;
  const ply = g.ply;
  app.cpuThinking = true;
  app.thinkText = '';
  render();
  let res;
  try {
    res = await app.cpu.think(g);
  } catch (err) {
    if (token === app.token) flash(`CPU エラー: ${err.message || err}`);
    return;
  } finally {
    if (token === app.token) app.cpuThinking = false;
  }
  if (token !== app.token || g.ply !== ply) return;
  if (res.move === 'resign') {
    g.resign(1 - app.myColor);
  } else if (!g.playUsi(res.move)) {
    flash(`CPU が不正な手を返しました: ${res.move}`);
    render();
    return;
  } else {
    app.lastMoveSq = g.moves[g.moves.length - 1].to;
  }
  render();
  if (!g.result) {
    app.cpu.startPonder(g, res.ponder);
    requestEval();
  }
}

let thinkRenderPending = false;
function onThinkInfo(info) {
  if (!app.cpuThinking || !info.depth) return;
  if (cpuProvidesEval() && info.score !== null && !info.bound) {
    const cpuColor = 1 - app.myColor;
    const blackScore = cpuColor === BLACK ? info.score : -info.score;
    const mate = info.mate === null ? null : (blackScore > 0 ? 'black' : 'white');
    app.evalInfo = { blackScore, mate };
    scheduleEvalRender();
  }
  const lv = app.level;
  if (lv !== 'hard' && lv !== 'max' && lv !== 'ultra') return;
  let evalText = '';
  if (info.solver) {
    evalText = `詰将棋ソルバーが${info.mate}手詰を発見`;
  } else if (info.mate !== null) {
    const n = parseInt(info.mate, 10);
    evalText = n > 0 || info.mate === '+' ? '詰みを発見' : 'CPU が詰まされる筋';
  } else if (info.score !== null) {
    const mine = -info.score; // エンジンの評価値は CPU 視点
    evalText = `評価値(あなた視点) ${mine > 0 ? '+' : ''}${mine}`;
  }
  app.thinkText = `読み 深さ${info.depth}  ${evalText}`;
  if (!thinkRenderPending) {
    thinkRenderPending = true;
    requestAnimationFrame(() => {
      thinkRenderPending = false;
      $('#think-info').textContent = app.cpuThinking ? app.thinkText : '';
    });
  }
}

async function undo() {
  const g = app.game;
  if (!g || app.loading) return;
  if (app.mode === 'local') {
    if (!g.ply || (g.result && g.result.reason === 'resign')) return;
    g.undo(1);
  } else if (app.mode === 'cpu') {
    if (app.cpuThinking) return;
    if (g.result && g.result.reason === 'resign') return;
    const myMoves = g.positions.slice(0, -1).filter((p) => p.side === app.myColor).length;
    if (!myMoves) return;
    await app.cpu.cancel();
    do { g.undo(1); } while (g.ply > 0 && g.pos.side !== app.myColor);
  } else {
    return;
  }
  app.selected = null;
  app.lastMoveSq = g.ply ? g.moves[g.ply - 1].to : null;
  app.evalInfo = null;
  render();
  requestEval();
}

function resign() {
  const g = app.game;
  if (!g || g.result) return;
  if (!confirm('投了しますか?')) return;
  if (app.mode === 'local') {
    g.resign(g.pos.side);
  } else {
    g.resign(app.myColor);
    if (app.mode === 'cpu' && app.cpu) app.cpu.abort();
    if (app.mode === 'online') room.send({ type: 'resign' });
  }
  app.cpuThinking = false;
  app.token++;
  render();
}

// ---------- オンライン対戦 ----------

const room = OnlineRoom.create(PEER_PREFIX, {
  onStatus(text, { error = false, busy = false, hosting = false }) {
    setOnlineStatus(text, error);
    setJoining(busy);
    $('#btn-copy-link').classList.toggle('hidden', !hosting);
  },
  onConnect(role) {
    setJoining(false);
    setOnlineStatus('');
    app.mode = 'online';
    if (role === 'host') {
      startOnlineGame(Math.random() < 0.5 ? BLACK : WHITE);
    } else {
      app.game = null;
      showPlay();
    }
  },
  onData: onMessage,
  onDisconnect() {
    const g = app.game;
    if (app.mode === 'online' && g && !g.result) g.result = { winner: null, reason: 'disconnect' };
    flash('相手との接続が切れました');
  },
  onFull() {
    showMenu();
    setOnlineStatus('このルームは満員です。別のルームキーを使ってください', true);
  },
  onError: flash,
});

function setOnlineStatus(text, isError = false) {
  const s = $('#online-status');
  s.textContent = text;
  s.classList.toggle('error', isError);
}

function setJoining(joining) {
  $('#btn-join').disabled = joining;
  $('#room-key').disabled = joining;
  $('#btn-cancel-join').classList.toggle('hidden', !joining);
  if (!joining) $('#btn-copy-link').classList.add('hidden');
}

function leaveOnline() {
  room.leave();
  setJoining(false);
}

function startOnlineGame(hostColor) {
  app.hostColor = hostColor;
  room.send({ type: 'start', hostColor });
  newGame(hostColor);
}

function onMessage(msg) {
  if (!msg || typeof msg !== 'object' || app.mode !== 'online') return;
  const g = app.game;
  switch (msg.type) {
    case 'start':
      if (room.role !== 'guest' || (msg.hostColor !== BLACK && msg.hostColor !== WHITE)) return;
      app.hostColor = msg.hostColor;
      newGame(1 - msg.hostColor);
      return;
    case 'move':
      if (!g || g.result || g.pos.side === app.myColor || msg.ply !== g.ply) return;
      if (!g.playUsi(String(msg.usi))) {
        flash('相手から不正な手を受信しました');
        return;
      }
      app.lastMoveSq = g.moves[g.ply - 1].to;
      app.selected = null;
      afterMove();
      return;
    case 'resign':
      if (!g || g.result) return;
      g.resign(1 - app.myColor);
      break;
    case 'rematch':
      app.oppRematch = true;
      maybeRematch();
      break;
    default:
      return;
  }
  render();
}

function requestRematch() {
  if (!app.game || !app.game.result || !room.isOpen) return;
  app.myRematch = true;
  room.send({ type: 'rematch' });
  maybeRematch();
  render();
}

function maybeRematch() {
  if (app.myRematch && app.oppRematch && room.role === 'host') startOnlineGame(1 - app.hostColor);
}

// ---------- 形勢バー ----------

let evaluator = null;
let evaluatorReady = null;

/** 最強・極では CPU 自身の読みの評価値を使う(別エンジンを動かさない) */
function cpuProvidesEval() {
  return app.mode === 'cpu' && LEVELS[app.level].engine === 'halfkp';
}

function requestEval() {
  const g = app.game;
  if (!app.showEval || !g || g.result || cpuProvidesEval() || app.evalUnavailable) return;
  if (!evaluatorReady) {
    evaluator = new Evaluator(onEval);
    evaluatorReady = evaluator.init().catch((err) => {
      app.evalUnavailable = err.message || String(err);
      evaluatorReady = null;
      renderEvalBar();
      throw err;
    });
  }
  evaluatorReady.then(() => {
    if (app.game === g) evaluator.request(g);
  }).catch(() => {});
}

function onEval(e) {
  const g = app.game;
  if (!g || e.ply !== g.ply || cpuProvidesEval()) return;
  app.evalInfo = { blackScore: e.blackScore, mate: e.mate };
  scheduleEvalRender();
}

let evalRenderPending = false;
function scheduleEvalRender() {
  if (evalRenderPending) return;
  evalRenderPending = true;
  requestAnimationFrame(() => {
    evalRenderPending = false;
    renderEvalBar();
  });
}

/** 評価値(歩=100)から勝率の目安へ */
const winRate = (cp) => 1 / (1 + Math.exp(-cp / 600));

function judgeText(cp) {
  const a = Math.abs(cp);
  const [good, bad] = a < 150 ? ['互角', '互角']
    : a < 400 ? ['やや有利', 'やや不利']
      : a < 900 ? ['有利', '不利']
        : a < 2000 ? ['優勢', '劣勢'] : ['勝勢', '敗勢'];
  return cp >= 0 ? good : bad;
}

function renderEvalBar() {
  const bar = $('#evalbar');
  const g = app.game;
  const visible = app.showEval && !!g && !!app.mode;
  bar.classList.toggle('hidden', !visible);
  if (!visible) return;
  const persp = app.mode === 'local' ? bottomColor() : app.myColor;
  const who = app.mode === 'local' ? `${COLOR_NAME[persp]}から見た形勢` : 'あなたから見た形勢';
  let pct = 50;
  let label = '';
  let num = '';
  let losing = false;
  let pending = false;
  if (g.result && g.result.reason !== 'disconnect') {
    const w = g.result.winner;
    pct = w === null ? 50 : w === persp ? 100 : 0;
    label = w === null ? '引き分け' : w === persp ? '勝ち' : '負け';
    losing = w !== null && w !== persp;
  } else if (app.evalUnavailable && !cpuProvidesEval()) {
    label = '利用できません';
    num = 'このブラウザでは評価エンジンが動きません';
    pending = true;
  } else if (!app.evalInfo) {
    label = '評価中…';
    pending = true;
  } else {
    const { blackScore, mate } = app.evalInfo;
    const s = persp === BLACK ? blackScore : -blackScore;
    if (mate) {
      const mine = mate === (persp === BLACK ? 'black' : 'white');
      pct = mine ? 100 : 0;
      label = mine ? '勝ち筋(詰みあり)' : '負け筋(詰まされる)';
      losing = !mine;
    } else {
      pct = winRate(s) * 100;
      label = judgeText(s);
      losing = s <= -150;
      num = `${Math.round(pct)}%  (${s > 0 ? '+' : ''}${s})`;
    }
  }
  bar.className = `evalbar ${persp === BLACK ? 'black' : 'white'}${losing ? ' losing' : ''}${pending ? ' pending' : ''}`;
  $('#eval-who').textContent = who;
  $('#eval-label').textContent = label;
  $('#eval-num').textContent = num;
  $('#eval-fill').style.width = `${pct.toFixed(1)}%`;
}

// ---------- 描画 ----------

const cells = [];

function buildBoard() {
  const board = $('#board');
  for (let d = 0; d < 81; d++) {
    const b = el('button', 'cell');
    b.addEventListener('click', () => onCellClick(app.flipped ? 80 - d : d));
    board.appendChild(b);
    cells.push(b);
  }
}

function pieceFace(pc, viewerBottom) {
  const char = pc.p ? PROMOTED_CHAR[pc.t] : pc.t === 'K' ? (pc.c === BLACK ? '玉' : '王') : PIECE_CHAR[pc.t];
  const cls = [
    'piece-face',
    pc.c === BLACK ? 'black' : 'white',
    pc.c !== viewerBottom ? 'flip' : '',
    pc.p ? 'promoted' : '',
    pc.t === 'K' ? 'king' : '',
  ].filter(Boolean).join(' ');
  return { char, cls };
}

function renderBoard() {
  const g = app.game;
  const bottom = bottomColor();
  const files = $('#files');
  const ranks = $('#ranks');
  files.replaceChildren(...Array.from({ length: 9 }, (_, i) => el('span', '', ZEN_DIGIT[app.flipped ? i + 1 : 9 - i])));
  ranks.replaceChildren(...Array.from({ length: 9 }, (_, i) => el('span', '', KAN_DIGIT[app.flipped ? 9 - i : i + 1])));

  const pos = g ? g.pos : null;
  const sel = app.selected;
  const targets = new Map();
  if (g && sel) {
    for (const m of legalMoves()) if (sameOrigin(m, sel)) targets.set(m.to, true);
  }
  const checkedKing = pos && pos.inCheck() ? pos.kingSq(pos.side) : -1;
  const human = isHumanTurn();

  for (let d = 0; d < 81; d++) {
    const sq = app.flipped ? 80 - d : d;
    const cell = cells[d];
    const pc = pos ? pos.board[sq] : null;
    const cls = ['cell'];
    if (sq === app.lastMoveSq) cls.push('last', 'moved');
    if (sel && sel.from === sq) cls.push('selected');
    if (targets.has(sq)) cls.push('target', pc ? 'capture' : '');
    if (sq === checkedKing) cls.push('checked');
    cell.className = cls.filter(Boolean).join(' ');
    cell.disabled = !human;
    const sig = pc ? `${pc.c}${pc.t}${pc.p}${bottom}` : '';
    if (cell.dataset.sig !== sig) {
      cell.dataset.sig = sig;
      cell.replaceChildren();
      if (pc) {
        const f = pieceFace(pc, bottom);
        cell.appendChild(el('span', f.cls, f.char));
      }
    }
    const file = 9 - (sq % 9);
    const rank = Math.floor(sq / 9) + 1;
    cell.setAttribute('aria-label', `${file}${KAN_DIGIT[rank]}${pc ? ` ${pc.c === BLACK ? '先手' : '後手'}${pc.p ? '成' : ''}${PIECE_CHAR[pc.t]}` : ''}`);
  }
}

function playerLabel(color) {
  if (app.mode === 'local') return COLOR_NAME[color];
  if (color === app.myColor) return `${COLOR_NAME[color]} あなた`;
  return `${COLOR_NAME[color]} ${app.mode === 'cpu' ? `CPU(${LEVELS[app.level].label})` : '相手'}`;
}

function renderHand(target, color) {
  const g = app.game;
  target.replaceChildren(el('span', 'hand-label', g ? playerLabel(color) : ''));
  target.classList.toggle('turn', !!(g && !g.result && g.pos.side === color));
  if (!g) return;
  const hand = g.pos.hands[color];
  const bottom = bottomColor();
  let any = false;
  for (const t of HAND_TYPES) {
    const n = hand[t];
    if (!n) continue;
    any = true;
    const b = el('button', 'hand-piece');
    const f = pieceFace({ c: color, t, p: false }, bottom);
    b.appendChild(el('span', f.cls, f.char));
    if (n > 1) b.appendChild(el('span', 'count', String(n)));
    if (app.selected && app.selected.drop === t && g.pos.side === color) b.classList.add('selected');
    b.disabled = !(isHumanTurn() && g.pos.side === color);
    b.setAttribute('aria-label', `持ち駒 ${PIECE_CHAR[t]} ${n}枚`);
    b.addEventListener('click', () => onHandClick(color, t));
    target.appendChild(b);
  }
  if (!any) target.appendChild(el('span', 'hand-empty', 'なし'));
}

function renderKifu() {
  const g = app.game;
  const list = $('#kifu');
  list.replaceChildren();
  if (!g || !g.kifs.length) {
    list.appendChild(el('li', 'empty', '— 開始局面 —'));
    return;
  }
  g.kifs.forEach((k, i) => {
    const li = el('li', i === g.kifs.length - 1 ? 'latest' : '');
    li.append(el('span', 'no', String(i + 1)), el('span', '', k));
    list.appendChild(li);
  });
  list.scrollTop = list.scrollHeight;
}

const REASON_TEXT = {
  checkmate: '詰み',
  resign: '投了',
  sennichite: '千日手',
  'perpetual-check': '連続王手の千日手',
  'max-moves': `${ShogiCore.MAX_MOVES}手到達`,
  disconnect: '接続切れ',
};

function renderResult() {
  const g = app.game;
  const box = $('#result');
  box.classList.toggle('hidden', !(g && g.result));
  if (!g || !g.result) return;
  const { winner, reason } = g.result;
  let title;
  let cls;
  if (reason === 'disconnect') {
    title = '対局が中断されました';
    cls = 'draw';
  } else if (winner === null) {
    title = '引き分け';
    cls = 'draw';
  } else if (app.mode === 'local') {
    title = `${COLOR_NAME[winner]}の勝ち`;
    cls = 'win';
  } else if (winner === app.myColor) {
    title = 'あなたの勝ち!';
    cls = 'win';
  } else {
    title = 'あなたの負け';
    cls = 'lose';
  }
  const sub = reason === 'resign'
    ? `${g.ply}手まで ${COLOR_NAME[1 - winner]}の投了`
    : `${g.ply}手 ${REASON_TEXT[reason] || reason}`;
  const nodes = [el('div', `result-title ${cls}`, title), el('div', 'result-sub', sub)];
  if (app.mode === 'online' && reason !== 'disconnect') {
    if (app.myRematch && !app.oppRematch) nodes.push(el('div', 'result-sub', '相手の再戦待ち…'));
    else if (app.oppRematch && !app.myRematch) nodes.push(el('div', 'result-sub', '相手が再戦を希望しています'));
  }
  box.replaceChildren(...nodes);
}

function messageState() {
  const g = app.game;
  if (app.loading) return ['wait', 'エンジンを準備中…'];
  if (!g) return ['wait', '対局の準備中…'];
  if (g.result) return ['', ''];
  const check = g.pos.inCheck();
  const pre = check ? '王手! ' : '';
  const cls = check ? 'check' : '';
  if (app.mode === 'local') return [cls || 'mine', `${pre}${COLOR_NAME[g.pos.side]}の番です`];
  if (g.pos.side === app.myColor) return [cls || 'mine', `${pre}あなたの番です`];
  if (app.mode === 'cpu') return ['wait', 'CPU が考えています…'];
  return ['wait', '相手の番です…'];
}

function renderInfo() {
  const info = $('#play-info');
  const chips = [];
  if (app.mode === 'cpu') chips.push(el('span', 'chip', `CPU 対戦: ${LEVELS[app.level].label}${app.level === 'max' ? `(最大${app.maxTimeMs / 1000}秒)` : ''}`));
  if (app.mode === 'online') chips.push(el('span', 'chip', `ルーム: ${app.roomKey}`));
  if (app.mode === 'local') chips.push(el('span', 'chip', 'ふたりで対局'));
  if (app.game && app.mode !== 'local') {
    chips.push(el('span', `chip ${app.myColor === BLACK ? 'sente' : 'gote'}`, `あなた: ${COLOR_NAME[app.myColor]}`));
  }
  if (app.game) chips.push(el('span', 'chip', `${app.game.ply}手`));
  info.replaceChildren(...chips);
}

function render() {
  if (!app.mode) return;
  const g = app.game;
  renderInfo();
  const [cls, text] = messageState();
  const msg = $('#message');
  msg.className = `message ${cls}`;
  msg.textContent = text;
  $('#notice').textContent = app.notice;

  const bottom = bottomColor();
  renderHand($('#hand-top'), 1 - bottom);
  renderHand($('#hand-bottom'), bottom);
  renderBoard();
  renderKifu();
  renderResult();
  $('#think-info').textContent = app.cpuThinking ? app.thinkText : '';

  const over = !!(g && g.result);
  const canUndo = g && !app.loading && !app.cpuThinking && (app.mode === 'local' || app.mode === 'cpu') && g.ply > 0
    && !(g.result && (g.result.reason === 'resign'));
  $('#btn-undo').classList.toggle('hidden', app.mode === 'online');
  $('#btn-undo').disabled = !canUndo;
  $('#btn-resign').classList.toggle('hidden', !g || over);
  $('#btn-resign').disabled = app.loading;
  $('#btn-again').classList.toggle('hidden', !(over && app.mode !== 'online'));
  $('#btn-rematch').classList.toggle('hidden', !(over && app.mode === 'online' && g.result.reason !== 'disconnect'));
  $('#btn-rematch').disabled = app.myRematch || !room.isOpen;
  $('#btn-copy-kifu').disabled = !g || !g.ply;
  $('#btn-evalbar').textContent = app.showEval ? '形勢バーを隠す' : '形勢バーを表示';
  renderEvalBar();
}

// ---------- 棋譜コピー ----------

function kifText() {
  const g = app.game;
  const names = [playerLabel(BLACK).replace('▲先手 ', ''), playerLabel(WHITE).replace('△後手 ', '')];
  const lines = ['# KIF形式棋譜', '手合割：平手', `先手：${names[0]}`, `後手：${names[1]}`, '手数----指手---------消費時間--'];
  g.kifs.forEach((k, i) => lines.push(`${String(i + 1).padStart(4)} ${k.slice(1)}`));
  if (g.result) {
    const end = { resign: '投了', sennichite: '千日手', 'perpetual-check': '反則負け', checkmate: '詰み', 'max-moves': '持将棋', disconnect: '中断' }[g.result.reason];
    if (end) lines.push(`${String(g.ply + 1).padStart(4)} ${end}`);
  }
  return `${lines.join('\n')}\n`;
}

// ---------- イベント ----------

function buildMenu() {
  const levels = $('#levels');
  Object.entries(LEVELS).forEach(([key, lv], i) => {
    const b = el('button', 'level-btn');
    b.dataset.level = key;
    b.append(el('span', 'lv', `LV.${i + 1}`), el('span', '', lv.label));
    b.addEventListener('click', () => { app.level = key; syncMenu(); });
    levels.appendChild(b);
  });
  $('#time-seg').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    app.maxTimeMs = Number(b.dataset.ms);
    syncMenu();
  });
  $('#color-seg').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    app.colorChoice = b.dataset.color;
    syncMenu();
  });
  syncMenu();
}

function syncMenu() {
  document.querySelectorAll('.level-btn').forEach((b) => b.classList.toggle('on', b.dataset.level === app.level));
  $('#level-note').textContent = LEVELS[app.level].note;
  $('#time-row').classList.toggle('hidden', LEVELS[app.level].engine !== 'halfkp');
  document.querySelectorAll('#time-seg button').forEach((b) => b.classList.toggle('on', Number(b.dataset.ms) === app.maxTimeMs));
  document.querySelectorAll('#color-seg button').forEach((b) => b.classList.toggle('on', b.dataset.color === app.colorChoice));
}

function init() {
  buildBoard();
  buildMenu();

  $('#btn-cpu').addEventListener('click', () => {
    $('#cpu-status').textContent = '';
    $('#cpu-status').classList.remove('error');
    startCpuGame();
  });
  $('#btn-local').addEventListener('click', () => {
    app.mode = 'local';
    newGame(BLACK);
  });
  $('#btn-join').addEventListener('click', () => {
    app.roomKey = $('#room-key').value.trim();
    room.join(app.roomKey);
  });
  $('#room-key').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btn-join').click(); });
  $('#btn-cancel-join').addEventListener('click', () => { leaveOnline(); setOnlineStatus(''); });
  $('#btn-copy-link').addEventListener('click', async () => {
    const url = new URL(location.href);
    url.search = '';
    url.hash = '';
    url.searchParams.set('room', app.roomKey);
    try {
      await navigator.clipboard.writeText(url.toString());
      setOnlineStatus('招待リンクをコピーしました。相手に送ってください');
    } catch {
      setOnlineStatus(`招待リンク: ${url}`);
    }
  });

  $('#btn-undo').addEventListener('click', undo);
  $('#btn-flip').addEventListener('click', () => { app.flipped = !app.flipped; render(); });
  $('#btn-evalbar').addEventListener('click', () => {
    app.showEval = !app.showEval;
    savePref('shogi-evalbar', app.showEval);
    render();
    requestEval();
  });
  $('#btn-resign').addEventListener('click', resign);
  $('#btn-again').addEventListener('click', () => {
    if (app.mode === 'cpu') startCpuGame();
    else if (app.mode === 'local') newGame(BLACK);
  });
  $('#btn-rematch').addEventListener('click', requestRematch);
  $('#btn-leave').addEventListener('click', () => {
    const playing = app.game && !app.game.result && app.game.ply > 0;
    if (playing && !confirm('対局をやめてメニューに戻りますか?')) return;
    showMenu();
  });
  $('#btn-copy-kifu').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(kifText());
      flash('棋譜をコピーしました');
    } catch {
      flash('コピーできませんでした');
    }
  });

  $('#promo-yes').addEventListener('click', () => closePromotion(true));
  $('#promo-no').addEventListener('click', () => closePromotion(false));
  $('#promo').addEventListener('click', (e) => { if (e.target.id === 'promo') closePromotion(null); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (promoResolve) closePromotion(null);
      else if (app.selected) { app.selected = null; render(); }
    }
  });

  window.addEventListener('beforeunload', () => leaveOnline());

  const roomParam = new URLSearchParams(location.search).get('room');
  if (roomParam) $('#room-key').value = roomParam;
}

init();
