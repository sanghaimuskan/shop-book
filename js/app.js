import * as db from "./db.js";
import { sb, configured, sync, syncSoon, startAutoSync, onStatus, state as syncState, refreshPending } from "./sync.js";

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
const S = { shops: {}, customers: {}, products: {}, bills: {}, entries: {}, employees: {}, attendance: {}, reminders: {} };
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
const VIEWS = ["dues", "stock", "newbill", "bills", "staff", "payments"];
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
  $("#shopTitle").textContent = shop().name || "Arun Cloth Store";
  renderDues(); renderProds(); renderBills(); buildAtt(); renderStaff(); renderReminders();
  $("#catNames").innerHTML = categories().map(c => `<option value="${esc(c)}">`).join("");
  $("#prodNames").innerHTML = live("products").map(p => `<option value="${esc(p.name)}">`).join("");
  $("#custNames").innerHTML = live("customers").map(c => `<option value="${esc(c.name)}">${esc([c.place, c.phone].filter(Boolean).join(", "))}</option>`).join("");
  if ($("#custDlg").open && openCustId) renderCustomer();
  if ($("#empDlg").open && editingEmp) renderEmpMonth();
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
  if (!custs.length) { list.innerHTML = `<div class="empty"><strong>No dues yet</strong>Add one with Add due, or save an unpaid bill.</div>`; return; }
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

