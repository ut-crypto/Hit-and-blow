'use strict';

/*
 * ルームキーでつながる2人用オンライン接続(PeerJS / WebRTC)。
 * 同じキーで先に入室した人がホスト、後から入った人がゲストになる。
 *
 * 使い方:
 *   const room = OnlineRoom.create('ゲーム固有のプレフィックス-', {
 *     onStatus(text, { error, busy, hosting }) {},  // 接続前の状態表示
 *     onConnect(role) {},                           // 'host' | 'guest'
 *     onData(msg) {},
 *     onDisconnect() {},
 *     onFull() {},                                  // ルームが満員だった
 *     onError(text) {},                             // 接続後のエラー
 *   });
 *   room.join(key); room.send(obj); room.leave(); room.role; room.isOpen;
 */
window.OnlineRoom = (() => {
  const CONNECT_TIMEOUT_MS = 15000;
  const FULL = '__room_full__';
  const ERROR_MESSAGES = {
    'browser-incompatible': 'このブラウザはオンライン対戦に対応していません',
    network: 'サーバーに接続できません。ネットワークを確認してください',
    'server-error': 'サーバーに接続できません。時間をおいてお試しください',
    'socket-error': 'サーバーに接続できません。時間をおいてお試しください',
    'socket-closed': 'サーバーとの接続が切れました',
    webrtc: '相手との通信を確立できませんでした',
  };

  async function roomIdFromKey(prefix, key) {
    const normalized = key.normalize('NFKC').trim().toLowerCase();
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalized));
    const hex = [...new Uint8Array(buf)].slice(0, 12).map((b) => b.toString(16).padStart(2, '0')).join('');
    return prefix + hex;
  }

  function create(prefix, handlers) {
    let peer = null;
    let conn = null;
    let role = null;
    let connected = false;
    let timer = null;

    const status = (text, opts = {}) => handlers.onStatus && handlers.onStatus(text, opts);

    function leave() {
      clearTimeout(timer);
      const c = conn;
      const p = peer;
      conn = null;
      peer = null;
      role = null;
      connected = false;
      if (c) c.close();
      if (p) p.destroy();
    }

    function fail(text) {
      leave();
      status(text, { error: true });
    }

    function handlePeerError(err) {
      const text = ERROR_MESSAGES[err.type] || `エラー: ${err.message || err.type}`;
      if (connected) handlers.onError && handlers.onError(text);
      else fail(text);
    }

    function attach(c) {
      conn = c;
      c.on('open', () => {
        if (conn !== c) return;
        clearTimeout(timer);
        connected = true;
        handlers.onConnect && handlers.onConnect(role);
      });
      c.on('data', (msg) => {
        if (conn !== c) return;
        if (msg && msg.type === FULL) {
          leave();
          handlers.onFull && handlers.onFull();
          return;
        }
        handlers.onData && handlers.onData(msg);
      });
      const closed = () => {
        if (conn !== c) return;
        conn = null;
        connected = false;
        handlers.onDisconnect && handlers.onDisconnect();
      };
      c.on('close', closed);
      c.on('error', closed);
    }

    async function join(rawKey) {
      const key = String(rawKey || '').trim();
      if (!key) return status('ルームキーを入力してください', { error: true });
      if (typeof Peer === 'undefined') {
        return status('通信ライブラリ(PeerJS)を読み込めませんでした。ページを再読み込みしてください', { error: true });
      }
      if (!window.crypto || !crypto.subtle) {
        return status('https で開いてください(オンライン対戦は https が必要です)', { error: true });
      }
      leave();
      status('接続中…', { busy: true });

      const roomId = await roomIdFromKey(prefix, key);
      const p = new Peer(roomId);
      peer = p;

      p.on('open', () => {
        if (peer !== p) return;
        role = 'host';
        status(`ルーム「${key}」を作成しました。相手の入室を待っています…`, { busy: true, hosting: true });
      });
      p.on('connection', (c) => {
        if (peer !== p) return;
        if (conn) {
          c.on('open', () => {
            c.send({ type: FULL });
            setTimeout(() => c.close(), 500);
          });
          return;
        }
        attach(c);
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
        status(`ルーム「${key}」に参加しています…`, { busy: true });
        attach(p.connect(roomId, { reliable: true }));
        timer = setTimeout(() => {
          if (peer === p && !connected) fail('相手に接続できませんでした。時間をおくか、別のルームキーでお試しください');
        }, CONNECT_TIMEOUT_MS);
      });
      p.on('error', (err) => {
        if (peer !== p) return;
        if (err.type === 'peer-unavailable') fail('ルームが見つかりませんでした。もう一度「入室」を押してください');
        else handlePeerError(err);
      });
    }

    return {
      join,
      leave,
      send(msg) { if (conn && conn.open) conn.send(msg); },
      get role() { return role; },
      get isOpen() { return !!(conn && conn.open); },
    };
  }

  return { create };
})();
