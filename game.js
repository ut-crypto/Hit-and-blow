'use strict';

const LEN = 5;
const PEER_PREFIX = 'ut-crypto-hab5-';
const CONNECT_TIMEOUT_MS = 15000;

const $ = (sel) => document.querySelector(sel);

const state = {
  mode: null,          // 'solo' | 'online'
  phase: 'menu',       // 'menu' | 'setup' | 'waiting' | 'play' | 'over'
  entry: '',
  mySecret: null,
  oppSecret: null,     // solo: CPU の数字 / online: 決着後に公開された相手の数字
  myGuesses: [],       // { guess, hit, blow }
  oppGuesses: [],
  myTurn: false,
  iAmFirst: true,
  myReady: false,
  oppReady: false,
  pendingGuess: null,
  outcome: null,       // 'win' | 'lose' | 'draw' | 'giveup' | 'disconnected'
  cheatSuspected: false,
  myRematch: false,
  oppRematch: false,
  roomKey: '',
  memo: Array(10).fill(0),
  notice: '',
};

// ---------- ゲームロジック ----------

function judge(secret, guess) {
  let hit = 0;
  let blow = 0;
  for (let i = 0; i < LEN; i++) {
    if (guess[i] === secret[i]) hit++;
    else if (secret.includes(guess[i])) blow++;
  }
  return { hit, blow };
}

function isValidNumber(s) {
  return typeof s === 'string' && /^\d{5}$/.test(s) && new Set(s).size === LEN;
}

function randomSecret() {
  const d = [...'0123456789'];
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d.slice(0, LEN).join('');
}

function solved(list) {
  return list.some((g) => g.hit === LEN);
}

function resetMatch() {
  Object.assign(state, {
    phase: 'menu',
    entry: '',
    mySecret: null,
    oppSecret: null,
    myGuesses: [],
    oppGuesses: [],
    myTurn: false,
    iAmFirst: true,
    myReady: false,
    oppReady: false,
    pendingGuess: null,
    outcome: null,
    cheatSuspected: false,
    myRematch: false,
    oppRematch: false,
    memo: Array(10).fill(0),
    notice: '',
  });
}

function startSolo() {
  leaveOnline();
  resetMatch();
  state.mode = 'solo';
  state.oppSecret = randomSecret();
  state.phase = 'play';
  state.myTurn = true;
  render();
}

function finish(outcome) {
  state.phase = 'over';
  state.outcome = outcome;
  state.myTurn = false;
  if (state.mode === 'online') send({ type: 'reveal', secret: state.mySecret });
}

// ---------- 入力 ----------

function canInput() {
  return state.phase === 'setup' || (state.phase === 'play' && state.myTurn);
}

function pushDigit(d) {
  if (!canInput() || state.entry.length >= LEN || state.entry.includes(d)) return;
  state.entry += d;
  render();
}

function popDigit() {
  if (!canInput()) return;
  state.entry = state.entry.slice(0, -1);
  render();
}

function clearEntry() {
  if (!canInput()) return;
  state.entry = '';
  render();
}

let noticeTimer = null;
function flash(text) {
  state.notice = text;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { state.notice = ''; render(); }, 2500);
  render();
}

function submitEntry() {
  if (!canInput()) return;
  const v = state.entry;
  if (!isValidNumber(v)) {
    flash('重複のない5桁の数字を入力してください');
    return;
  }
  state.entry = '';

  if (state.phase === 'setup') {
    state.mySecret = v;
    state.myReady = true;
    state.phase = 'waiting';
    send({ type: 'ready' });
    if (role === 'host') maybeStart();
  } else if (state.mode === 'solo') {
    const r = judge(state.oppSecret, v);
    state.myGuesses.push({ guess: v, ...r });
    if (r.hit === LEN) finish('win');
  } else {
    state.pendingGuess = v;
    state.myTurn = false;
    send({ type: 'guess', guess: v });
  }
  render();
}

// ---------- オンライン(PeerJS) ----------

let peer = null;
let conn = null;
let role = null;      // 'host' | 'guest'
let connectTimer = null;

async function roomIdFromKey(key) {
  const normalized = key.normalize('NFKC').trim().toLowerCase();
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalized));
  const hex = [...new Uint8Array(buf)].slice(0, 12).map((b) => b.toString(16).padStart(2, '0')).join('');
  return PEER_PREFIX + hex;
}