let catFilter = "";
const categories = () => [...new Set(live("products").map(p => (p.category || "").trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
function renderProds() {
  const q = $("#prodSearch").value.trim().toLowerCase();
  const prods = live("products").sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  const cats = categories();
  if (catFilter && !cats.includes(catFilter) && catFilter !== "\u0000") catFilter = "";
  const hasUncat = prods.some(p => !(p.category || "").trim());
  const chip = (v, label) => `<button class="chip" data-cat="${esc(v)}" aria-pressed="${catFilter === v}">${esc(label)}</button>`;
  $("#catChips").hidden = !cats.length;
  $("#catChips").innerHTML = cats.length ? chip("", "All") + cats.map(c => chip(c, c)).join("") + (hasUncat ? chip("\u0000", "No category") : "") : "";
  const shown = prods.filter(p => (!q || (p.name || "").toLowerCase().includes(q) || (p.category || "").toLowerCase().includes(q)) &&
    (!catFilter || (catFilter === "\u0000" ? !(p.category || "").trim() : (p.category || "").trim() === catFilter)));
  const list = $("#prodList");
  if (!prods.length) { list.innerHTML = `<div class="empty"><strong>No products yet</strong>Add what you sell with its buying, wholesale and retail price.</div>`; return; }
  if (!shown.length) { list.innerHTML = `<div class="empty"><strong>No match</strong>Try another product name.</div>`; return; }
  list.innerHTML = shown.map(p => {
    const c = num(p.cost), w = num(p.wholesale), r = num(p.retail);
    const pr = sell => sell && c ? `<div class="p ${sell < c ? "neg" : ""}">${sell < c ? "Loss" : "Profit"} ${rupee(Math.abs(sell - c))} (${Math.round((sell - c) / c * 100)}%)</div>` : "";
    const unit = p.unit ? ` / ${esc(p.unit)}` : "";
    const hasQty = p.qty !== null && p.qty !== undefined && p.qty !== "";
    const qn = num(p.qty), stockCls = !hasQty ? "none" : qn <= 0 ? "out" : qn <= 5 ? "low" : "ok";
    const stock = `<div class="stock ${stockCls}"><div class="k">${!hasQty ? "Stock" : qn <= 0 ? "Out of stock" : qn <= 5 ? "Low stock" : "In stock"}</div><div class="v">${hasQty ? esc(money(p.qty)) : "—"}</div>${hasQty && p.unit ? `<div class="u">${esc(p.unit)}</div>` : ""}</div>`;
    return `<div class="row" style="grid-template-columns:1fr auto auto">
      <div><div class="name">${esc(p.name)}</div><div class="meta">${(p.category || "").trim() ? `<span class="tag">${esc(p.category.trim())}</span>` : ""}${hasQty ? "" : "Stock not entered"}</div></div>
      ${stock}
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
$("#catChips").addEventListener("click", e => { const b = e.target.closest("[data-cat]"); if (b) { catFilter = b.dataset.cat; renderProds(); } });
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
      <div class="actions" style="grid-column:1/-1">
        ${e.bill_id && S.bills[e.bill_id] ? `<button class="btn small ghost" data-viewbill="${esc(e.bill_id)}">View bill</button>` : ""}
        ${!e.bill_id ? `<button class="btn small ghost danger" data-rmentry="${esc(e.id)}">Remove</button>` : ""}
      </div></div>`).join("") : `<p class="hint">No entries yet.</p>`;
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

/* ================= add due ================= */
function openDue() {
  ["#dName", "#dPhone", "#dPlace", "#dAmt", "#dNote"].forEach(s => $(s).value = "");
  $("#dDate").value = today();
  $("#dueDlg").showModal(); $("#dName").focus();
}
$("#addDue").addEventListener("click", () => openDue());
$("#dName").addEventListener("change", () => {
  const c = live("customers").find(c => c.name.toLowerCase() === $("#dName").value.trim().toLowerCase());
  if (c) { if (!$("#dPhone").value) $("#dPhone").value = c.phone || ""; if (!$("#dPlace").value) $("#dPlace").value = c.place || ""; }
});
$("#dueSave").addEventListener("click", async () => {
  const name = $("#dName").value.trim(), amt = num($("#dAmt").value);
  if (!name) { $("#dName").focus(); return; }
  if (amt <= 0) { $("#dAmt").focus(); return; }
  const { row: cust, changed } = resolveCustomer(name, $("#dPhone").value, $("#dPlace").value);
  const entryId = db.uuid();
  const changes = [];
  if (changed) changes.push({ table: "customers", row: cust });
  changes.push({ table: "entries", row: { id: entryId, customer_id: cust.id, kind: "due", amount: money(amt), bill_id: null, note: $("#dNote").value.trim(), photo_path: null, entry_date: $("#dDate").value || today(), deleted_at: null } });
  await writeMany(changes);
  $("#dueDlg").close(); toast(`${rupee(amt)} added for ${cust.name}`);
});

// Enter inside a field saves (instead of silently closing the dialog)
$("#dueDlg form").addEventListener("submit", e => { if (e.submitter?.value === "cancel") return; e.preventDefault(); $("#dueSave").click(); });

/* ================= products ================= */
let editingProd = null;
function openProd(p) {
  editingProd = p || null;
  $("#prodDlgTitle").textContent = p ? "Edit product" : "Add product";
  $("#pName").value = p?.name || ""; $("#pCost").value = p?.cost ?? ""; $("#pWhole").value = p?.wholesale ?? "";
  $("#pRetail").value = p?.retail ?? ""; $("#pUnit").value = p?.unit || ""; $("#pQty").value = p?.qty ?? ""; $("#pCat").value = p?.category || "";
  $("#prodDelete").hidden = !p; $("#prodDlg").showModal();
}
$("#addProd").addEventListener("click", () => openProd(null));
$("#prodSave").addEventListener("click", async () => {
  const name = $("#pName").value.trim(); if (!name) { $("#pName").focus(); return; }
  const opt = v => String(v).trim() === "" ? null : money(v);
  await write("products", { ...(editingProd || { id: db.uuid(), deleted_at: null }), name,
    cost: opt($("#pCost").value), wholesale: opt($("#pWhole").value), retail: opt($("#pRetail").value),
    unit: $("#pUnit").value.trim(), category: $("#pCat").value.trim(), qty: opt($("#pQty").value) });
  $("#prodDlg").close(); toast("Product saved");
});
$("#prodDelete").addEventListener("click", async () => {
  if (!editingProd || !confirm(`Remove ${editingProd.name}?`)) return;
  await write("products", { ...editingProd, deleted_at: new Date().toISOString() });
  $("#prodDlg").close(); toast("Product removed");
});
$("#prodDlg form").addEventListener("submit", e => { if (e.submitter?.value === "cancel") return; e.preventDefault(); $("#prodSave").click(); });
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
$("#itemRows").addEventListener("input", e => { e.target.classList.remove("warn"); calc(); });
$("#bPaid").addEventListener("input", calc);
$("#bName").addEventListener("input", calc);
$("#bName").addEventListener("change", () => {
  const c = live("customers").find(c => c.name.toLowerCase() === $("#bName").value.trim().toLowerCase());
  if (c) { if (!$("#bPhone").value) $("#bPhone").value = c.phone || ""; if (!$("#bPlace").value) $("#bPlace").value = c.place || ""; }
});
$("#addRow").addEventListener("click", () => addRow().querySelector(".n").focus());
function clearBill() {
  ["#bName", "#bPhone", "#bPlace", "#bPaid"].forEach(s => $(s).value = "");
  $("#itemRows").innerHTML = ""; addRow(); calc();
}
$("#clearBill").addEventListener("click", () => { if (!readItems().length || confirm("Clear this bill?")) clearBill(); });
addRow();

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
    <h3>${esc(s.name || "Arun Cloth Store")}</h3>
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
  return `*${s.name || "Arun Cloth Store"}*\nBill ${b.no}, ${fmtDate(b.bill_date)}\n${b.customer_name ? "To: " + b.customer_name + "\n" : ""}\n` +
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

/* ================= dates ================= */
const pad2 = n => String(n).padStart(2, "0");
const ymd = (y, m, d) => `${y}-${pad2(m)}-${pad2(d)}`;
const addDays = (d, n) => { const x = new Date(d + "T00:00"); x.setDate(x.getDate() + n); return ymd(x.getFullYear(), x.getMonth() + 1, x.getDate()); };
const daysBetween = (a, b) => Math.round((new Date(b + "T00:00") - new Date(a + "T00:00")) / 864e5);
const byName = (a, b) => (a.name || "").localeCompare(b.name || "");

/* ================= staff + attendance ================= */
let attDay = today();
let attIdx = {};
function buildAtt() {
  attIdx = {};
  for (const r of Object.values(S.attendance)) {            // two phones may both mark a day: the newest wins
    const k = r.employee_id + "|" + r.att_date, o = attIdx[k];
    if (!o || (r.updated_at || "") > (o.updated_at || "")) attIdx[k] = r;
  }
}
const attOf = (emp, d) => { const r = attIdx[emp + "|" + d]; return r && !r.deleted_at ? r.status : null; };
function attRow(emp, date, status) {
  const old = attIdx[emp + "|" + date];
  const cur = old && !old.deleted_at ? old.status : null;
  if (status === cur) status = null;                          // tapping the same button again clears the day
  if (!status && !cur) return null;
  const keep = status === "present" || status === "half";
  return { ...(old || { id: db.uuid(), employee_id: emp, att_date: date, note: "" }), status: status || cur, deleted_at: status ? null : new Date().toISOString(),
    check_in: keep && old ? old.check_in || null : null, check_out: keep && old ? old.check_out || null : null };
}
const nowHM = () => { const d = new Date(); return pad2(d.getHours()) + ":" + pad2(d.getMinutes()); };
const toMin = t => { const m = /^(\d{1,2}):(\d{2})/.exec(t || ""); return m ? +m[1] * 60 + +m[2] : null; };
const worked = (a, b) => { const x = toMin(a), y = toMin(b); return x != null && y != null && y > x ? y - x : 0; };
const hm = mins => `${Math.floor(mins / 60)}h ${pad2(mins % 60)}m`;
const attFull = (emp, d) => { const r = attIdx[emp + "|" + d]; return r && !r.deleted_at ? r : null; };
// record check-in / check-out; this also marks the person present if they weren't marked yet
async function setTime(emp, date, field, value) {
  const old = attFull(emp, date);
  await write("attendance", { ...(old || { id: db.uuid(), employee_id: emp, att_date: date, note: "", status: "present", check_in: null, check_out: null }),
    deleted_at: null, status: old?.status === "half" ? "half" : old?.status === "absent" ? "present" : old?.status || "present", [field]: value || null });
}
async function setAtt(emp, date, status) { const row = attRow(emp, date, status); if (row) await write("attendance", row); }
function monthHours(emp, ym) {
  let m = 0;
  for (const r of Object.values(attIdx)) if (!r.deleted_at && r.employee_id === emp && String(r.att_date).startsWith(ym)) m += worked(r.check_in, r.check_out);
  return m;
}
function monthStats(emp, ym) {
  let p = 0, h = 0, a = 0;
  for (const r of Object.values(attIdx)) {
    if (r.deleted_at || r.employee_id !== emp || !String(r.att_date).startsWith(ym)) continue;
    if (r.status === "present") p++; else if (r.status === "half") h++; else if (r.status === "absent") a++;
  }
  return { p, h, a };
}
const pills = (p, h, a, n) => `<span class="pill present">Present ${p}</span><span class="pill half">Half day ${h}</span><span class="pill absent">Absent ${a}</span>` + (n != null ? `<span class="pill">Not marked ${n}</span>` : "");

function renderStaff() {
  $("#attDate").value = attDay;
  const wd = new Date(attDay + "T00:00").toLocaleDateString("en-IN", { weekday: "long" });
  $("#attDay").textContent = attDay === today() ? `Today, ${wd}` : wd;
  const emps = live("employees").sort(byName);
  const list = $("#empList");
  $("#allPresent").disabled = !emps.length;
  if (!emps.length) { $("#attSum").innerHTML = ""; list.innerHTML = `<div class="empty"><strong>No staff yet</strong>Tap Add staff, then mark who came each day with one tap.</div>`; return; }
  let p = 0, h = 0, a = 0;
  emps.forEach(e => { const s = attOf(e.id, attDay); if (s === "present") p++; else if (s === "half") h++; else if (s === "absent") a++; });
  $("#attSum").innerHTML = pills(p, h, a, emps.length - p - h - a);
  const ym = attDay.slice(0, 7);
  list.innerHTML = emps.map(e => {
    const cur = attOf(e.id, attDay), m = monthStats(e.id, ym), rec = attFull(e.id, attDay);
    const tin = rec?.check_in || "", tout = rec?.check_out || "", wk = worked(tin, tout);
    const tcell = (f, label, val) => val
      ? `<label class="tm"><span>${label}</span><input type="time" value="${esc(val)}" data-time="${esc(e.id)}" data-f="${f}"></label>`
      : `<button class="btn tmbtn" data-now="${esc(e.id)}" data-f="${f}">${label}</button>`;
    const b = (st, label) => `<button class="att ${st}" data-att="${esc(e.id)}" data-st="${st}" aria-pressed="${cur === st}">${label}</button>`;
    return `<div class="row emp">
      <div><div class="name">${esc(e.name)}</div>
        <div class="meta">This month: ${m.p} present${m.h ? `, ${m.h} half` : ""}${m.a ? `, ${m.a} absent` : ""}</div></div>
      <button class="btn small ghost" data-emp="${esc(e.id)}">Details</button>
      <div class="attbtns">${b("present", "Present")}${b("half", "Half day")}${b("absent", "Absent")}</div>
      ${cur === "absent" ? "" : `<div class="times">${tcell("check_in", "Check in", tin)}${tcell("check_out", "Check out", tout)}${wk ? `<span class="wk">${hm(wk)}</span>` : ""}</div>`}</div>`;
  }).join("");
}
$("#empList").addEventListener("change", e => {
  const t = e.target.closest("[data-time]");
  if (t) setTime(t.dataset.time, attDay, t.dataset.f, t.value);
});
$("#attDate").addEventListener("change", e => { if (e.target.value) { attDay = e.target.value; renderStaff(); } });
$("#attPrev").addEventListener("click", () => { attDay = addDays(attDay, -1); renderStaff(); });
$("#attNext").addEventListener("click", () => { attDay = addDays(attDay, 1); renderStaff(); });
$("#allPresent").addEventListener("click", async () => {
  const rows = live("employees").map(e => attOf(e.id, attDay) ? null : attRow(e.id, attDay, "present")).filter(Boolean);
  if (!rows.length) { toast("Everyone is already marked"); return; }
  await writeMany(rows.map(row => ({ table: "attendance", row })));
  toast(`${rows.length} marked present`);
});

let editingEmp = null, empMonth = today().slice(0, 7);
function openEmp(e) {
  editingEmp = e || null;
  $("#empTitle").textContent = e ? e.name : "Add staff";
  $("#eName").value = e?.name || ""; $("#ePhone").value = e?.phone || "";
  $("#eWage").value = e?.wage ?? ""; $("#eWageType").value = e?.wage_type || "day"; $("#eNote").value = e?.note || "";
  $("#empDelete").hidden = !e; $("#empMonthBox").hidden = !e;
  empMonth = attDay.slice(0, 7);
  if (e) renderEmpMonth();
  $("#empDlg").showModal(); if (!e) $("#eName").focus();
}
function renderEmpMonth() {
  const e = editingEmp; if (!e) return;
  const [y, m] = empMonth.split("-").map(Number);
  $("#empMonthLbl").textContent = new Date(y, m - 1, 1).toLocaleDateString("en-IN", { month: "long", year: "numeric" });
  const st = monthStats(e.id, empMonth);
  const mh = monthHours(e.id, empMonth);
  $("#empMonthSum").innerHTML = pills(st.p, st.h, st.a) + (mh ? `<span class="pill">Hours ${hm(mh)}</span>` : "");
  const first = new Date(y, m - 1, 1).getDay(), days = new Date(y, m, 0).getDate(), t = today();
  let html = ["S", "M", "T", "W", "T", "F", "S"].map(d => `<div class="dow">${d}</div>`).join("") + "<div></div>".repeat(first);
  for (let d = 1; d <= days; d++) {
    const date = ymd(y, m, d), cur = attOf(e.id, date);
    html += `<button type="button" class="${cur || ""} ${date === t ? "today" : ""}" data-day="${date}" aria-label="${esc(fmtDate(date))}${cur ? ", " + cur : ""}">${d}</button>`;
  }
  $("#empCal").innerHTML = html;
  const wage = num(e.wage);
  $("#empPay").textContent = !wage ? "" : e.wage_type === "month"
    ? `About ${rupee(Math.max(0, wage - wage / 30 * (st.a + st.h / 2)))} for this month (${rupee(wage)} less ${rupee(wage / 30 * (st.a + st.h / 2))} for absent days marked).`
    : `About ${rupee(wage * (st.p + st.h / 2))} earned this month (${st.p + st.h / 2} days at ${rupee(wage)}).`;
}
$("#empPrevM").addEventListener("click", () => { const [y, m] = empMonth.split("-").map(Number); const d = new Date(y, m - 2, 1); empMonth = ymd(d.getFullYear(), d.getMonth() + 1, 1).slice(0, 7); renderEmpMonth(); });
$("#empNextM").addEventListener("click", () => { const [y, m] = empMonth.split("-").map(Number); const d = new Date(y, m, 1); empMonth = ymd(d.getFullYear(), d.getMonth() + 1, 1).slice(0, 7); renderEmpMonth(); });
$("#addEmp").addEventListener("click", () => openEmp(null));
$("#empSave").addEventListener("click", async () => {
  const name = $("#eName").value.trim(); if (!name) { $("#eName").focus(); return; }
  const w = $("#eWage").value.trim();
  await write("employees", { ...(editingEmp || { id: db.uuid(), deleted_at: null }), name, phone: phone10($("#ePhone").value),
    wage: w === "" ? null : money(w), wage_type: $("#eWageType").value, note: $("#eNote").value.trim() });
  $("#empDlg").close(); toast("Staff saved");
});
$("#empDelete").addEventListener("click", async () => {
  if (!editingEmp || !confirm(`Remove ${editingEmp.name}? Their attendance is kept in backups.`)) return;
  await write("employees", { ...editingEmp, deleted_at: new Date().toISOString() });
  $("#empDlg").close(); toast("Staff removed");
});
$("#empDlg form").addEventListener("submit", e => { if (e.submitter?.value === "cancel") return; e.preventDefault(); $("#empSave").click(); });
$("#empDlg").addEventListener("close", () => { editingEmp = null; });

/* ================= payment reminders ================= */
const REPEAT = { none: "One time", weekly: "Every week", monthly: "Every month", yearly: "Every year" };
function nextDue(d, rep) {
  const [y, m, day] = d.split("-").map(Number);
  if (rep === "weekly") return addDays(d, 7);
  if (rep === "monthly") { const ny = m === 12 ? y + 1 : y, nm = m === 12 ? 1 : m + 1; return ymd(ny, nm, Math.min(day, new Date(ny, nm, 0).getDate())); }
  if (rep === "yearly") return ymd(y + 1, m, Math.min(day, new Date(y + 1, m, 0).getDate()));
  return d;
}
const isOpenRem = r => r.repeat !== "none" || !r.paid_on;
function whenText(due) {
  const n = daysBetween(today(), due);
  return n < 0 ? { t: `${-n} day${n === -1 ? "" : "s"} late`, c: "late" } : n === 0 ? { t: "Due today", c: "today" } : n === 1 ? { t: "Due tomorrow", c: "" } : { t: `Due in ${n} days`, c: "" };
}
function renderReminders() {
  const all = live("reminders"), open = all.filter(isOpenRem).sort((a, b) => a.due_date.localeCompare(b.due_date));
  const t = today(), days = r => daysBetween(t, r.due_date);
  const week = open.filter(r => days(r) <= 7);
  $("#payTotal").textContent = rupee(week.reduce((s, r) => s + num(r.amount), 0));
  const late = open.filter(r => days(r) < 0).length;
  $("#payCount").textContent = week.length ? `${week.length} payment${week.length === 1 ? "" : "s"}${late ? `, ${late} late` : ""}` : "Nothing coming up";
  const soon = open.filter(r => days(r) <= 3).length;
  $("#payBadge").hidden = !soon; $("#payBadge").textContent = soon;
  $("#payBanner").hidden = !soon;
  if (soon) $("#payBannerText").textContent = late ? `${late} payment${late === 1 ? " is" : "s are"} late${soon > late ? `, ${soon - late} more due in 3 days` : ""}.` : `${soon} payment${soon === 1 ? "" : "s"} due in the next 3 days.`;

  const row = (r, done) => {
    const w = whenText(r.due_date);
    return `<div class="row rem" style="grid-template-columns:1fr auto">
      <div><div class="name">${esc(r.title)}</div>
        <div class="meta">${done ? `Paid on ${esc(fmtDate(r.paid_on))}` : `<span class="when ${w.c}">${w.t}</span>, ${esc(fmtDate(r.due_date))}`}${r.repeat !== "none" ? ` · ${REPEAT[r.repeat]}` : ""}${r.paid_on && r.repeat !== "none" ? `<br>Last paid ${esc(fmtDate(r.paid_on))}` : ""}${r.note ? `<br>${esc(r.note)}` : ""}</div></div>
      <div class="due ${!done && days(r) > 7 ? "soon" : ""}">${num(r.amount) ? rupee(r.amount) : ""}</div>
      <div class="rowacts">${done ? `<button class="btn small" data-unpaid="${esc(r.id)}">Undo</button>`
        : `<button class="btn small primary" data-paid="${esc(r.id)}">Mark paid</button>`}<button class="btn small ghost" data-remedit="${esc(r.id)}">Edit</button></div></div>`;
  };
  const group = (title, rows) => rows.length ? `<p class="section-h">${title}</p>` + rows.map(r => row(r, false)).join("") : "";
  const done = all.filter(r => !isOpenRem(r)).sort((a, b) => b.paid_on.localeCompare(a.paid_on));
  let html = group("Late", open.filter(r => days(r) < 0)) + group("Next 7 days", open.filter(r => days(r) >= 0 && days(r) <= 7)) + group("Later", open.filter(r => days(r) > 7));
  if ($("#showPaid").checked && done.length) html += `<p class="section-h">Done</p>` + done.map(r => row(r, true)).join("");
  $("#remList").innerHTML = html || `<div class="empty"><strong>No payments to remember</strong>Add rent, electricity, supplier or loan payments with their dates.</div>`;
}
$("#showPaid").addEventListener("change", renderReminders);
$("#payBannerGo").addEventListener("click", () => show("payments"));

let editingRem = null;
function openRem(r) {
  editingRem = r || null;
  $("#remTitleH").textContent = r ? "Edit payment" : "Add payment";
  $("#rTitle").value = r?.title || ""; $("#rAmt").value = r?.amount ?? ""; $("#rDate").value = r?.due_date || today();
  $("#rRepeat").value = r?.repeat || "none"; $("#rNote").value = r?.note || "";
  $("#remDelete").hidden = !r; $("#remDlg").showModal(); if (!r) $("#rTitle").focus();
}
$("#addRem").addEventListener("click", () => openRem(null));
$("#remSave").addEventListener("click", async () => {
  const title = $("#rTitle").value.trim(); if (!title) { $("#rTitle").focus(); return; }
  if (!$("#rDate").value) { $("#rDate").focus(); return; }
  const a = $("#rAmt").value.trim();
  await write("reminders", { ...(editingRem || { id: db.uuid(), paid_on: null, deleted_at: null }), title, amount: a === "" ? null : money(a),
    due_date: $("#rDate").value, repeat: $("#rRepeat").value, note: $("#rNote").value.trim() });
  $("#remDlg").close(); toast("Payment saved");
});
$("#remDelete").addEventListener("click", async () => {
  if (!editingRem || !confirm(`Remove ${editingRem.title}?`)) return;
  await write("reminders", { ...editingRem, deleted_at: new Date().toISOString() });
  $("#remDlg").close(); toast("Payment removed");
});
$("#remDlg form").addEventListener("submit", e => { if (e.submitter?.value === "cancel") return; e.preventDefault(); $("#remSave").click(); });

document.addEventListener("click", async e => {
  const t = e.target.closest("[data-att],[data-now],[data-emp],[data-day],[data-paid],[data-unpaid],[data-remedit]");
  if (!t) return;
  if (t.dataset.att) await setAtt(t.dataset.att, attDay, t.dataset.st);
  else if (t.dataset.now) await setTime(t.dataset.now, attDay, t.dataset.f, nowHM());
  else if (t.dataset.emp) openEmp(S.employees[t.dataset.emp]);
  else if (t.dataset.day && editingEmp) {
    const cur = attOf(editingEmp.id, t.dataset.day);
    await setAtt(editingEmp.id, t.dataset.day, { null: "present", present: "half", half: "absent", absent: "absent" }[cur]);   // absent again = clear
  } else if (t.dataset.remedit) openRem(S.reminders[t.dataset.remedit]);
  else if (t.dataset.unpaid) { const r = S.reminders[t.dataset.unpaid]; if (r) await write("reminders", { ...r, paid_on: null }); }
  else if (t.dataset.paid) {
    const r = S.reminders[t.dataset.paid]; if (!r) return;
    if (r.repeat !== "none") { const nx = nextDue(r.due_date, r.repeat); await write("reminders", { ...r, due_date: nx, paid_on: today() }); toast(`Marked paid. Next due ${fmtDate(nx)}`); }
    else { await write("reminders", { ...r, paid_on: today() }); toast("Marked paid"); }
  }
});
// a new day starts while the app is open: refresh "today" things
let lastDay = today();
setInterval(() => { if (today() !== lastDay) { if (attDay === lastDay) attDay = today(); lastDay = today(); render(); } }, 60000);

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
  const ok = await deliverFile(new Blob([JSON.stringify(data)], { type: "application/json" }), `arun-cloth-store-backup-${today()}.json`);
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
    if (data.app !== "shop-book" || !data.tables) throw new Error("not an Arun Cloth Store backup");
    if (!confirm(`Restore from the backup made ${fmtDate(String(data.exported_at).slice(0, 10))}? Anything missing here will be brought back. Newer changes are kept.`)) return;
    let n = 0;
    for (const t of db.TABLES) if (Array.isArray(data.tables[t])) {
      const rows = t === "shops" ? data.tables[t].map(r => ({ ...r, id: UID })) : data.tables[t];
      n += await db.restoreRows(t, rows);
    }
    await loadAll(); refreshPending(); if (!LOCAL_ONLY) syncSoon();
    st.className = "status"; st.textContent = n ? `Restored ${n} record${n === 1 ? "" : "s"}.` : "Nothing to restore. Everything in the backup is already here.";
  } catch (err) {
    st.className = "status err"; st.textContent = "That file isn't an Arun Cloth Store backup.";
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
