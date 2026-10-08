# Mini Games

ブラウザで遊べるミニゲーム集。GitHub Pages で公開:<https://ut-crypto.github.io/mini-games/>

| ゲーム | 内容 | URL |
|---|---|---|
| Hit & Blow 5 | 重複なし5桁の数字を当てる推理ゲーム(ひとりで練習 / オンライン対戦) | `/hit-and-blow/` |

## 構成

```
index.html          ゲーム一覧(トップページ)
shared/theme.css    共通デザイン(配色・フォント・パネル・ボタンなど)
shared/online.js    ルームキーで2人をつなぐオンライン接続(PeerJS)
hit-and-blow/       Hit & Blow 5
```

## ゲームの追加方法

1. `新しいゲーム名/index.html` を作り、`<head>` で `../shared/theme.css` を読み込む
2. 一覧へ戻るリンク `<a class="back-link" href="../">← GAMES</a>` を置く
3. オンライン対戦が必要なら PeerJS と `../shared/online.js` を読み込み、`OnlineRoom.create('ゲーム固有のプレフィックス-', {...})` を使う(使い方は `shared/online.js` 冒頭のコメント参照)。プレフィックスはゲームごとに変えること
4. トップの `index.html` の一覧にカードを追加する

## 公開方法(GitHub Pages)

**Settings → Pages** で Source を「Deploy from a branch」、Branch を `master` / `/ (root)` にする。

## オンライン対戦の仕組み

- GitHub Pages は静的ファイルのみ配信するため、通信には [PeerJS](https://peerjs.com/)(WebRTC による P2P 通信)を使用
- 接続相手を探すシグナリングには PeerJS の無料公開クラウドサーバー(`0.peerjs.com`)を使用。アカウント登録は不要
- ルームキーは SHA-256 でハッシュ化した値を接続 ID に使用。先に入室した人がホストになる
- 公開 PeerJS サーバーは無保証のため、混雑や停止で接続できないことがある。また一部のネットワークでは P2P 接続が確立できない場合がある(TURN サーバー未使用のため)

### Hit & Blow 5 の不正対策

自分の秘密の数字は相手に送らず、手元で Hit/Blow を判定して結果だけを返す。決着後にお互いの数字を公開し、判定結果に食い違いがないかを自動でチェックする。