function setOnlineStatus(text, isError = false) {
  const el = $('#online-status');
  el.textContent = text;
  el.classList.toggle('error', isError);
}

function setJoining(joining) {
  $('#btn-join').disabled = joining;
  $('#room-key').disabled = joining;
  $('#btn-cancel-join').classList.toggle('hidden', !joining);
  if (!joining) $('#btn-copy-link').classList.add('hidden');
}

async function joinRoom() {
  const key = $('#room-key').value.trim();
  if (!key) {
    setOnlineStatus('ルームキーを入力してください', true);
    return;
  }
  if (typeof Peer === 'undefined') {
    setOnlineStatus('通信ライブラリ(PeerJS)を読み込めませんでした。ページを再読み込みしてください', true);
    return;
  }
  if (!window.crypto || !crypto.subtle) {
    setOnlineStatus('https で開いてください(オンライン対戦は https が必要です)', true);
    return;
  }
  leaveOnline();
  state.roomKey = key;
  setJoining(true);
  setOnlineStatus('接続中…');

  const roomId = await roomIdFromKey(key);
  const p = new Peer(roomId);
  peer = p;

  p.on('open', () => {
    if (peer !== p) return;
    role = 'host';
    setOnlineStatus(`ルーム「${key}」を作成しました。相手の入室を待っています…`);
    $('#btn-copy-link').classList.remove('hidden');
  });
  p.on('connection', (c) => {
    if (peer !== p) return;
    if (conn) {
      c.on('open', () => {
        c.send({ type: 'full' });
        setTimeout(() => c.close(), 500);
      });
      return;
    }
    attachConn(c);
  });
  p.on('disconnected', () => {
    // 待機中にシグナリングサーバーとの接続が切れたら再接続する
    if (peer === p && !p.destroyed && !conn) p.reconnect();
  });
  p.on('error', (err) => {
    if (peer !== p) return;
    if (err.type === 'unavailable-id') {
      // 同じキーのルームが既にある → ゲストとして参加
      p.destroy();
      joinAsGuest(roomId, key);
    } else {
      handlePeerError(err);
    }
  });
}

function joinAsGuest(roomId, key) {
  const p = new Peer();
  peer = p;
  p.on('open', () => {
    if (peer !== p) return;
    role = 'guest';
    setOnlineStatus(`ルーム「${key}」に参加しています…`);
    attachConn(p.connect(roomId, { reliable: true }));
    connectTimer = setTimeout(() => {
      if (peer === p && !(conn && conn.open)) {
        setOnlineStatus('相手に接続できませんでした。時間をおくか、別のルームキーでお試しください', true);
        leaveOnline();
      }
    }, CONNECT_TIMEOUT_MS);
  });
  p.on('error', (err) => {
    if (peer !== p) return;
    if (err.type === 'peer-unavailable') {
      setOnlineStatus('ルームが見つかりませんでした。もう一度「入室」を押してください', true);
      leaveOnline();
    } else {
      handlePeerError(err);
    }
  });
}

function handlePeerError(err) {
  const messages = {
    'browser-incompatible': 'このブラウザはオンライン対戦に対応していません',
    network: 'サーバーに接続できません。ネットワークを確認してください',
    'server-error': 'サーバーに接続できません。時間をおいてお試しください',
    'socket-error': 'サーバーに接続できません。時間をおいてお試しください',
    'socket-closed': 'サーバーとの接続が切れました',
    webrtc: '相手との通信を確立できませんでした',
  };
  const text = messages[err.type] || `エラー: ${err.message || err.type}`;
  if (state.mode === 'online' && state.phase !== 'menu') {
    flash(text);
  } else {
    setOnlineStatus(text, true);
    leaveOnline();
  }
}

function attachConn(c) {
  conn = c;
  c.on('open', () => {
    if (conn !== c) return;
    clearTimeout(connectTimer);
    startOnlineMatch();
  });
  c.on('data', (msg) => { if (conn === c) onMessage(msg); });
  c.on('close', () => { if (conn === c) onDisconnected(); });
  c.on('error', () => { if (conn === c) onDisconnected(); });
}

function leaveOnline() {
  clearTimeout(connectTimer);
  const c = conn;
  const p = peer;
  conn = null;
  peer = null;
  role = null;
  if (c) c.close();
  if (p) p.destroy();
  setJoining(false);
}

