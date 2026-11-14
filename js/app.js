import * as db from "./db.js";
import { sb, configured, sync, syncSoon, startAutoSync, onStatus, state as syncState, photoUrl, refreshPending } from "./sync.js";
import { parseBill } from "./parse.js";

/* ================= helpers ================= */
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const num = v => { const n = parseFloat(String(v ?? "").replace(/[^0-9.\-]/g, "")); return isFinite(n) ? n : 0; };
const money = n => Math.round(num(n) * 100) / 100;
const rupee = n => "₹" + money(n).toLocaleString("en-IN", { maximumFractionDigits: 2 });
const today = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };
const digits = p => String(p || "").replace(/\D/g, "");
const phone10 = p => { const d = digits(p); return d.length > 10 ? d.slice(-10) : d; };
const waNum = p => { const d = digits(p); return d.length === 10 ? "91" + d : d; };
const fmtDate = d => { try { return new Date(d + "T00:00").toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }); } catch { return d || ""; } };
const ago = t => { const m = Math.round((Date.now() - t) / 60000); return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} hr ago` : `${Math.round(m / 1440)} days ago`; };
function toast(msg) { const t = $("#toast"); t.textContent = msg; t.classList.add("show"); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove("show"), 2600); }

/* ================= in-memory view of the local DB ================= */
const S = { shops: {}, customers: {}, products: {}, bills: {}, entries: {} };
let UID = null;
let LOCAL_ONLY = false;
const live = t => Object.values(S[t]).filter(r => !r.deleted_at);

async function loadAll() {
  for (const t of db.TABLES) {
    const rows = await db.getAll(t);
    S[t] = Object.fromEntries(rows.map(r => [r.id, r]));
  }
  render();
}

async function write(table, row) {
  const saved = await db.save(table, row);
  S[table][saved.id] = saved;
  afterWrite();
  return saved;
}
async function writeMany(changes) {
  const saved = await db.saveMany(changes);
  changes.forEach((c, i) => { S[c.table][saved[i].id] = saved[i]; });
  afterWrite();
  return saved;
}
function afterWrite() { render(); refreshPending(); if (!LOCAL_ONLY) syncSoon(); }

const shop = () => (UID && S.shops[UID]) || { id: UID, name: "", address: "", phone: "", gstin: "", paper: "a5" };
function balances() {
  const b = {};
  for (const e of live("entries")) b[e.customer_id] = money((b[e.customer_id] || 0) + num(e.amount));
  return b;
}
function lastActivity() {
  const a = {};
  for (const e of live("entries")) if (!a[e.customer_id] || e.entry_date > a[e.customer_id]) a[e.customer_id] = e.entry_date;
  return a;
}

/* ================= sign in ================= */
function showLogin(msg) {
  $("#app").hidden = true; $("#login").hidden = false;
  if (msg) $("#loginIntro").textContent = msg;
  if (!configured) {
    $("#loginIntro").innerHTML = "Cloud backup isn't set up yet. Add your Supabase details in <b>js/config.js</b> (see README), or try the app on this device only.";
    $("#stepEmail").hidden = true; $("#stepCode").hidden = true;
    if (!$("#localOnly")) {
      const b = document.createElement("button"); b.className = "btn"; b.id = "localOnly"; b.textContent = "Try on this device only";
      b.onclick = async () => { await db.metaSet("localOnly", true); startApp("local", true); };
      $("#login .card").appendChild(b);
    }
  }
}
function loginMsg(text, err) { const st = $("#loginStatus"); st.className = err ? "status err" : "status"; st.textContent = text; }
function readLogin() {
  const email = $("#loginEmail").value.trim(), password = $("#loginPass").value;
  if (!/^\S+@\S+\.\S+$/.test(email)) { loginMsg("Enter a valid email.", true); return null; }
  if (password.length < 8) { loginMsg("Password must be at least 8 characters.", true); return null; }
  if (!navigator.onLine) { loginMsg("Connect to the internet to sign in the first time.", true); return null; }
  return { email, password };
}
async function doAuth(kind) {
  const creds = readLogin(); if (!creds) return;
  $("#signIn").disabled = $("#signUp").disabled = true;
  loginMsg(kind === "up" ? "Creating account…" : "Signing in…");
  const { data, error } = kind === "up" ? await sb.auth.signUp(creds) : await sb.auth.signInWithPassword(creds);
  $("#signIn").disabled = $("#signUp").disabled = false;
  if (error) {
    const m = error.message || "";
    loginMsg(/invalid login/i.test(m) ? "Email or password is wrong."
      : /already registered|already exists/i.test(m) ? "This email already has an account. Tap Sign in."
      : /signups? not allowed|disabled/i.test(m) ? "New accounts are turned off for this shop. Tap Sign in."
      : /not confirmed/i.test(m) ? "Email isn't confirmed. Turn off \u201cConfirm email\u201d in Supabase (see README)."
      : m, true);
    return;
  }
  if (!data.session) { loginMsg("Account made, but email confirmation is on. Turn off \u201cConfirm email\u201d in Supabase, then sign in.", true); return; }
  startApp(data.user.id, false);
}
$("#signIn").addEventListener("click", () => doAuth("in"));
$("#signUp").addEventListener("click", () => doAuth("up"));
$("#loginPass").addEventListener("keydown", e => { if (e.key === "Enter") doAuth("in"); });

async function startApp(uid, localOnly) {
  const prev = await db.metaGet("uid");
  if (prev && prev !== uid) {
    if (prev === "local" && !localOnly) {
      // moving from "this device only" to a cloud account: keep everything
      const s = await db.get("shops", "local");
      await db.removeLocal("shops", "local");
      if (s) await db.save("shops", { ...s, id: uid });
      await db.metaSet("localOnly", false);
    } else {
      await db.wipe();                                     // a different account on this device
    }
  }
  await db.metaSet("uid", uid);
  UID = uid; LOCAL_ONLY = localOnly;
  renderStatus(syncState);
  $("#login").hidden = true; $("#app").hidden = false;
  await loadAll();
  db.askPersistent();
  if (!localOnly) {
    startAutoSync(loadAll);
    const { data } = await sb.auth.getUser().catch(() => ({ data: {} }));
    $("#acctInfo").textContent = data?.user?.email ? `Signed in as ${data.user.email}.` : "Signed in.";
  } else {
    $("#acctInfo").textContent = "Not signed in. Records are only on this device — download backups often.";
  }
  checkBackupReminder();
}

async function boot() {
  if (!configured) {
    if (await db.metaGet("localOnly")) return startApp("local", true);
    return showLogin();
  }
  // keys were added after using "this device only": ask to sign in, data is kept
  const { data } = await sb.auth.getSession();
  if (data.session) return startApp(data.session.user.id, false);
  // offline with no session, but records exist from before: open them anyway
  const uid = await db.metaGet("uid");
  if (!navigator.onLine && uid && uid !== "local") return startApp(uid, false);
  showLogin();
}

/* ================= sync status ================= */
function renderStatus(s) {
  const el = $("#sync");
  if (LOCAL_ONLY) { el.innerHTML = `<span class="dot wait"></span>Saved on this device only`; return; }
  let dot = "", text = "";
  if (!s.online) { dot = "off"; text = s.pending ? `Offline. ${s.pending} change${s.pending === 1 ? "" : "s"} saved on this device` : "Offline. Everything is saved on this device"; }
  else if (s.busy) { dot = "wait"; text = "Backing up…"; }
  else if (s.error) { dot = "err"; text = "Backup didn't finish. Tap to try again"; }
  else if (s.pending) { dot = "wait"; text = `${s.pending} change${s.pending === 1 ? "" : "s"} waiting to back up`; }
  else if (s.lastSync) { text = `Backed up to cloud, ${ago(s.lastSync)}`; }
  else { dot = "wait"; text = "Connecting…"; }
  el.innerHTML = `<span class="dot ${dot}"></span>${esc(text)}`;
}
onStatus(renderStatus);
setInterval(() => renderStatus(syncState), 60000);
$("#sync").addEventListener("click", async () => { if (!LOCAL_ONLY) { const n = await sync(); if (n) loadAll(); } });

/* ================= tabs ================= */
const VIEWS = ["dues", "stock", "newbill", "bills"];
function show(v) {
  $$(".tab").forEach(t => t.setAttribute("aria-selected", String(t.dataset.v === v)));
  $$(".view").forEach(s => s.classList.toggle("on", s.id === "v-" + v));
  if (location.hash !== "#" + v) history.replaceState(null, "", "#" + v);
  window.scrollTo(0, 0);
}
$$(".tab").forEach(t => t.addEventListener("click", () => show(t.dataset.v)));
if (VIEWS.includes(location.hash.slice(1))) show(location.hash.slice(1));
window.addEventListener("hashchange", () => { const v = location.hash.slice(1); if (VIEWS.includes(v)) show(v); });

/* ================= render ================= */
function render() {
  $("#shopTitle").textContent = shop().name || "My Shop";
  renderDues(); renderProds(); renderBills();
  $("#prodNames").innerHTML = live("products").map(p => `<option value="${esc(p.name)}">`).join("");
  $("#custNames").innerHTML = live("customers").map(c => `<option value="${esc(c.name)}">${esc([c.place, c.phone].filter(Boolean).join(", "))}</option>`).join("");
  if ($("#custDlg").open && openCustId) renderCustomer();
}

function renderDues() {
  const q = $("#dueSearch").value.trim().toLowerCase();
  const bal = balances(), last = lastActivity();
  const custs = live("customers").map(c => ({ ...c, bal: bal[c.id] || 0, last: last[c.id] || "" }));
  const owing = custs.filter(c => c.bal > 0);
  $("#dueTotal").textContent = rupee(owing.reduce((t, c) => t + c.bal, 0));
  $("#dueCount").textContent = owing.length ? `${owing.length} ${owing.length === 1 ? "person owes" : "people owe"} money` : "No dues right now";
  const showAll = $("#showSettled").checked;
  const shown = custs.filter(c => (showAll || c.bal > 0) && (!q || [c.name, c.phone, c.place].join(" ").toLowerCase().includes(q)))
    .sort((a, b) => b.bal - a.bal || (a.name || "").localeCompare(b.name || ""));
  const list = $("#dueList");
  if (!custs.length) { list.innerHTML = `<div class="empty"><strong>No dues yet</strong>Take a photo of a bill, add one by hand, or save an unpaid bill.</div>`; return; }
  if (!shown.length) { list.innerHTML = `<div class="empty"><strong>${q ? "No match" : "Nobody owes money"}</strong>${q ? "Try a different name or number." : "Tick the box above to see all customers."}</div>`; return; }
  const s = shop();
  list.innerHTML = shown.map(c => {
    const msg = `Namaste ${c.name}, this is a reminder from ${s.name || "our shop"}. Your pending amount is ${rupee(c.bal)}. Please pay at your convenience. Thank you.`;
    return `<div class="row">
      <div class="noimg">${esc((c.name || "?").trim().charAt(0).toUpperCase())}</div>
      <div><div class="name">${esc(c.name)}</div>
        <div class="meta">${esc([c.place, c.phone].filter(Boolean).join(", "))}${c.last ? `<br>Last entry ${esc(fmtDate(c.last))}` : ""}</div></div>
      <div class="due ${c.bal <= 0 ? "paid" : ""}">${c.bal > 0 ? rupee(c.bal) : c.bal < 0 ? "Advance " + rupee(-c.bal) : "Clear"}</div>
      <div class="rowacts">
        ${c.phone ? `<a class="btn small blue" href="tel:${esc(digits(c.phone))}">Call</a>` : ""}
        ${c.phone && c.bal > 0 ? `<a class="btn small" target="_blank" rel="noopener" href="https://wa.me/${esc(waNum(c.phone))}?text=${encodeURIComponent(msg)}">WhatsApp reminder</a>` : ""}
        <button class="btn small" data-cust="${esc(c.id)}">${c.bal > 0 ? "Got payment / history" : "History"}</button>
      </div></div>`;
  }).join("");
}

function renderProds() {
  const q = $("#prodSearch").value.trim().toLowerCase();
  const prods = live("products").sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  const shown = prods.filter(p => !q || (p.name || "").toLowerCase().includes(q));
  const list = $("#prodList");
  if (!prods.length) { list.innerHTML = `<div class="empty"><strong>No products yet</strong>Add what you sell with its buying, wholesale and retail price.</div>`; return; }
  if (!shown.length) { list.innerHTML = `<div class="empty"><strong>No match</strong>Try another product name.</div>`; return; }
  list.innerHTML = shown.map(p => {
    const c = num(p.cost), w = num(p.wholesale), r = num(p.retail);
    const pr = sell => sell && c ? `<div class="p ${sell < c ? "neg" : ""}">${sell < c ? "Loss" : "Profit"} ${rupee(Math.abs(sell - c))} (${Math.round((sell - c) / c * 100)}%)</div>` : "";
    const unit = p.unit ? ` / ${esc(p.unit)}` : "";
    const hasQty = p.qty !== null && p.qty !== undefined && p.qty !== "";
    return `<div class="row" style="grid-template-columns:1fr auto">
      <div><div class="name">${esc(p.name)}</div><div class="meta">${hasQty ? `In stock: ${esc(money(p.qty))} ${esc(p.unit || "")}` : esc(p.unit || "")}</div></div>
      <button class="btn small ghost" data-prod="${esc(p.id)}">Edit</button>
      <div class="prices">
        <div class="price"><div class="k">Bought at</div><div class="v">${c ? rupee(c) + unit : "—"}</div></div>
        <div class="price"><div class="k">Wholesale</div><div class="v">${w ? rupee(w) + unit : "—"}</div>${pr(w)}</div>
        <div class="price"><div class="k">Retail</div><div class="v">${r ? rupee(r) + unit : "—"}</div>${pr(r)}</div>
      </div></div>`;
  }).join("");
}

function renderBills() {
  const q = $("#billSearch").value.trim().toLowerCase();
  const bills = live("bills").sort((a, b) => (b.bill_date || "").localeCompare(a.bill_date || "") || (b.no || "").localeCompare(a.no || ""));
  const shown = bills.filter(b => !q || [b.customer_name, b.phone, b.place, b.no].join(" ").toLowerCase().includes(q));
  const list = $("#billList");
  if (!bills.length) { list.innerHTML = `<div class="empty"><strong>No bills yet</strong>Make one from the New bill tab.</div>`; return; }
  if (!shown.length) { list.innerHTML = `<div class="empty"><strong>No match</strong>Try a different name or number.</div>`; return; }
  list.innerHTML = shown.slice(0, 300).map(b => `<button class="row" style="text-align:left;cursor:pointer;width:100%" data-bill="${esc(b.id)}">
    <div class="noimg" style="font-size:.8rem;width:auto;min-width:52px;padding:0 6px">${esc(b.no)}</div>
    <div><div class="name">${esc(b.customer_name || "Cash customer")}</div><div class="meta">${esc(fmtDate(b.bill_date))}${b.place ? ", " + esc(b.place) : ""}, ${b.items.length} item${b.items.length === 1 ? "" : "s"}</div></div>
    <div class="due ${num(b.total) - num(b.paid) <= 0 ? "paid" : ""}" style="color:var(--ink)">${rupee(b.total)}</div></button>`).join("");
}

$("#dueSearch").addEventListener("input", renderDues);
$("#showSettled").addEventListener("change", renderDues);
$("#prodSearch").addEventListener("input", renderProds);
$("#billSearch").addEventListener("input", renderBills);

document.addEventListener("click", e => {
  const t = e.target.closest("[data-cust],[data-prod],[data-bill],[data-rmrow],[data-rmentry],[data-viewbill]");
  if (!t) return;
  if (t.dataset.cust) openCustomer(t.dataset.cust);
  else if (t.dataset.prod) openProd(S.products[t.dataset.prod]);
  else if (t.dataset.bill) openBill(t.dataset.bill);
  else if (t.dataset.viewbill) openBill(t.dataset.viewbill);
  else if (t.dataset.rmentry) removeEntry(t.dataset.rmentry);
  else if (t.dataset.rmrow) { t.closest("tr").remove(); if (!$("#itemRows").children.length) addRow(); calc(); }
});

/* ================= customers ================= */
// Find a customer by phone (best) or exact name; create one if new.
function resolveCustomer(name, phone, place) {
  name = (name || "").trim(); const p = phone10(phone);
  let c = p ? live("customers").find(c => phone10(c.phone) === p) : null;
  if (!c && name) c = live("customers").find(c => c.name.toLowerCase() === name.toLowerCase() && (!p || !c.phone));
  if (c) {
    const upd = { ...c };
    let changed = false;
    if (p && !c.phone) { upd.phone = p; changed = true; }
    if (place && !c.place) { upd.place = place.trim(); changed = true; }
    return { row: upd, changed };
  }
  return { row: { id: db.uuid(), name: name || "Customer", phone: p, place: (place || "").trim(), note: "", deleted_at: null }, changed: true };
}

let openCustId = null;
function openCustomer(id) {
  openCustId = id;
  const c = S.customers[id];
  $("#cName").value = c.name || ""; $("#cPhone").value = c.phone || ""; $("#cPlace").value = c.place || ""; $("#cNote").value = c.note || "";
  $("#payAmt").value = "";
  renderCustomer();
  $("#custDlg").showModal();
}
function renderCustomer() {
  const c = S.customers[openCustId]; if (!c) return;
  const bal = balances()[c.id] || 0;
  $("#custTitle").textContent = c.name;
  $("#custHead").innerHTML = `<div class="ledger" style="margin:0"><div><div class="lbl">${bal >= 0 ? "Owes" : "Advance paid"}</div>
    <div class="amt" style="${bal <= 0 ? "color:var(--green)" : ""}">${rupee(Math.abs(bal))}</div>
    <div class="lbl">${esc([c.place, c.phone].filter(Boolean).join(", "))}</div></div>
    <div class="actions">${c.phone ? `<a class="btn small blue" href="tel:${esc(digits(c.phone))}">Call</a>` : ""}</div></div>`;
  const ents = live("entries").filter(e => e.customer_id === c.id)
    .sort((a, b) => (b.entry_date || "").localeCompare(a.entry_date || "") || (b.updated_at || "").localeCompare(a.updated_at || ""));
  const label = { bill: "Bill", payment: "Payment received", due: "Old due added", adjust: "Adjustment" };
  $("#custHist").innerHTML = ents.length ? ents.map(e => `<div class="h">
      <div><b>${esc(label[e.kind] || e.kind)}</b> <span class="hint">${esc(fmtDate(e.entry_date))}</span>${e.note ? `<div class="hint" style="margin:0">${esc(e.note)}</div>` : ""}</div>
      <div class="a ${num(e.amount) < 0 ? "minus" : ""}">${num(e.amount) < 0 ? "−" : "+"}${rupee(Math.abs(num(e.amount)))}</div>
      ${e.photo_path ? `<img data-photo="${esc(e.photo_path)}" alt="Bill photo">` : ""}
      <div class="actions" style="grid-column:1/-1">
        ${e.bill_id && S.bills[e.bill_id] ? `<button class="btn small ghost" data-viewbill="${esc(e.bill_id)}">View bill</button>` : ""}
        ${!e.bill_id ? `<button class="btn small ghost danger" data-rmentry="${esc(e.id)}">Remove</button>` : ""}
      </div></div>`).join("") : `<p class="hint">No entries yet.</p>`;
  $$("#custHist img[data-photo]").forEach(async img => {
    const url = await photoUrl(img.dataset.photo);
    if (url) img.src = url; else img.replaceWith(Object.assign(document.createElement("p"), { className: "hint", textContent: "Photo will appear when online." }));
  });
}
$("#custClose").addEventListener("click", () => { $("#custDlg").close(); openCustId = null; });
$("#paySave").addEventListener("click", async () => {
  const amt = num($("#payAmt").value);
  if (amt <= 0) { $("#payAmt").focus(); return; }
  await write("entries", { id: db.uuid(), customer_id: openCustId, kind: "payment", amount: -money(amt), bill_id: null, note: "", photo_path: null, entry_date: today(), deleted_at: null });
  $("#payAmt").value = "";
  const left = balances()[openCustId] || 0;
  toast(left > 0 ? `Saved. ${rupee(left)} still due` : "Saved. Fully paid");
});
async function removeEntry(id) {
  const e = S.entries[id]; if (!e) return;
  if (!confirm(`Remove this ${rupee(Math.abs(num(e.amount)))} entry? You can restore it from a backup.`)) return;
  await write("entries", { ...e, deleted_at: new Date().toISOString() });
  toast("Entry removed");
}
$("#custSave").addEventListener("click", async () => {
  const c = S.customers[openCustId];
  const name = $("#cName").value.trim(); if (!name) return;
  await write("customers", { ...c, name, phone: phone10($("#cPhone").value), place: $("#cPlace").value.trim(), note: $("#cNote").value.trim() });
  toast("Details saved");
});
$("#custDelete").addEventListener("click", async () => {
  const c = S.customers[openCustId]; const bal = balances()[c.id] || 0;
  if (!confirm(bal ? `${c.name} still has ${rupee(bal)} on their account. Remove anyway?` : `Remove ${c.name}?`)) return;
  await write("customers", { ...c, deleted_at: new Date().toISOString() });
  $("#custDlg").close(); openCustId = null; toast("Customer removed");
});

/* ================= add due (photo / manual) ================= */
let dueBlob = null;
function openDue(blob, previewUrl) {
  dueBlob = blob || null;
  ["#dName", "#dPhone", "#dPlace", "#dAmt", "#dNote"].forEach(s => $(s).value = "");
  $("#dDate").value = today();
  $("#duePreview").hidden = !previewUrl; if (previewUrl) $("#duePreview").src = previewUrl;
  $("#dueDlg").showModal(); $("#dName").focus();
}
$("#addDue").addEventListener("click", () => openDue(null));
$("#dName").addEventListener("change", () => {
  const c = live("customers").find(c => c.name.toLowerCase() === $("#dName").value.trim().toLowerCase());
  if (c) { if (!$("#dPhone").value) $("#dPhone").value = c.phone || ""; if (!$("#dPlace").value) $("#dPlace").value = c.place || ""; }
});
function shrink(file, max = 1400, q = 0.72) {
  return new Promise((res, rej) => {
    const img = new Image(), url = URL.createObjectURL(file);
    img.onload = () => {
      const s = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement("canvas"); c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url);
      c.toBlob(b => b ? res(b) : rej(new Error("encode")), "image/jpeg", q);
    };
    img.onerror = rej; img.src = url;
  });
}
$("#duePhoto").addEventListener("change", async e => {
  const f = e.target.files[0]; e.target.value = "";
  if (!f) return;
  try { const b = await shrink(f); openDue(b, URL.createObjectURL(b)); }
  catch { toast("Couldn't open that photo"); }
});
$("#dueSave").addEventListener("click", async () => {
  const name = $("#dName").value.trim(), amt = num($("#dAmt").value);
  if (!name) { $("#dName").focus(); return; }
  if (amt <= 0) { $("#dAmt").focus(); return; }
  const { row: cust, changed } = resolveCustomer(name, $("#dPhone").value, $("#dPlace").value);
  const entryId = db.uuid();
  let photo_path = null;
  if (dueBlob) { photo_path = `${UID}/${entryId}.jpg`; await db.photoPut(photo_path, dueBlob, LOCAL_ONLY); }
  const changes = [];
  if (changed) changes.push({ table: "customers", row: cust });
  changes.push({ table: "entries", row: { id: entryId, customer_id: cust.id, kind: "due", amount: money(amt), bill_id: null, note: $("#dNote").value.trim(), photo_path, entry_date: $("#dDate").value || today(), deleted_at: null } });
  await writeMany(changes);
  $("#dueDlg").close(); dueBlob = null; toast(`${rupee(amt)} added for ${cust.name}`);
});

/* ================= products ================= */
let editingProd = null;
function openProd(p) {
  editingProd = p || null;
  $("#prodDlgTitle").textContent = p ? "Edit product" : "Add product";
  $("#pName").value = p?.name || ""; $("#pCost").value = p?.cost ?? ""; $("#pWhole").value = p?.wholesale ?? "";
  $("#pRetail").value = p?.retail ?? ""; $("#pUnit").value = p?.unit || ""; $("#pQty").value = p?.qty ?? "";
  $("#prodDelete").hidden = !p; $("#prodDlg").showModal();
}
$("#addProd").addEventListener("click", () => openProd(null));
$("#prodSave").addEventListener("click", async () => {
  const name = $("#pName").value.trim(); if (!name) { $("#pName").focus(); return; }
  const opt = v => String(v).trim() === "" ? null : money(v);
  await write("products", { ...(editingProd || { id: db.uuid(), deleted_at: null }), name,
    cost: opt($("#pCost").value), wholesale: opt($("#pWhole").value), retail: opt($("#pRetail").value),
    unit: $("#pUnit").value.trim(), qty: opt($("#pQty").value) });
  $("#prodDlg").close(); toast("Product saved");
});
$("#prodDelete").addEventListener("click", async () => {
  if (!editingProd || !confirm(`Remove ${editingProd.name}?`)) return;
  await write("products", { ...editingProd, deleted_at: new Date().toISOString() });
  $("#prodDlg").close(); toast("Product removed");
});
const findProduct = name => live("products").find(p => (p.name || "").toLowerCase() === String(name || "").trim().toLowerCase());

/* ================= new bill ================= */
function addRow(it = {}) {
  const tr = document.createElement("tr");
  tr.innerHTML = `<td><input class="n" list="prodNames" placeholder="Item" value="${esc(it.name || "")}"></td>
    <td><input class="q" inputmode="decimal" value="${esc(it.qty ?? "")}" placeholder="1"></td>
    <td><input class="r" inputmode="decimal" value="${esc(it.rate ?? "")}" placeholder="0"></td>
    <td class="amt">₹0</td><td><button class="x" data-rmrow="1" aria-label="Remove item">✕</button></td>`;
  $("#itemRows").appendChild(tr);
  tr.querySelector(".n").addEventListener("change", e => {
    const p = findProduct(e.target.value), r = tr.querySelector(".r");
    if (p && !r.value && num(p.retail)) { r.value = num(p.retail); calc(); }
  });
  calc(); return tr;
}
function readItems() {
  return [...$("#itemRows").children].map(tr => {
    const name = tr.querySelector(".n").value.trim(), qRaw = tr.querySelector(".q").value.trim(), rate = money(tr.querySelector(".r").value);
    const qty = qRaw === "" ? (name ? 1 : 0) : num(qRaw);
    return { name, qty, rate, amount: money(qty * rate) };
  }).filter(i => i.name);
}
function calc() {
  [...$("#itemRows").children].forEach(tr => {
    const name = tr.querySelector(".n").value.trim(), qRaw = tr.querySelector(".q").value.trim();
    const q = qRaw === "" ? (name ? 1 : 0) : num(qRaw);
    tr.querySelector(".amt").textContent = rupee(q * num(tr.querySelector(".r").value));
  });
  const total = money(readItems().reduce((t, i) => t + i.amount, 0));
  $("#bTotal").textContent = rupee(total);
  const paidRaw = $("#bPaid").value.trim();
  const named = !!$("#bName").value.trim();
  const paid = paidRaw === "" ? (named ? 0 : total) : num(paidRaw);
  const bal = money(total - paid);
  $("#balHint").textContent = !total ? "Anything not paid goes into Dues for this customer."
    : bal > 0 ? (named ? `${rupee(bal)} will go into Dues for ${$("#bName").value.trim()}.` : "Add the customer's name to keep the unpaid amount in Dues.")
    : named && paidRaw === "" ? "Fill in Paid now if they paid anything." : "Fully paid.";
  return total;
}
$("#itemRows").addEventListener("input", calc);
$("#bPaid").addEventListener("input", calc);
$("#bName").addEventListener("input", calc);
$("#bName").addEventListener("change", () => {
  const c = live("customers").find(c => c.name.toLowerCase() === $("#bName").value.trim().toLowerCase());
  if (c) { if (!$("#bPhone").value) $("#bPhone").value = c.phone || ""; if (!$("#bPlace").value) $("#bPlace").value = c.place || ""; }
});
$("#addRow").addEventListener("click", () => addRow().querySelector(".n").focus());
function clearBill() {
  ["#bName", "#bPhone", "#bPlace", "#bPaid", "#spoken"].forEach(s => $(s).value = "");
  $("#itemRows").innerHTML = ""; addRow(); $("#billStatus").textContent = ""; calc();
}
$("#clearBill").addEventListener("click", () => { if (!readItems().length || confirm("Clear this bill?")) clearBill(); });
addRow();

// voice
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null, listening = false, finalText = "";
function stopListening(autoFill) {
  listening = false; $("#mic").classList.remove("live"); $("#micLabel").textContent = "Tap and speak the bill";
  try { rec && rec.stop(); } catch {}
  if (autoFill && $("#spoken").value.trim()) fillFromText();
}
$("#mic").addEventListener("click", () => {
  const st = $("#billStatus");
  if (!SR) { st.className = "status err"; st.textContent = "Speaking isn't supported in this browser. Type the bill in the box — the same words work."; $("#spoken").focus(); return; }
  if (listening) { stopListening(true); return; }
  rec = new SR(); rec.lang = $("#lang").value; rec.continuous = true; rec.interimResults = true;
  finalText = $("#spoken").value ? $("#spoken").value.trim() + " " : "";
  rec.onresult = ev => {
    let interim = "";
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const r = ev.results[i];
      if (r.isFinal) finalText += r[0].transcript + " "; else interim += r[0].transcript;
    }
    $("#spoken").value = (finalText + interim).trim();
    if (/(done|that's it|bas|ho gaya|हो गया|बस|முடிந்தது|போதும்)\s*[.!]?\s*$/i.test(finalText.trim())) stopListening(true);
  };
  rec.onerror = ev => {
    st.className = "status err";
    st.textContent = ev.error === "not-allowed" || ev.error === "service-not-allowed"
      ? "Microphone permission is off. Allow it in the browser settings, or type the bill instead."
      : ev.error === "network" ? "Voice needs internet on this phone. Type the bill instead." : "Didn't catch that. Tap the mic and try again.";
    stopListening(false);
  };
  rec.onend = () => { if (listening) { try { rec.start(); } catch { stopListening(false); } } };
  try { rec.start(); listening = true; $("#mic").classList.add("live"); $("#micLabel").textContent = "Listening… say “done” when finished"; st.textContent = ""; }
  catch { st.className = "status err"; st.textContent = "Couldn't start the microphone. Type the bill instead."; }
});
$("#fillBill").addEventListener("click", fillFromText);
function fillFromText() {
  const text = $("#spoken").value.trim(), st = $("#billStatus");
  if (!text) { st.className = "status err"; st.textContent = "Speak or type the bill first."; return; }
  const r = parseBill(text, live("products"));
  const c = r.customer;
  if (c.name) $("#bName").value = c.name;
  if (c.phone) $("#bPhone").value = c.phone;
  if (c.place) $("#bPlace").value = c.place;
  if (c.name && !c.phone) $("#bName").dispatchEvent(new Event("change"));
  if (r.items.length) { $("#itemRows").innerHTML = ""; r.items.forEach(i => addRow({ name: i.name, qty: i.qty, rate: i.rate })); }
  if (r.paid != null) $("#bPaid").value = r.paid;
  calc();
  st.className = r.items.length ? "status" : "status err";
  st.textContent = r.items.length ? `Found ${r.items.length} item${r.items.length === 1 ? "" : "s"}. Check them, then save.` : "Couldn't find items. Say each one like “rice 5 kg at 60”.";
}

function nextBillNo(date) {
  const prefix = date.slice(2).replace(/-/g, "");      // 261111
  const n = live("bills").filter(b => (b.no || "").startsWith(prefix + "-")).length + 1;
  return `${prefix}-${n}`;
}
async function saveBill() {
  const items = readItems();
  if (!items.length) { toast("Add at least one item"); return null; }
  const total = money(items.reduce((t, i) => t + i.amount, 0));
  const name = $("#bName").value.trim();
  const paidRaw = $("#bPaid").value.trim();
  const paid = paidRaw === "" ? (name ? 0 : total) : money(paidRaw);
  if (!name && paid < total) { toast("Add the customer's name so the unpaid amount is kept"); $("#bName").focus(); return null; }

  const date = today();
  const billId = db.uuid();
  const changes = [];
  let cust = null;
  if (name) {
    const r = resolveCustomer(name, $("#bPhone").value, $("#bPlace").value);
    cust = r.row; if (r.changed) changes.push({ table: "customers", row: cust });
  }
  const bill = { id: billId, no: nextBillNo(date), customer_id: cust?.id || null, customer_name: cust?.name || name,
    phone: phone10($("#bPhone").value), place: $("#bPlace").value.trim(), items, total, paid, bill_date: date, deleted_at: null };
  changes.push({ table: "bills", row: bill });
  if (cust) {
    changes.push({ table: "entries", row: { id: db.uuid(), customer_id: cust.id, kind: "bill", amount: total, bill_id: billId, note: `Bill ${bill.no}`, photo_path: null, entry_date: date, deleted_at: null } });
    if (paid > 0) changes.push({ table: "entries", row: { id: db.uuid(), customer_id: cust.id, kind: "payment", amount: -paid, bill_id: billId, note: `Paid with bill ${bill.no}`, photo_path: null, entry_date: date, deleted_at: null } });
  }
  for (const i of items) {
    const p = findProduct(i.name);
    if (p && p.qty !== null && p.qty !== undefined && p.qty !== "") changes.push({ table: "products", row: { ...p, qty: money(num(p.qty) - i.qty) } });
  }
  await writeMany(changes);
  clearBill();
  const bal = money(total - paid);
  toast(`Bill ${bill.no} saved${bal > 0 ? `, ${rupee(bal)} added to dues` : ""}`);
  return billId;
}
$("#saveBill").addEventListener("click", async () => { const id = await saveBill(); if (id) openBill(id); });
$("#savePrint").addEventListener("click", async () => { const id = await saveBill(); if (id) printBill(id); });

/* ================= bill view, WhatsApp, print ================= */
function sheetHTML(b) {
  const s = shop(), bal = money(num(b.total) - num(b.paid));
  return `<div class="sheet">
    <h3>${esc(s.name || "My Shop")}</h3>
    <p class="sub">${esc([s.address, s.phone ? "Ph: " + s.phone : "", s.gstin ? "GSTIN: " + s.gstin : ""].filter(Boolean).join(" | "))}</p>
    <div class="meta"><span>Bill no. <span class="hw">${esc(b.no)}</span></span><span>Date <span class="hw">${esc(fmtDate(b.bill_date))}</span></span></div>
    <div class="meta"><span>To <span class="hw">${esc(b.customer_name || "Cash customer")}</span>${b.place ? `, <span class="hw">${esc(b.place)}</span>` : ""}</span>${b.phone ? `<span class="hw">${esc(b.phone)}</span>` : ""}</div>
    <table><thead><tr><th>Item</th><th class="n">Qty</th><th class="n">Rate</th><th class="n">Amount</th></tr></thead>
    <tbody>${b.items.map(i => `<tr><td>${esc(i.name)}</td><td class="n">${esc(money(i.qty))}</td><td class="n">${rupee(i.rate)}</td><td class="n">${rupee(i.amount)}</td></tr>`).join("")}</tbody></table>
    <div class="grand"><span>Total</span><span class="hw">${rupee(b.total)}</span></div>
    ${num(b.paid) ? `<div class="sm"><span>Paid</span><span class="hw">${rupee(b.paid)}</span></div>` : ""}
    ${bal > 0 ? `<div class="sm"><span>Balance</span><span class="hw">${rupee(bal)}</span></div>` : ""}
    <p class="sub" style="margin-top:14px">Thank you, visit again</p></div>`;
}
function billText(b) {
  const s = shop(), bal = money(num(b.total) - num(b.paid));
  return `*${s.name || "My Shop"}*\nBill ${b.no}, ${fmtDate(b.bill_date)}\n${b.customer_name ? "To: " + b.customer_name + "\n" : ""}\n` +
    b.items.map(i => `${i.name}: ${money(i.qty)} x ${rupee(i.rate)} = ${rupee(i.amount)}`).join("\n") +
    `\n\n*Total: ${rupee(b.total)}*` + (num(b.paid) ? `\nPaid: ${rupee(b.paid)}` : "") + (bal > 0 ? `\nBalance: ${rupee(bal)}` : "");
}
let viewingBill = null;
function openBill(id) {
  const b = S.bills[id]; if (!b) return; viewingBill = id;
  $("#billView").innerHTML = sheetHTML(b);
  $("#billWa").href = `https://wa.me/${b.phone ? waNum(b.phone) : ""}?text=${encodeURIComponent(billText(b))}`;
  if (!$("#billDlg").open) $("#billDlg").showModal();
}
function printBill(id) {
  const b = S.bills[id]; if (!b) return;
  const thermal = shop().paper === "58mm";
  const pa = $("#printArea"); pa.className = thermal ? "thermal" : ""; pa.innerHTML = sheetHTML(b);
  let st = $("#pageStyle"); if (!st) { st = document.createElement("style"); st.id = "pageStyle"; document.head.appendChild(st); }
  st.textContent = thermal ? "@page{size:58mm auto;margin:0}" : "@page{size:A5;margin:10mm}";
  if ($("#billDlg").open) $("#billDlg").close();
  setTimeout(() => window.print(), 50);
}
$("#billClose").addEventListener("click", () => $("#billDlg").close());
$("#billPrint").addEventListener("click", () => printBill(viewingBill));
$("#billDelete").addEventListener("click", async () => {
  const b = S.bills[viewingBill]; if (!b) return;
  if (!confirm(`Cancel bill ${b.no}? It will be removed from dues and stock will be added back.`)) return;
  const at = new Date().toISOString();
  const changes = [{ table: "bills", row: { ...b, deleted_at: at } }];
  live("entries").filter(e => e.bill_id === b.id).forEach(e => changes.push({ table: "entries", row: { ...e, deleted_at: at } }));
  for (const i of b.items) {
    const p = findProduct(i.name);
    if (p && p.qty !== null && p.qty !== undefined && p.qty !== "") changes.push({ table: "products", row: { ...p, qty: money(num(p.qty) + num(i.qty)) } });
  }
  await writeMany(changes);
  $("#billDlg").close(); toast(`Bill ${b.no} cancelled`);
});

