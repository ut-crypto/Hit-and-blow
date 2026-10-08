/*
 * GitHub Pages は HTTP ヘッダーを設定できないため、Service Worker で
 * COOP/COEP ヘッダーを付けて crossOriginIsolated を有効にする。
 * (将棋エンジンの WebAssembly がスレッド = SharedArrayBuffer を使うため)
 */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.cache === 'only-if-cached' && req.mode !== 'same-origin') return;
  // 別オリジン(フォントなど)は crossorigin 属性付きの CORS で取得するのでそのまま
  if (new URL(req.url).origin !== self.location.origin) return;

  event.respondWith(
    fetch(req).then((res) => {
      if (res.status === 0) return res;
      const headers = new Headers(res.headers);
      headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
      headers.set('Cross-Origin-Opener-Policy', 'same-origin');
      headers.set('Cross-Origin-Resource-Policy', 'same-origin');
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
    }),
  );
});