function send(msg) {
  if (conn && conn.open) conn.send(msg);
}

function startOnlineMatch() {
  setJoining(false);
  setOnlineStatus('');
  resetMatch();
  state.mode = 'online';
  state.phase = 'setup';
  render();
}

function maybeStart() {
  if (role !== 'host' || !state.myReady || !state.oppReady || state.phase !== 'waiting') return;
  const first = Math.random() < 0.5 ? 'host' : 'guest';
  send({ type: 'start', first });
  beginPlay(first === 'host');
}

function beginPlay(iFirst) {
  state.iAmFirst = iFirst;
  state.myTurn = iFirst;
  state.phase = 'play';
}

function checkOnlineEnd() {
  const me = solved(state.myGuesses);
  const opp = solved(state.oppGuesses);
  if (!(me || opp) || state.myGuesses.length !== state.oppGuesses.length) return false;
  finish(me && opp ? 'draw' : me ? 'win' : 'lose');
  return true;
}

function onMessage(msg) {
  if (!msg || typeof msg !== 'object') return;
  switch (msg.type) {
    case 'full':
      leaveOnline();
      showMenu();
      setOnlineStatus('このルームは満員です。別のルームキーを使ってください', true);
      return;
    case 'ready':
      state.oppReady = true;
      maybeStart();
      break;
    case 'start':
      if (role === 'guest' && state.phase === 'waiting') beginPlay(msg.first === 'guest');
      break;
    case 'guess': {
      const g = String(msg.guess);
      if (state.phase !== 'play' || state.myTurn || state.pendingGuess !== null || !isValidNumber(g)) return;
      const r = judge(state.mySecret, g);
      state.oppGuesses.push({ guess: g, ...r });
      send({ type: 'result', guess: g, hit: r.hit, blow: r.blow });
      if (!checkOnlineEnd()) state.myTurn = true;
      break;
    }
    case 'result':
      if (state.pendingGuess === null || msg.guess !== state.pendingGuess) return;
      state.myGuesses.push({ guess: state.pendingGuess, hit: Number(msg.hit), blow: Number(msg.blow) });
      state.pendingGuess = null;
      checkOnlineEnd();
      break;
    case 'reveal': {
      const s = String(msg.secret);
      state.oppSecret = s;
      state.cheatSuspected = !isValidNumber(s) || state.myGuesses.some((g) => {
        const r = judge(s, g.guess);
        return r.hit !== g.hit || r.blow !== g.blow;
      });
      break;
    }
    case 'rematch':
      state.oppRematch = true;
      maybeRematch();
      break;
    default:
      return;
  }
  render();
}

function requestRematch() {
  if (state.phase !== 'over' || !(conn && conn.open)) return;
  state.myRematch = true;
  send({ type: 'rematch' });
  maybeRematch();
  render();
}

function maybeRematch() {
  if (!state.myRematch || !state.oppRematch) return;
  resetMatch();
  state.mode = 'online';
  state.phase = 'setup';
}

function onDisconnected() {
  conn = null;
  if (state.mode === 'online' && state.phase !== 'over' && state.phase !== 'menu') {
    state.phase = 'over';
    state.outcome = 'disconnected';
    state.myTurn = false;
  }
  flash('相手との接続が切れました');
}

function showMenu() {
  leaveOnline();
  resetMatch();
  state.mode = null;
  render();
}

// ---------- 描画 ----------

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

function messageText() {
  const { phase, mode } = state;
  if (phase === 'setup') return 'あなたの秘密の数字を決めてください(相手には送信されません)';
  if (phase === 'waiting') return state.oppReady ? '開始しています…' : '相手が数字を決めるのを待っています…';
  if (phase === 'play') {
    const n = state.myGuesses.length + 1;
    if (mode === 'solo') return `CPU の数字を当ててください(${n}回目)`;
    if (state.pendingGuess !== null) return '判定中…';
    if (state.myTurn) {
      return solved(state.oppGuesses)
        ? `相手が正解しました!このターンで当てれば引き分けです(${n}回目)`
        : `あなたの番です(${n}回目)`;
    }
    if (solved(state.myGuesses)) return '正解!相手の最後のターンを待っています…';
    return '相手の番です…';
  }
  if (phase === 'over') return '';
  return '';
}

