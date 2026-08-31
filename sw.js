// オフラインでも開けるようにするための Service Worker。
// ネットワーク優先（online なら常に最新を取りに行く）＋ 失敗したらキャッシュを返す。
// この順番にしておくと、アプリを更新したときに古い画面が居座らない。
const CACHE = "workout-cache-v1";
const ASSETS = ["./", "./index.html", "./firebase-sync.js", "./manifest.json",
                "./icons/icon-192-v2.png", "./icons/icon-512-v2.png"];

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
  // GitHub Pages は max-age=600 を返すので、そのままだと10分間は古い版が使われる。
  // 中身が変わりうるファイル（HTML/JS/JSON）はHTTPキャッシュを迂回して必ず取りに行く。
  const path = new URL(event.request.url).pathname;
  const isCode = event.request.mode === "navigate" || /\.(html|js|json)$/.test(path) || path.endsWith("/");
  const request = isCode ? new Request(event.request, { cache: "reload" }) : event.request;

  event.respondWith(
    fetch(request)
      .then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(event.request, copy));
        return res;
      })
      .catch(() => caches.match(event.request).then(hit => hit || caches.match("./index.html")))
  );
});

// 通知をタップしたら、開いているタブがあればそれを前面に、無ければ新しく開く
self.addEventListener("notificationclick", event => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
      for (const c of list) if ("focus" in c) return c.focus();
      if (self.clients.openWindow) return self.clients.openWindow("./");
    })
  );
});
