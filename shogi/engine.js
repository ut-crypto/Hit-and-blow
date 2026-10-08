'use strict';

/*
 * CPU プレイヤーと形勢評価(やねうら王 WebAssembly 版を USI プロトコルで操作)
 *   簡単 / 普通 / 難しい : やねうら王 + 評価関数 SuishoPetite(K-P, 小さい)
 *   最強                : やねうら王 + 評価関数 水匠5(NNUE HalfKP)、先読み(ponder)あり
 *   極                  : 最強 + 詰将棋ソルバー KomoringHeights の並列探索 + 深読み定跡 + 大きい置換表
 *   形勢バー            : K-P 版を別インスタンスで動かして評価
 */
const ShogiEngine = (() => {
  const ENGINES = {
    'k-p': { script: 'engine/yaneuraou.k-p.js', global: 'YaneuraOu_K_P', wasm: 'engine/yaneuraou.k-p.wasm.gz' },
    halfkp: { script: 'engine/yaneuraou.halfkp.js', global: 'YaneuraOu_HalfKP', wasm: 'engine/yaneuraou.halfkp.wasm.gz' },
    kh: {
      script: 'engine/yaneuraou.komoringheights-mate.js',
      global: 'KomoringHeights_MATE',
      wasm: 'engine/yaneuraou.komoringheights-mate.wasm.gz',
    },
  };
  const BOOK_URL = 'engine/book-suisho5.db';
  const BOOK_FILE = 'user_book1.db';

  const byoyomi = (ms) => `go btime 0 wtime 0 byoyomi ${ms}`;

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
      go: () => byoyomi(1000),
      temperature: 0,
      minDelay: 0,
    },
    max: {
      label: '最強',
      note: '水匠5(NNUE)。常に最善手を探し、相手の手番中も読み続ける',
      engine: 'halfkp',
      multiPV: 1,
      go: byoyomi,
      temperature: 0,
      minDelay: 0,
      ponder: true,
    },
    ultra: {
      label: '極',
      note: '最強 + 詰将棋ソルバー並列探索 + 深読み定跡 + 大きな置換表',
      engine: 'halfkp',
      multiPV: 1,
      go: byoyomi,
      temperature: 0,
      minDelay: 0,
      ponder: true,
      book: true,
      mateSolver: true,
    },
  };

  const instances = {};
  const binaries = {};

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error(`${src} を読み込めませんでした`));
      document.head.appendChild(s);
    });
  }

  async function fetchBytes(url, onProgress) {
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

  /** エンジンを読み込む。instanceKey が違えば同じ種類でも別インスタンス(同時に探索できる) */
  function loadModule(kind, onProgress, instanceKey = kind) {
    if (instances[instanceKey]) return instances[instanceKey];
    const def = ENGINES[kind];
    const base = new URL('.', location.href);
    const promise = (async () => {
      if (!window.crossOriginIsolated) {
        throw new Error('このブラウザでは CPU を利用できません(SharedArrayBuffer が無効です)。ページを再読み込みするか、Chrome / Edge / Firefox の最新版でお試しください');
      }
      const url = new URL(def.wasm, base).href;
      if (!binaries[url]) {
        binaries[url] = fetchBytes(url, onProgress);
        binaries[url].catch(() => { delete binaries[url]; });
      }
      const [wasmBinary] = await Promise.all([
        binaries[url],
        window[def.global] ? null : loadScript(new URL(def.script, base).href),
      ]);
      const engineBase = new URL('engine/', base).href;
      const mod = await window[def.global]({
        wasmBinary,
        locateFile: (path) => engineBase + path,
        mainScriptUrlOrBlob: new URL(def.script, base).href,
      });
      const engine = new UsiEngine(mod);
      await engine.request('usi', 'usiok');
      return engine;
    })();
    instances[instanceKey] = promise;
    promise.catch(() => { delete instances[instanceKey]; });
    return promise;
  }

  class UsiEngine {
    constructor(mod) {
      this.mod = mod;
      this.listeners = new Set();
      this.options = {};
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

    request(cmd, prefix, onLine) {
      const p = this.waitFor(prefix, onLine);
      this.send(cmd);
      return p;
    }

    /** 値が変わったオプションだけ送る */
    setOptions(opts) {
      for (const [k, v] of Object.entries(opts)) {
        if (this.options[k] === String(v)) continue;
        this.options[k] = String(v);
        this.send(`setoption name ${k} value ${v}`);
      }
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
      bound: / (lowerbound|upperbound)/.test(line),
      pv: pv ? pv[1].split(' ') : [],
    };
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function strongOptions(level) {
    const cores = navigator.hardwareConcurrency || 2;
    const mem = navigator.deviceMemory; // Chrome 系のみ。不明なら控えめに
    // 極は詰将棋ソルバーに1コア回す
    const reserve = level.mateSolver && cores >= 4 ? 2 : 1;
    const threads = Math.max(1, Math.min(cores - reserve, 16));
    let hash;
    if (level.book) hash = mem >= 8 ? 1024 : mem >= 4 ? 512 : 256;
    else hash = mem === undefined || mem >= 4 ? 256 : 64;
    return { Threads: threads, USI_Hash: hash, USI_Ponder: true };
  }

  let bookText = null;
  async function loadBook(engine) {
    if (engine.bookLoaded) return;
    if (!bookText) {
      const res = await fetch(new URL(BOOK_URL, location.href));
      if (!res.ok) throw new Error('定跡ファイルを読み込めませんでした');
      bookText = await res.text();
    }
    engine.mod.FS.writeFile(`/${BOOK_FILE}`, bookText);
    engine.bookLoaded = true;
  }

  /** 詰将棋ソルバー(KomoringHeights)。王手の連続で詰むかを df-pn で調べる */
  class MateSolver {
    constructor(engine) {
      this.engine = engine;
      this.running = null;
    }

    static async create() {
      const engine = await loadModule('kh');
      engine.setOptions({ USI_Hash: 64, Threads: 1, PvInterval: 0, RootIsAndNodeIfChecked: false });
      await engine.request('isready', 'readyok');
      return new MateSolver(engine);
    }

    /** 詰みが見つかれば手順(USI の配列)、見つからなければ null */
    solve(usiPosition, ms) {
      const e = this.engine;
      e.send(usiPosition);
      const p = e.request(`go mate ${ms}`, 'checkmate').then((line) => {
        this.running = null;
        const moves = line.split(' ').slice(1).filter(Boolean);
        if (!moves.length || ['nomate', 'timeout', 'notimplemented'].includes(moves[0])) return null;
        return moves;
      });
      this.running = p;
      return p;
    }

    async stop() {
      if (!this.running) return;
      this.engine.send('stop');
      await this.running;
    }
  }

  class CpuPlayer {
    constructor(levelKey, { maxTimeMs = 5000, onInfo } = {}) {
      this.levelKey = levelKey;
      this.level = LEVELS[levelKey];
      this.maxTimeMs = maxTimeMs;
      this.onInfo = onInfo;
      this.engine = null;
      this.mate = null;
      this.ponder = null; // { usiPosition, move, done: Promise<bestmove line> }
      this.thinking = false;
    }

    async init(onProgress) {
      const lv = this.level;
      this.engine = await loadModule(lv.engine, onProgress);
      const e = this.engine;
      const common = {
        EnteringKingRule: 'NoEnteringKing',
        MaxMovesToDraw: ShogiCore.MAX_MOVES,
        NetworkDelay: 0,
        NetworkDelay2: 0,
        MinimumThinkingTime: 1000,
        PvInterval: 300,
        MultiPV: lv.multiPV,
      };
      const strength = lv.engine === 'halfkp' ? strongOptions(lv) : { Threads: 1, USI_Hash: 32, USI_Ponder: false };
      let book = { USI_OwnBook: false, BookFile: 'no_book' };
      if (lv.book) {
        await loadBook(e);
        book = {
          USI_OwnBook: true,
          BookDir: '.',
          BookFile: BOOK_FILE,
          BookMoves: 32,
          BookEvalDiff: 0,           // 最善の1手だけ
          BookEvalBlackLimit: -99999,
          BookEvalWhiteLimit: -99999,
          BookDepthLimit: 0,
          IgnoreBookPly: true,
          NarrowBook: false,
          ConsiderBookMoveCount: false,
        };
      }
      e.setOptions({ ...common, ...strength, ...book });
      await e.request('isready', 'readyok');
      e.send('usinewgame');
      if (lv.mateSolver && !this.mate) this.mate = await MateSolver.create();
    }

    /** 先読み中の探索を止める */
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
      if (this.mate) this.mate.stop();
      this.ponder = null;
    }

    /** game の局面で CPU の指し手を返す: { move: USI 文字列 | 'resign', ponder } */
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
      const infos = [];
      const onLine = (line) => {
        if (!line.startsWith('info') || !line.includes(' pv ')) return;
        const info = parseInfo(line);
        infos.push(info);
        if (this.onInfo) this.onInfo(info);
      };
      const position = game.usiPosition();

      // 極: 詰将棋ソルバーを並行して走らせ、詰みが見つかれば本探索を打ち切る
      let mateMoves = null;
      let mainDone = false;
      // 王手をかけられている局面では詰将棋ソルバーは使わない(受け方の手順が返るため)
      const useMate = this.mate && !game.pos.inCheck();
      const mateP = useMate ? this.mate.solve(position, Math.max(300, this.maxTimeMs - 200)) : null;
      if (mateP) {
        mateP.then((moves) => {
          if (moves && game.pos.findMove(moves[0])) {
            mateMoves = moves;
            if (!mainDone) e.send('stop');
          }
        });
      }

      let bestLine = null;
      if (this.ponder) {
        const p = this.ponder;
        this.ponder = null;
        if (p.usiPosition === position) {
          // 予想どおりの手だった → そのまま読みを続けて着手
          e.waitFor('bestmove', onLine);
          e.send('ponderhit');
          bestLine = await p.done;
        } else {
          e.send('stop');
          await p.done;
        }
      }
      if (!bestLine) {
        e.send(position);
        bestLine = await e.request(this.level.go(this.maxTimeMs), 'bestmove', onLine);
      }
      mainDone = true;
      if (mateP) {
        await this.mate.stop();
        await mateP;
      }

      const [, best, , ponderMove] = bestLine.split(' ');
      let move = best;
      let ponder = ponderMove || null;
      if (mateMoves && !(infos.length && infos[infos.length - 1].mate && !infos[infos.length - 1].mate.startsWith('-'))) {
        move = mateMoves[0];
        ponder = mateMoves[1] || null;
        if (this.onInfo) this.onInfo({ depth: mateMoves.length, score: 100000 - mateMoves.length, mate: String(mateMoves.length), pv: mateMoves, solver: true });
      }
      if (this.level.temperature > 0 && infos.length) {
        const picked = this.pickSoftly(infos, best);
        if (picked !== best) { move = picked; ponder = null; }
      }

      const wait = this.level.minDelay - (Date.now() - start);
      if (wait > 0) await sleep(wait);
      return { move, ponder };
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
      e.send(this.level.go(this.maxTimeMs).replace('go ', 'go ponder '));
      this.ponder = { usiPosition: position, move: ponderMove, done };
    }
  }

  /**
   * 形勢評価(K-P 版を CPU とは別インスタンスで動かす)。
   * 新しい局面が来たら古い探索は止め、常に最新の局面だけを評価する。
   */
  class Evaluator {
    constructor(onEval) {
      this.onEval = onEval;
      this.engine = null;
      this.pending = null;
      this.current = null;
      this.busy = false;
    }

    async init() {
      this.engine = await loadModule('k-p', null, 'evaluator');
      this.engine.setOptions({
        Threads: 1,
        USI_Hash: 16,
        MultiPV: 1,
        EnteringKingRule: 'NoEnteringKing',
        NetworkDelay: 0,
        NetworkDelay2: 0,
        PvInterval: 0,
        USI_OwnBook: false,
      });
      await this.engine.request('isready', 'readyok');
    }

    /** game の現在局面を評価する。結果は onEval({ ply, blackScore, mate }) */
    request(game) {
      if (!this.engine || game.result) return;
      this.pending = { position: game.usiPosition(), side: game.pos.side, ply: game.ply };
      this.pump();
    }

    cancel() {
      this.pending = null;
      if (this.current) this.engine.send('stop');
    }

    async pump() {
      if (this.busy) {
        if (this.current) this.engine.send('stop');
        return;
      }
      this.busy = true;
      while (this.pending) {
        const job = this.pending;
        this.pending = null;
        this.current = job;
        const emit = (info) => {
          if (this.pending || info.score === null) return;
          const blackScore = job.side === ShogiCore.BLACK ? info.score : -info.score;
          const mate = info.mate === null ? null : (info.score > 0) === (job.side === ShogiCore.BLACK) ? 'black' : 'white';
          this.onEval({ ply: job.ply, blackScore, mate, depth: info.depth });
        };
        this.engine.send(job.position);
        await this.engine.request('go movetime 800', 'bestmove', (line) => {
          if (!line.startsWith('info') || !line.includes(' score ')) return;
          const info = parseInfo(line);
          if (!info.bound && info.depth >= 6) emit(info);
        });
        this.current = null;
      }
      this.busy = false;
    }
  }

  return { LEVELS, CpuPlayer, Evaluator, MateSolver, loadModule, parseInfo };
})();