function resultHtml() {
  const wrap = el('div');
  const n = state.myGuesses.length;
  const titles = {
    win: state.mode === 'solo' ? `正解!${n}回で当てました` : `あなたの勝ち!(${n}回)`,
    lose: 'あなたの負け…',
    draw: `引き分け!(${n}回)`,
    giveup: 'ギブアップ',
    disconnected: '対戦が中断されました',
  };
  wrap.appendChild(el('div', `result-title ${state.outcome}`, titles[state.outcome] || ''));
  if (state.oppSecret && (state.mode === 'solo' || state.outcome !== 'disconnected')) {
    const label = state.mode === 'solo' ? '正解' : '相手の数字';
    wrap.appendChild(el('div', 'result-sub', `${label}: ${state.oppSecret}`));
  } else if (state.mode === 'online' && state.outcome !== 'disconnected') {
    wrap.appendChild(el('div', 'result-sub', '相手の数字を受信中…'));
  }
  if (state.cheatSuspected) {
    wrap.appendChild(el('div', 'result-warn', '⚠ 相手の判定結果に公開された数字と食い違いがあります'));
  }
  if (state.mode === 'online' && state.outcome !== 'disconnected') {
    if (state.myRematch && !state.oppRematch) wrap.appendChild(el('div', 'result-sub', '相手の再戦待ち…'));
    else if (state.oppRematch && !state.myRematch) wrap.appendChild(el('div', 'result-sub', '相手が再戦を希望しています'));
  }
  return wrap;
}

let prevEntryLen = 0;
function renderEntry() {
  const box = $('#entry');
  box.replaceChildren();
  for (let i = 0; i < LEN; i++) {
    const slot = el('div', 'slot', state.entry[i] || '');
    if (state.entry[i]) slot.classList.add('filled');
    if (i === state.entry.length - 1 && state.entry.length > prevEntryLen) slot.classList.add('pop');
    if (i === state.entry.length && canInput()) slot.classList.add('cursor');
    box.appendChild(slot);
  }
  prevEntryLen = state.entry.length;
}

function renderKeypad() {
  const pad = $('#keypad');
  if (!pad.childElementCount) {
    for (const d of '1234567890') {
      const b = el('button', 'key digit', d);
      b.dataset.digit = d;
      b.addEventListener('click', () => pushDigit(d));
      pad.appendChild(b);
    }
    const back = el('button', 'key', '⌫');
    back.addEventListener('click', popDigit);
    const clear = el('button', 'key', 'クリア');
    clear.addEventListener('click', clearEntry);
    const ok = el('button', 'key submit', '決定');
    ok.id = 'btn-submit';
    ok.addEventListener('click', submitEntry);
    pad.append(back, clear, ok);
  }
  const enabled = canInput();
  pad.querySelectorAll('.digit').forEach((b) => {
    b.disabled = !enabled || state.entry.includes(b.dataset.digit) || state.entry.length >= LEN;
  });
  pad.querySelectorAll('.key:not(.digit)').forEach((b) => { b.disabled = !enabled; });
  $('#btn-submit').textContent = state.phase === 'setup' ? 'この数字で決定' : '予想する';
  $('#btn-submit').disabled = !enabled || state.entry.length !== LEN;
}

function renderMemo() {
  const memo = $('#memo');
  if (!memo.childElementCount) {
    for (let d = 0; d < 10; d++) {
      const b = el('button', 'memo-key', String(d));
      b.addEventListener('click', () => {
        state.memo[d] = (state.memo[d] + 1) % 3;
        render();
      });
      memo.appendChild(b);
    }
  }
  [...memo.children].forEach((b, d) => {
    b.className = `memo-key m${state.memo[d]}`;
  });
}

function lamps(hit, blow) {
  const box = el('span', 'lamps');
  for (let i = 0; i < LEN; i++) {
    box.appendChild(el('span', `lamp ${i < hit ? 'hit' : i < hit + blow ? 'blow' : 'off'}`));
  }
  return box;
}

function renderHistory(list, target) {
  const prevLen = Number(target.dataset.len || 0);
  target.replaceChildren();
  [...list].reverse().forEach((g, idx) => {
    const li = el('li', g.hit === LEN ? 'solved' : '');
    if (idx === 0 && list.length > prevLen) li.classList.add('fresh');
    li.append(
      el('span', 'n', String(list.length - idx).padStart(2, '0')),
      el('span', 'g', g.guess),
      lamps(g.hit, g.blow),
      el('span', 'hb', `${g.hit}H ${g.blow}B`),
    );
    target.appendChild(li);
  });
  target.dataset.len = String(list.length);
  if (!list.length) target.appendChild(el('li', 'empty', '— NO DATA —'));
}

