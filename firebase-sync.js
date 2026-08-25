// ===== クラウド同期（Firebase Firestore + Googleログイン） =====
//
// 設計の方針:
//   - localStorage が主。クラウドは「もう一つの置き場所」として扱う
//   - 通信やSDKの読み込みに失敗しても、アプリ本体はそのまま動く
//   - 同期は「足りないものを互いに補う」マージ方式。記録は id で識別する
//
// Firebase の設定値。公開されても問題ない値で、
// 安全性は Firestore のセキュリティルール（ログインした本人だけが読み書きできる）で担保する。
const firebaseConfig = {
  apiKey: "AIzaSyDbdsmtBfoPnM5PxbMDMA91KzUPUUVpyhs",
  authDomain: "workout-app-27d33.firebaseapp.com",
  projectId: "workout-app-27d33",
  storageBucket: "workout-app-27d33.firebasestorage.app",
  messagingSenderId: "855945464580",
  appId: "APPID_未設定"
};

const SDK = "https://www.gstatic.com/firebasejs/10.12.2/";
const LOGS_KEY = "workout-logs-v1";
const PHOTOS_KEY = "workout-photos-v1";

const card       = document.getElementById("cloudCard");
const statusEl   = document.getElementById("cloudStatus");
const noteEl     = document.getElementById("cloudNote");
const signInBtn  = document.getElementById("cloudSignIn");
const signOutBtn = document.getElementById("cloudSignOut");
const syncBtn    = document.getElementById("cloudSyncNow");

const status = t => { statusEl.textContent = t; };
const note   = t => { noteEl.textContent = t; };

let A, F, auth, db;
let currentUid = null;
let syncing = false, queued = false;

// SDKの読み込み。オフラインならここで失敗するが、アプリ本体には影響させない。
try {
  const [appMod, authMod, fsMod] = await Promise.all([
    import(SDK + "firebase-app.js"),
    import(SDK + "firebase-auth.js"),
    import(SDK + "firebase-firestore.js")
  ]);
  A = authMod;
  F = fsMod;
  const app = appMod.initializeApp(firebaseConfig);
  auth = A.getAuth(app);
  db = F.getFirestore(app);
  card.hidden = false;
  start();
} catch (e) {
  console.log("クラウド同期は利用できません（オフラインなど）:", e);
}

function start() {
  signInBtn.onclick = async () => {
    const provider = new A.GoogleAuthProvider();
    try {
      await A.signInWithPopup(auth, provider);
    } catch (e) {
      // ホーム画面に追加したアプリではポップアップが開けないことがあるので、画面遷移方式に切り替える
      if (String(e.code || "").includes("popup")) {
        await A.signInWithRedirect(auth, provider);
        return;
      }
      note("ログインできませんでした：" + (e.code || e.message));
    }
  };
  signOutBtn.onclick = () => A.signOut(auth);
  syncBtn.onclick = () => syncNow();

  A.getRedirectResult(auth).catch(() => {});

  A.onAuthStateChanged(auth, user => {
    currentUid = user ? user.uid : null;
    signInBtn.hidden  = !!user;
    signOutBtn.hidden = !user;
    syncBtn.hidden    = !user;

    if (user) {
      status(user.email || "ログイン中");
      note("記録を保存するたびに、自動でクラウドへ反映されます。");
      window.cloudSync = () => syncNow();   // 本体側の saveLogs / savePhotos から呼ばれる
      syncNow();
    } else {
      status("未ログイン");
      note("Googleでログインすると、どの端末・ブラウザからでも同じ記録を見られます。");
      delete window.cloudSync;
    }
  });
}

async function syncNow() {
  if (!currentUid) return;
  if (syncing) { queued = true; return; }   // 同期中に呼ばれたら、終わってから一度だけやり直す
  syncing = true;
  try {
    status("同期中…");
    await syncLogs();
    await syncPhotos();
    const now = new Date().toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });
    status("✓ " + now + " 同期");
  } catch (e) {
    status("同期エラー");
    note("同期できませんでした：" + (e.code || e.message));
    console.error(e);
  } finally {
    syncing = false;
    if (queued) { queued = false; syncNow(); }
  }
}

// 記録の同期：クラウドと端末で足りないものを互いに補い、削除済みは両方から消す
async function syncLogs() {
  const uid = currentUid;
  const snap = await F.getDocs(F.collection(db, "users", uid, "logs"));
  const remote = new Map();
  snap.forEach(d => remote.set(d.id, d.data()));

  const deleted  = window.loadDeleted();
  const local    = window.loadLogs();
  const localIds = new Set(local.map(l => String(l.id)));

  const batch = F.writeBatch(db);
  let writes = 0;

  for (const id of deleted) {
    if (remote.has(id)) {
      batch.delete(F.doc(db, "users", uid, "logs", id));
      remote.delete(id);
      writes++;
    }
  }
  for (const log of local) {
    const id = String(log.id);
    if (!remote.has(id)) {
      batch.set(F.doc(db, "users", uid, "logs", id), log);
      writes++;
    }
  }
  if (writes) await batch.commit();

  // クラウドにしかない記録を端末に取り込む
  const incoming = [];
  remote.forEach((data, id) => {
    if (!localIds.has(id) && !deleted.includes(id)) incoming.push(data);
  });
  if (incoming.length) {
    // saveLogs を使うと同期が再帰的に走るので、ここでは直接書き込む
    localStorage.setItem(LOGS_KEY, JSON.stringify(local.concat(incoming)));
    window.renderHome();
  }
}

// マシン写真の同期。ドキュメントを種目ごとに分けて、1件あたりの容量制限を避けている
async function syncPhotos() {
  const uid = currentUid;
  const snap = await F.getDocs(F.collection(db, "users", uid, "photos"));
  const remote = new Map();
  snap.forEach(d => remote.set(d.id, d.data().data));

  const local   = window.loadPhotos();
  const deleted = window.loadDeletedPhotos();

  const batch = F.writeBatch(db);
  let writes = 0;

  for (const name of deleted) {
    if (remote.has(name)) {
      batch.delete(F.doc(db, "users", uid, "photos", name));
      remote.delete(name);
      writes++;
    }
  }
  for (const name in local) {
    if (!remote.has(name)) {
      batch.set(F.doc(db, "users", uid, "photos", name), { data: local[name] });
      writes++;
    }
  }
  if (writes) await batch.commit();

  let changed = false;
  remote.forEach((data, name) => {
    if (data && !local[name] && !deleted.includes(name)) { local[name] = data; changed = true; }
  });
  if (changed) {
    localStorage.setItem(PHOTOS_KEY, JSON.stringify(local));
    window.renderHome();
  }
}
