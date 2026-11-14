// Cloud sync with Supabase. Push local changes, then pull anything newer.
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";
import * as db from "./db.js";

export const configured = !/YOUR-PROJECT|YOUR-ANON-KEY/.test(SUPABASE_URL + SUPABASE_ANON_KEY);

export const sb = configured
  ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
    })
  : null;

const BUCKET = "bill-photos";
const COLUMNS = {
  shops: ["id", "name", "address", "phone", "gstin", "paper", "updated_at", "deleted_at"],
  customers: ["id", "name", "phone", "place", "note", "updated_at", "deleted_at"],
  products: ["id", "name", "cost", "wholesale", "retail", "unit", "qty", "category", "updated_at", "deleted_at"],
  bills: ["id", "no", "customer_id", "customer_name", "phone", "place", "items", "total", "paid", "bill_date", "updated_at", "deleted_at"],
  employees: ["id", "name", "phone", "role", "wage", "wage_type", "note", "updated_at", "deleted_at"],
  attendance: ["id", "employee_id", "att_date", "status", "note", "updated_at", "deleted_at"],
  reminders: ["id", "title", "amount", "due_date", "repeat", "note", "paid_on", "updated_at", "deleted_at"],
  entries: ["id", "customer_id", "kind", "amount", "bill_id", "note", "photo_path", "entry_date", "updated_at", "deleted_at"],
};
const pick = (table, row) => Object.fromEntries(COLUMNS[table].map(c => [c, row[c] === undefined ? null : row[c]]));

let running = null;
let again = false;
const listeners = new Set();
export const state = { lastSync: null, pending: 0, online: navigator.onLine, error: null, busy: false };
export function onStatus(fn) { listeners.add(fn); fn(state); return () => listeners.delete(fn); }
function emit() { listeners.forEach(fn => fn(state)); }

export async function refreshPending() { state.pending = await db.outboxCount(); emit(); }

async function push() {
  const items = await db.outboxAll();
  if (!items.length) return;
  const byTable = {};
  for (const it of items) (byTable[it.table] ||= []).push(it);
  // parents first, so a bill never arrives before its customer
  for (const table of db.TABLES) {
    const list = byTable[table];
    if (!list) continue;
    for (let i = 0; i < list.length; i += 200) {
      const chunk = list.slice(i, i + 200);
      const rows = (await Promise.all(chunk.map(it => db.get(table, it.id)))).filter(Boolean).map(r => pick(table, r));
      if (rows.length) {
        const { error } = await sb.from(table).upsert(rows, { onConflict: "id" });
        if (error) throw error;
      }
      await db.outboxAck(chunk);
    }
  }
}

async function pull() {
  let changed = 0;
  for (const table of db.TABLES) {
    let cursor = (await db.metaGet("pull:" + table)) || "1970-01-01T00:00:00Z";
    for (;;) {
      const { data, error } = await sb.from(table).select("*").gte("synced_at", cursor).order("synced_at", { ascending: true }).limit(1000);
      if (error) throw error;
      changed += await db.applyRemote(table, data);
      if (data.length) cursor = data[data.length - 1].synced_at;
      await db.metaSet("pull:" + table, cursor);
      if (data.length < 1000) break;
    }
  }
  return changed;
}

async function uploadPhotos() {
  const pending = await db.photosPending();
  for (const p of pending) {
    const { error } = await sb.storage.from(BUCKET).upload(p.path, p.blob, { upsert: true, contentType: "image/jpeg" });
    if (error && !/exists/i.test(error.message || "")) throw error;
    await db.photoPut(p.path, p.blob, true);
  }
}

// Fetch a photo for display: local copy first, cloud if needed.
export async function photoUrl(path) {
  if (!path) return null;
  const local = await db.photoGet(path);
  if (local) return URL.createObjectURL(local.blob);
  if (!sb || !navigator.onLine) return null;
  const { data, error } = await sb.storage.from(BUCKET).download(path);
  if (error || !data) return null;
  await db.photoPut(path, data, true);
  return URL.createObjectURL(data);
}

// Run one sync. Calls made while a sync is running queue exactly one more.
export function sync() {
  if (!sb) return Promise.resolve(0);
  if (running) { again = true; return running; }
  running = (async () => {
    let changed = 0;
    try {
      state.online = navigator.onLine;
      if (!state.online) return 0;
      const { data } = await sb.auth.getSession();
      if (!data.session) return 0;
      state.busy = true; state.error = null; emit();
      await push();
      await uploadPhotos();
      changed = await pull();
      state.lastSync = Date.now();
      await db.metaSet("lastSync", state.lastSync);
    } catch (e) {
      state.error = e?.message || String(e);
      console.warn("Sync failed", e);
    } finally {
      state.busy = false;
      await refreshPending();
      running = null;
      if (again) { again = false; setTimeout(sync, 0); }
    }
    return changed;
  })();
  return running;
}

let debounce, changedCb = null;
export function syncSoon() {
  clearTimeout(debounce);
  debounce = setTimeout(async () => { const n = await sync(); if (n && changedCb) changedCb(); }, 1500);
}

export async function startAutoSync(onChanged) {
  changedCb = onChanged;
  state.lastSync = (await db.metaGet("lastSync")) || null;
  await refreshPending();
  const go = async () => { const n = await sync(); if (n) onChanged(); };
  window.addEventListener("online", () => { state.online = true; emit(); go(); });
  window.addEventListener("offline", () => { state.online = false; emit(); });
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") go(); });
  setInterval(() => { if (document.visibilityState === "visible") go(); }, 60000);
  go();
}