/* ================= settings + backup ================= */
$("#openSettings").addEventListener("click", async () => {
  const s = shop();
  $("#sName").value = s.name || ""; $("#sAddr").value = s.address || ""; $("#sPhone").value = s.phone || ""; $("#sGst").value = s.gstin || ""; $("#sPaper").value = s.paper || "a5";
  const last = await db.metaGet("lastBackup");
  $("#backupInfo").textContent = (LOCAL_ONLY ? "Cloud backup is off. " : "Everything is backed up to the cloud automatically. ") +
    (last ? `Last downloaded copy: ${ago(last)}.` : "Keep your own copy too: download a backup every week.");
  $("#backupStatus").textContent = "";
  $("#setDlg").showModal();
});
$("#setClose").addEventListener("click", () => $("#setDlg").close());
$("#setSave").addEventListener("click", async () => {
  await write("shops", { ...shop(), id: UID, name: $("#sName").value.trim(), address: $("#sAddr").value.trim(), phone: $("#sPhone").value.trim(), gstin: $("#sGst").value.trim(), paper: $("#sPaper").value, deleted_at: null });
  toast("Shop details saved");
});

async function deliverFile(blob, filename) {
  const file = new File([blob], filename, { type: blob.type });
  if (navigator.canShare && /Android|iPhone|iPad/i.test(navigator.userAgent) && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: filename }); return true; }
    catch (e) { if (e.name === "AbortError") return false; }
  }
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = filename;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  return true;
}
async function exportJson() {
  const tables = {};
  for (const t of db.TABLES) tables[t] = await db.getAll(t);     // includes removed rows, so nothing is lost
  const data = { app: "shop-book", version: 1, exported_at: new Date().toISOString(), tables };
  const ok = await deliverFile(new Blob([JSON.stringify(data)], { type: "application/json" }), `shop-book-backup-${today()}.json`);
  if (ok) { await db.metaSet("lastBackup", Date.now()); checkBackupReminder(); toast("Backup saved"); }
}
$("#exportJson").addEventListener("click", exportJson);
$("#backupNow").addEventListener("click", exportJson);
$("#exportCsv").addEventListener("click", async () => {
  const bal = balances(), last = lastActivity();
  const q = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const rows = [["Name", "Phone", "Place", "Due (Rs)", "Last entry"]].concat(
    live("customers").map(c => [c.name, c.phone, c.place, bal[c.id] || 0, last[c.id] || ""]).sort((a, b) => b[3] - a[3]));
  const csv = "\uFEFF" + rows.map(r => r.map(q).join(",")).join("\r\n");
  await deliverFile(new Blob([csv], { type: "text/csv" }), `dues-${today()}.csv`);
});
$("#importJson").addEventListener("change", async e => {
  const f = e.target.files[0]; e.target.value = ""; if (!f) return;
  const st = $("#backupStatus");
  try {
    const data = JSON.parse(await f.text());
    if (data.app !== "shop-book" || !data.tables) throw new Error("not a Shop Book backup");
    if (!confirm(`Restore from the backup made ${fmtDate(String(data.exported_at).slice(0, 10))}? Anything missing here will be brought back. Newer changes are kept.`)) return;
    let n = 0;
    for (const t of db.TABLES) if (Array.isArray(data.tables[t])) {
      const rows = t === "shops" ? data.tables[t].map(r => ({ ...r, id: UID })) : data.tables[t];
      n += await db.restoreRows(t, rows);
    }
    await loadAll(); refreshPending(); if (!LOCAL_ONLY) syncSoon();
    st.className = "status"; st.textContent = n ? `Restored ${n} record${n === 1 ? "" : "s"}.` : "Nothing to restore. Everything in the backup is already here.";
  } catch (err) {
    st.className = "status err"; st.textContent = "That file isn't a Shop Book backup.";
  }
});
async function checkBackupReminder() {
  const last = await db.metaGet("lastBackup");
  const hasData = live("entries").length + live("bills").length + live("products").length > 0;
  const days = LOCAL_ONLY ? 2 : 7;
  const due = hasData && (!last || Date.now() - last > days * 86400000);
  $("#backupBanner").hidden = !due;
  if (due) $("#backupBannerText").textContent = LOCAL_ONLY
    ? "Records are only on this device. Download a backup so nothing is lost."
    : "Keep your own copy too: you haven't downloaded a backup this week.";
}
$("#syncNow").addEventListener("click", async () => { if (LOCAL_ONLY) { toast("Cloud backup is off"); return; } const n = await sync(); if (n) loadAll(); toast(syncState.error ? "Backup didn't finish. Check internet" : "Backed up"); });
$("#signOut").addEventListener("click", async () => {
  if (!LOCAL_ONLY) {
    await sync();
    const pending = await db.outboxCount();
    if (pending && !confirm(`${pending} change${pending === 1 ? " hasn't" : "s haven't"} reached the cloud yet. Signing out now will lose ${pending === 1 ? "it" : "them"}. Sign out anyway?`)) return;
    await sb.auth.signOut().catch(() => {});
  } else if (!confirm("Records are only on this device. Download a backup first. Remove them and sign out?")) return;
  await db.wipe();
  try { localStorage.clear(); } catch {}
  location.reload();
});
if (sb) sb.auth.onAuthStateChange(ev => { if (ev === "SIGNED_OUT" && !$("#app").hidden) location.reload(); });

/* ================= app updates (service worker) ================= */
if ("serviceWorker" in navigator) {
  const hadController = !!navigator.serviceWorker.controller;   // false on the very first visit
  navigator.serviceWorker.register("sw.js").then(reg => {
    const offer = w => { $("#updateBanner").hidden = false; $("#reloadApp").onclick = () => w.postMessage("SKIP_WAITING"); };
    if (hadController && reg.waiting) offer(reg.waiting);
    reg.addEventListener("updatefound", () => {
      const w = reg.installing;
      w?.addEventListener("statechange", () => { if (w.state === "installed" && hadController) offer(w); });
    });
    setInterval(() => reg.update().catch(() => {}), 60 * 60 * 1000);
  }).catch(() => {});
  let reloading = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (hadController && !reloading) { reloading = true; location.reload(); }
  });
}

boot();