function renderInfo() {
  const info = $('#play-info');
  info.replaceChildren();
  if (state.mode === 'solo') {
    info.appendChild(el('span', 'chip', 'ひとりで練習'));
  } else {
    info.appendChild(el('span', 'chip', `ルーム: ${state.roomKey}`));
    if (state.phase === 'play' || state.phase === 'over') {
      info.appendChild(el('span', 'chip', state.iAmFirst ? '先攻' : '後攻'));
    }
    if (state.mySecret) info.appendChild(el('span', 'chip secret', `あなたの数字: ${state.mySecret}`));
  }
}

function render() {
  const inMenu = state.phase === 'menu';
  $('#screen-menu').classList.toggle('hidden', !inMenu);
  $('#screen-play').classList.toggle('hidden', inMenu);
  if (inMenu) return;

  const online = state.mode === 'online';
  const over = state.phase === 'over';
  $('#screen-play').dataset.turn = over ? 'over' : canInput() ? 'mine' : 'wait';

  renderInfo();
  $('#message').textContent = messageText();
  $('#notice').textContent = state.notice;

  const result = $('#result');
  result.classList.toggle('hidden', !over);
  if (over) result.replaceChildren(resultHtml());

  $('#input-area').classList.toggle('hidden', over || state.phase === 'waiting' || (state.phase === 'play' && online && !state.myTurn));
  renderEntry();
  renderKeypad();

  $('#memo-area').classList.toggle('hidden', state.phase === 'setup' || state.phase === 'waiting');
  renderMemo();

  $('#opp-col').classList.toggle('hidden', !online);
  $('#hist-me-title').textContent = online ? 'あなたの予想' : '予想の履歴';
  renderHistory(state.myGuesses, $('#hist-me'));
  renderHistory(state.oppGuesses, $('#hist-opp'));

  $('#btn-giveup').classList.toggle('hidden', !(state.mode === 'solo' && state.phase === 'play'));
  $('#btn-retry').classList.toggle('hidden', !(state.mode === 'solo' && over));
  $('#btn-rematch').classList.toggle('hidden', !(online && over && state.outcome !== 'disconnected'));
  $('#btn-rematch').disabled = state.myRematch || !(conn && conn.open);
}

// ---------- イベント登録 ----------

function init() {
  $('#btn-solo').addEventListener('click', startSolo);
  $('#btn-join').addEventListener('click', joinRoom);
  $('#room-key').addEventListener('keydown', (e) => { if (e.key === 'Enter') joinRoom(); });
  $('#btn-cancel-join').addEventListener('click', () => { leaveOnline(); setOnlineStatus(''); });
  $('#btn-copy-link').addEventListener('click', async () => {
    const url = new URL(location.href);
    url.search = '';
    url.hash = '';
    url.searchParams.set('room', state.roomKey);
    try {
      await navigator.clipboard.writeText(url.toString());
      setOnlineStatus('招待リンクをコピーしました。相手に送ってください');
    } catch {
      setOnlineStatus(`招待リンク: ${url}`);
    }
  });
  $('#btn-giveup').addEventListener('click', () => {
    if (state.phase === 'play' && confirm('ギブアップしますか?')) {
      finish('giveup');
      render();
    }
  });
  $('#btn-retry').addEventListener('click', startSolo);
  $('#btn-rematch').addEventListener('click', requestRematch);
  $('#btn-leave').addEventListener('click', () => {
    const playing = state.mode === 'online' && state.phase !== 'over';
    if (playing && !confirm('対戦を終了してメニューに戻りますか?')) return;
    showMenu();
  });

  document.addEventListener('keydown', (e) => {
    if (state.phase === 'menu' || e.target instanceof HTMLInputElement) return;
    if (/^\d$/.test(e.key)) pushDigit(e.key);
    else if (e.key === 'Backspace') popDigit();
    else if (e.key === 'Enter') { e.preventDefault(); submitEntry(); }
    else if (e.key === 'Escape') clearEntry();
  });

  window.addEventListener('beforeunload', () => leaveOnline());

  const room = new URLSearchParams(location.search).get('room');
  if (room) $('#room-key').value = room;

  render();
}

init();
