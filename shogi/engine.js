'use strict';

/*
 * CPU プレイヤー(やねうら王 WebAssembly 版を USI プロトコルで操作)
 *   簡単 / 普通 / 難しい : やねうら王 + 評価関数 SuishoPetite(K-P, 小さい)
 *   最強                : やねうら王 + 評価関数 水匠5(NNUE HalfKP)、先読み(ponder)あり
 */
const ShogiEngine = (() => {
  const ENGINES = {
    'k-p': {
      script: 'engine/yaneuraou.k-p.js',
      global: 'YaneuraOu_K_P',
      wasm: 'engine/yaneuraou.k-p.wasm.gz',
      wasmName: 'yaneuraou.k-p.wasm',
    },
    halfkp: {
      script: 'engine/yaneuraou.halfkp.js',
      global: 'YaneuraOu_HalfKP',
      wasm: 'engine/yaneuraou.halfkp.wasm.gz',
      wasmName: 'yaneuraou.halfkp.wasm',
    },
  };

  const LEVELS = {
    easy: {
      label: '簡単',
      note: '入門〜初級向け。読みが浅く、悪手もよく指す',
      engine: 'k-p',
      multiPV: 8,
      go: () => 'go depth 1',
      temperature: 250,
      minDelay: 600,
    },
    normal: {
      label: '普通',
      note: '中級者向け。数手先を読むが、ときどき緩む',
      engine: 'k-p',
      multiPV: 4,
      go: () => 'go depth 3',
      temperature: 60,
      minDelay: 700,
    },
    hard: {
      label: '難しい',
      note: '有段者向け。1手1秒しっかり読む',
      engine: 'k-p',
      multiPV: 1,
      go: () => 'go btime 0 wtime 0 byoyomi 1000',
      temperature: 0,
      minDelay: 0,
    },
    max: {
      label: '最強',
      note: '水匠5(NNUE)。常に最善手を探し、相手の手番中も読み続ける',
      engine: 'halfkp',
      multiPV: 1,
      go: (maxMs) => `go btime 0 wtime 0 byoyomi ${maxMs}`,
      temperature: 0,
      minDelay: 0,
      ponder: true,
    },
  };

  const loadedModules = {};

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error(`${src} を読み込めませんでした`));
      document.head.appendChild(s);
    });
  }

  async function fetchWasm(url, onProgress) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url} を読み込めませんでした (${res.status})`);
    const total = Number(res.headers.get('content-length')) || 0;
    const reader = res.body.getReader();
    const chunks = [];
    let loaded = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.length;
      if (onProgress) onProgress(loaded, total);
    }
    let blob = new Blob(chunks);
    const head = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
    // サーバーが Content-Encoding で展開済みならそのまま、gzip のままなら展開する
    if (head[0] === 0x1f && head[1] === 0x8b) {
      blob = await new Response(blob.stream().pipeThrough(new DecompressionStream('gzip'))).blob();
    }
    return blob.arrayBuffer();
  }

  async function loadModule(kind, onProgress) {
    if (loadedModules[kind]) return loadedModules[kind];
    const def = ENGINES[kind];
    const base = new URL('.', location.href);
    const promise = (async () => {
      if (!window.crossOriginIsolated) {
        throw new Error('このブラウザでは CPU 対戦を利用できません(SharedArrayBuffer が無効です)。ページを再読み込みするか、Chrome / Edge / Firefox の最新版でお試しください');
      }
      const [wasmBinary] = await Promise.all([
        fetchWasm(new URL(def.wasm, base).href, onProgress),
        window[def.global] ? null : loadScript(new URL(def.script, base).href),
      ]);
      const engineBase = new URL('engine/', base).href;
      const mod = await window[def.global]({
        wasmBinary,
        locateFile: (path) => engineBase + path,
        mainScriptUrlOrBlob: new URL(def.script, base).href,
      });
      return new UsiEngine(mod);
    })();
    loadedModules[kind] = promise;
    promise.catch(() => { delete loadedModules[kind]; });
    return promise;
  }

  class UsiEngine {
    constructor(mod) {
      this.mod = mod;
      this.listeners = new Set();
      this.ready = false;
      mod.addMessageListener((line) => {
        for (const f of [...this.listeners]) f(line);
      });
    }

    send(cmd) {
      this.mod.postMessage(cmd);
    }

    waitFor(prefix, onLine) {
      return new Promise((resolve) => {
        const f = (line) => {
          if (onLine) onLine(line);
          if (line.startsWith(prefix)) {
            this.listeners.delete(f);
            resolve(line);
          }
        };
        this.listeners.add(f);
      });
    }

    async request(cmd, prefix, onLine) {
      const p = this.waitFor(prefix, onLine);
      this.send(cmd);
      return p;
    }
  }

  function parseInfo(line) {
    const get = (key) => {
      const m = line.match(new RegExp(` ${key} (\\S+)`));
      return m ? m[1] : null;
    };
    const pv = line.match(/ pv (.+)$/);
    const scoreMatch = line.match(/ score (cp|mate) (\S+)/);
    let score = null;
    if (scoreMatch) {
      if (scoreMatch[1] === 'cp') score = Number(scoreMatch[2]);
      else {
        const n = scoreMatch[2];
        score = n.startsWith('-') ? -100000 + Math.abs(parseInt(n, 10) || 0) : 100000 - (parseInt(n, 10) || 0);
      }
    }
    return {
      depth: Number(get('depth')) || 0,
      multipv: Number(get('multipv')) || 1,
      score,
      mate: scoreMatch && scoreMatch[1] === 'mate' ? scoreMatch[2] : null,
      pv: pv ? pv[1].split(' ') : [],
    };
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  class CpuPlayer {
    constructor(levelKey, { maxTimeMs = 5000, onInfo } = {}) {
      this.levelKey = levelKey;
      this.level = LEVELS[levelKey];
      this.maxTimeMs = maxTimeMs;
      this.onInfo = onInfo;
      this.engine = null;
      this.ponder = null; // { usiPosition, move, done: Promise<bestmove line> }
      this.busy = Promise.resolve();
    }

    async init(onProgress) {
      this.engine = await loadModule(this.level.engine, onProgress);
      const e = this.engine;
      if (!e.ready) {
        await e.request('usi', 'usiok');
        const strong = this.level.engine === 'halfkp';
        const cores = navigator.hardwareConcurrency || 2;
        const threads = strong ? Math.max(1, Math.min(cores - 1, 8)) : 1;
        const bigMemory = (navigator.deviceMemory || 4) >= 4;
        const hash = strong ? (bigMemory ? 256 : 64) : 32;
        for (const [k, v] of [
          ['Threads', threads],
          ['USI_Hash', hash],
          ['USI_Ponder', strong],
          ['EnteringKingRule', 'NoEnteringKing'],
          ['MaxMovesToDraw', ShogiCore.MAX_MOVES],
          ['NetworkDelay', 0],
          ['NetworkDelay2', 0],
          ['MinimumThinkingTime', 1000],
          ['PvInterval', 300],
        ]) e.send(`setoption name ${k} value ${v}`);
        await e.request('isready', 'readyok');
        e.ready = true;
      }
      e.send(`setoption name MultiPV value ${this.level.multiPV}`);
      e.send('usinewgame');
      await e.request('isready', 'readyok');
    }

    /** 先読み中・思考中の探索を止める */
    async cancel() {
      if (this.ponder) {
        const p = this.ponder;
        this.ponder = null;
        this.engine.send('stop');
        await p.done;
      }
    }

    /** 対局をやめるとき: 思考中・先読み中の探索を止める(結果は捨てる) */
    abort() {
      if (this.thinking || this.ponder) this.engine.send('stop');
      this.ponder = null;
    }

    /** game の局面で CPU の指し手(USI 文字列 or 'resign')を返す */
    async think(game) {
      this.thinking = true;
      try {
        return await this.search(game);
      } finally {
        this.thinking = false;
      }
    }

    async search(game) {
      const e = this.engine;
      const start = Date.now();
      const onLine = (line) => {
        if (line.startsWith('info') && line.includes(' pv ') && this.onInfo) this.onInfo(parseInfo(line));
      };

      let bestLine = null;
      const position = game.usiPosition();
      if (this.ponder) {
        const p = this.ponder;
        this.ponder = null;
        if (p.usiPosition === position) {
          // 予想どおりの手だった → そのまま読みを続けて着手
          e.waitFor('bestmove', onLine); // 読み筋の表示用
          e.send('ponderhit');
          bestLine = await p.done;
        } else {
          e.send('stop');
          await p.done;
        }
      }

      const infos = [];
      if (!bestLine) {
        e.send(position);
        bestLine = await e.request(this.level.go(this.maxTimeMs), 'bestmove', (line) => {
          onLine(line);
          if (line.startsWith('info') && line.includes(' pv ')) infos.push(parseInfo(line));
        });
      }

      const [, best, , ponderMove] = bestLine.split(' ');
      let move = best;
      if (this.level.temperature > 0 && infos.length) move = this.pickSoftly(infos, best);

      const wait = this.level.minDelay - (Date.now() - start);
      if (wait > 0) await sleep(wait);
      return { move, ponder: move === best ? ponderMove : null };
    }

    /** 複数の候補手から、評価値が高いほど選ばれやすいように確率で選ぶ */
    pickSoftly(infos, fallback) {
      const maxDepth = Math.max(...infos.map((i) => i.depth));
      const byPv = new Map();
      for (const i of infos) {
        if (i.depth === maxDepth && i.pv.length && i.score !== null) byPv.set(i.multipv, i);
      }
      const cands = [...byPv.values()];
      if (!cands.length) return fallback;
      const top = Math.max(...cands.map((c) => c.score));
      // 自分が詰ませられる/詰まされるときは最善手
      if (Math.abs(top) >= 90000) return fallback;
      const weights = cands.map((c) => Math.exp((c.score - top) / this.level.temperature));
      let r = Math.random() * weights.reduce((a, b) => a + b, 0);
      for (let k = 0; k < cands.length; k++) {
        r -= weights[k];
        if (r <= 0) return cands[k].pv[0];
      }
      return cands[0].pv[0];
    }

    /** CPU が指した後、相手の予想手の局面で先読みを始める */
    startPonder(game, ponderMove) {
      if (!this.level.ponder || !ponderMove || game.result) return;
      if (!game.pos.findMove(ponderMove)) return;
      const position = `${game.usiPosition()}${game.ply ? '' : ' moves'} ${ponderMove}`;
      const e = this.engine;
      e.send(position);
      const done = e.waitFor('bestmove');
      e.send(`${this.level.go(this.maxTimeMs).replace('go ', 'go ponder ')}`);
      this.ponder = { usiPosition: position, move: ponderMove, done };
    }

    async dispose() {
      await this.cancel();
    }
  }

  return { LEVELS, CpuPlayer, loadModule };
})();
