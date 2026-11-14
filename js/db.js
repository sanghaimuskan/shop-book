// Local database (IndexedDB). Every change is saved here first, then queued
// in the outbox for the cloud. The app never waits on the network.

export const TABLES = ["shops", "customers", "products", "bills", "entries"];
const DB_NAME = "shopbook";
const VERSION = 1;

let dbPromise;
function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, VERSION);
    r.onupgradeneeded = () => {
      const d = r.result;
      for (const t of TABLES) if (!d.objectStoreNames.contains(t)) d.createObjectStore(t, { keyPath: "id" });
      if (!d.objectStoreNames.contains("outbox")) d.createObjectStore("outbox", { keyPath: "key" });
      if (!d.objectStoreNames.contains("photos")) d.createObjectStore("photos", { keyPath: "path" });
      if (!d.objectStoreNames.contains("meta")) d.createObjectStore("meta");
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  return dbPromise;
}

const req = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

async function run(stores, mode, fn) {
  const d = await open();
  return new Promise((resolve, reject) => {
    const t = d.transaction(stores, mode);
    let out;
    try { out = fn(t); } catch (e) { reject(e); return; }
    t.oncomplete = () => Promise.resolve(out).then(resolve, reject);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error("Transaction aborted"));
  });
}

export const uuid = () => crypto.randomUUID();
export const nowIso = () => new Date().toISOString();

export function getAll(table) {
  return run([table], "readonly", t => req(t.objectStore(table).getAll()));
}
export function get(table, id) {
  return run([table], "readonly", t => req(t.objectStore(table).get(id)));
}

// Save a local change and queue it for upload — one atomic step.
export async function save(table, row) {
  const stamped = { ...row, updated_at: nowIso() };
  await run([table, "outbox"], "readwrite", t => {
    t.objectStore(table).put(stamped);
    t.objectStore("outbox").put({ key: table + ":" + stamped.id, table, id: stamped.id, updated_at: stamped.updated_at });
  });
  return stamped;
}

// Save several changes atomically (e.g. a bill + its ledger entries + stock).
export async function saveMany(changes) {
  const stamp = nowIso();
  const stores = [...new Set(changes.map(c => c.table)), "outbox"];
  const out = changes.map(c => ({ table: c.table, row: { ...c.row, updated_at: stamp } }));
  await run(stores, "readwrite", t => {
    for (const { table, row } of out) {
      t.objectStore(table).put(row);
      t.objectStore("outbox").put({ key: table + ":" + row.id, table, id: row.id, updated_at: row.updated_at });
    }
  });
  return out.map(o => o.row);
}

// Merge rows that came from the cloud. A newer local row always wins.
export function applyRemote(table, rows) {
  if (!rows.length) return Promise.resolve(0);
  return run([table], "readwrite", t => {
    const s = t.objectStore(table);
    let changed = 0;
    for (const remote of rows) {
      const g = s.get(remote.id);
      g.onsuccess = () => {
        const local = g.result;
        if (!local || remote.updated_at >= local.updated_at) { s.put(remote); changed++; }
      };
    }
    return new Promise(res => { t.addEventListener("complete", () => res(changed)); });
  });
}

export function outboxAll() {
  return run(["outbox"], "readonly", t => req(t.objectStore("outbox").getAll()));
}
export function outboxCount() {
  return run(["outbox"], "readonly", t => req(t.objectStore("outbox").count()));
}
// Remove from the outbox only if nothing changed since we uploaded it.
export function outboxAck(items) {
  return run(["outbox"], "readwrite", t => {
    const s = t.objectStore("outbox");
    for (const it of items) {
      const g = s.get(it.key);
      g.onsuccess = () => { if (g.result && g.result.updated_at === it.updated_at) s.delete(it.key); };
    }
  });
}

export function metaGet(key) {
  return run(["meta"], "readonly", t => req(t.objectStore("meta").get(key)));
}
export function metaSet(key, value) {
  return run(["meta"], "readwrite", t => { t.objectStore("meta").put(value, key); });
}

export function photoPut(path, blob, uploaded) {
  return run(["photos"], "readwrite", t => { t.objectStore("photos").put({ path, blob, uploaded: !!uploaded }); });
}
export function photoGet(path) {
  return run(["photos"], "readonly", t => req(t.objectStore("photos").get(path)));
}
export function photosPending() {
  return run(["photos"], "readonly", t => req(t.objectStore("photos").getAll()))
    .then(all => all.filter(p => !p.uploaded));
}

// Ask the browser not to clear this app's data when the phone is low on space.
export async function askPersistent() {
  try {
    if (navigator.storage && navigator.storage.persist) {
      if (await navigator.storage.persisted()) return true;
      return await navigator.storage.persist();
    }
  } catch {}
  return false;
}

// Wipe local data (used on sign-out, only after everything has synced).
export async function wipe() {
  const d = await open();
  d.close(); dbPromise = null;
  await new Promise((res, rej) => { const r = indexedDB.deleteDatabase(DB_NAME); r.onsuccess = res; r.onerror = () => rej(r.error); r.onblocked = res; });
}

// Restore rows from a backup file. A row is only written if it's missing here
// or the backup copy is newer, and it keeps its original timestamp so the
// server can still refuse it if the cloud has something newer.
export async function restoreRows(table, rows) {
  let written = 0;
  await run([table, "outbox"], "readwrite", t => {
    const s = t.objectStore(table), o = t.objectStore("outbox");
    for (const row of rows) {
      if (!row || !row.id || !row.updated_at) continue;
      const g = s.get(row.id);
      g.onsuccess = () => {
        const local = g.result;
        if (!local || row.updated_at > local.updated_at) {
          s.put(row); written++;
          o.put({ key: table + ":" + row.id, table, id: row.id, updated_at: row.updated_at });
        }
      };
    }
  });
  return written;
}

// Drop a row and its queued upload from this device only.
export function removeLocal(table, id) {
  return run([table, "outbox"], "readwrite", t => {
    t.objectStore(table).delete(id);
    t.objectStore("outbox").delete(table + ":" + id);
  });
}
