// オフラインでも開けるようにするための Service Worker。
// ネットワーク優先（online なら常に最新を取りに行く）＋ 失敗したらキャッシュを返す。
// この順番にしておくと、アプリを更新したときに古い画面が居座らない。
const CACHE = "workout-cache-v1";
const ASSETS = ["./", "./index.html", "./firebase-sync.js", "./manifest.json", "./icon-192.png", "./icon-512.png"];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  if (event.request.method !== "GET") return;
  // Firebase など外部ドメインへの通信には触らない（キャッシュすると認証が壊れる）
  if (new URL(event.request.url).origin !== location.origin) return;
  event.respondWith(
    fetch(event.request)
      .then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(event.request, copy));
        return res;
      })
      .catch(() => caches.match(event.request).then(hit => hit || caches.match("./index.html")))
  );
});
