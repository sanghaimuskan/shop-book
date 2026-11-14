// Turns a spoken or typed bill into customer details and line items.
// Runs fully on the device, no internet needed.
//
// Understands sentences like:
//   "Ramesh 98400 12345 from Tambaram rice 5 kg at 60 sugar 2 kg at 45 done"
//   "Name Lakshmi, phone 9876543210, Velachery. Oil 2 litre for 300, soap 4 at 35"
//   "5 kg basmati rice at 90, half kg sugar 45"     (quantity first also works)
//   "dal 3 into 120"            (into / x / at / rate / each = price per unit)
//   "biscuit 6 packet for 90"   (for / total = price for the whole line)
//   "sugar 500 gm at 45"        (grams become 0.5 kg, so the price stays per kg)
//   "paid 200" / "paid full" / "on credit"
// Numbers can be spoken as words (English, Hindi), spelling is matched loosely
// against your product and customer lists.

const SCRIPTS = "a-zA-Z\\u0900-\\u097F\\u0B80-\\u0BFF";
const WORD = `[${SCRIPTS}][${SCRIPTS}'\\u2019-]*`;

/* ---------- units ---------- */
const UNIT_MAP = {};
const addUnits = (canon, list) => list.split(" ").forEach(w => { UNIT_MAP[w] = canon; });
addUnits("kg", "kg kgs kilo kilos kilogram kilograms किलो கிலோ");
addUnits("g", "g gm gms gram grams ग्राम கிராம்");
addUnits("l", "l ltr ltrs litre litres liter liters लीटर லிட்டர்");
addUnits("ml", "ml millilitre millilitres");
addUnits("pc", "pc pcs piece pieces पीस");
addUnits("packet", "packet packets pkt pkts pack packs पैकेट");
addUnits("box", "box boxes");
addUnits("bag", "bag bags");
addUnits("dozen", "dozen");
addUnits("nos", "nos");
addUnits("bottle", "bottle bottles");
addUnits("meter", "meter metre meters metres");

const PER = new Set(["at", "@", "rate", "into", "x", "each", "per", "price", "cost"]);
const TOTAL = new Set(["for", "total", "amount"]);
const FILLER = new Set(["and", "then", "also", "plus", "aur", "the", "a", "an", "of", "rs", "please", "ok", "okay", "sir",
  "bill", "item", "items", "ka", "ki", "ke", "ko", "-", "next", "another", "और", "का", "की", "के"]);

/* ---------- number words → digits ---------- */
const NUMTAB = {};
const addNums = (kind, pairs) => pairs.split(" ").forEach(p => { const [w, v] = p.split("="); NUMTAB[w] = { k: kind, v: +v }; });
addNums("ones", "zero=0 one=1 two=2 three=3 four=4 five=5 six=6 seven=7 eight=8 nine=9");
addNums("teen", "ten=10 eleven=11 twelve=12 thirteen=13 fourteen=14 fifteen=15 sixteen=16 seventeen=17 eighteen=18 nineteen=19");
addNums("tens", "twenty=20 thirty=30 forty=40 fourty=40 fifty=50 sixty=60 seventy=70 eighty=80 ninety=90");
addNums("hundred", "hundred=100");
addNums("thousand", "thousand=1000");
// Hindi (roman)
addNums("ones", "ek=1 teen=3 char=4 paanch=5 panch=5 chhe=6 chhah=6 saat=7 aath=8 nau=9");
addNums("teen", "das=10 gyarah=11 barah=12 terah=13 chaudah=14 pandrah=15 solah=16 satrah=17 atharah=18 unnis=19 bees=20 pachees=25 tees=30 chalis=40 pachas=50 sattar=70 assi=80 nabbe=90");
addNums("hundred", "sau=100");
addNums("thousand", "hazaar=1000 hazar=1000");
addNums("frac", "half=0.5 dedh=1.5 dhai=2.5 dhaai=2.5 aadha=0.5 adha=0.5 quarter=0.25 pav=0.25 paav=0.25 pao=0.25");
// Hindi (Devanagari)
addNums("ones", "एक=1 तीन=3 चार=4 पांच=5 पाँच=5 छह=6 छः=6 सात=7 आठ=8 नौ=9");
addNums("teen", "दस=10 ग्यारह=11 बारह=12 तेरह=13 चौदह=14 पंद्रह=15 पन्द्रह=15 सोलह=16 सत्रह=17 अठारह=18 उन्नीस=19 बीस=20 पच्चीस=25 तीस=30 चालीस=40 पचास=50 साठ=60 सत्तर=70 अस्सी=80 नब्बे=90");
addNums("hundred", "सौ=100");
addNums("thousand", "हज़ार=1000 हजार=1000");
addNums("frac", "आधा=0.5 डेढ़=1.5 डेढ=1.5 ढाई=2.5 पाव=0.25");
// Tamil
addNums("ones", "ஒன்று=1 ஒரு=1 இரண்டு=2 மூன்று=3 நான்கு=4 ஐந்து=5 ஆறு=6 ஏழு=7 எட்டு=8 ஒன்பது=9");
addNums("teen", "பத்து=10");
addNums("tens", "இருபது=20 முப்பது=30 நாற்பது=40 ஐம்பது=50 அறுபது=60 எழுபது=70 எண்பது=80 தொண்ணூறு=90");
addNums("hundred", "நூறு=100");
addNums("thousand", "ஆயிரம்=1000");
addNums("frac", "அரை=0.5 கால்=0.25");

const TOK_RE = /^([^\p{L}\p{N}\p{M}]*)([\p{L}\p{N}\p{M}'’-]*?)([^\p{L}\p{N}\p{M}]*)$/u;

function runValues(run) {
  const nums = [];
  let total = 0, cur = 0, last = null, has = false;
  const push = () => { if (has) nums.push(total + cur); total = 0; cur = 0; last = null; has = false; };
  for (const { k, v } of run) {
    if (k === "frac") { push(); nums.push(v); continue; }
    if (k === "ones" || k === "teen") { if (last === "ones" || last === "teen") push(); cur += v; }
    else if (k === "tens") { if (last === "ones" || last === "teen" || last === "tens") push(); cur += v; }
    else if (k === "hundred") { cur = has && cur ? cur * 100 : 100; }
    else if (k === "thousand") { total += (has && cur ? cur : 1) * 1000; cur = 0; }
    has = true; last = k;
  }
  push();
  return nums;
}

function wordsToNumbers(text, lang) {
  const hindi = /^hi/i.test(lang || "");
  const lookup = w => {
    const l = w.toLowerCase();
    if (l === "do" || l === "दो") return hindi ? { k: "ones", v: 2 } : null;   // "do" is also an English word
    return NUMTAB[l] || null;
  };
  const toks = text.split(/\s+/).filter(Boolean).map(raw => { const m = raw.match(TOK_RE); return m ? { raw, lead: m[1], core: m[2], trail: m[3] } : { raw, lead: "", core: raw, trail: "" }; });
  const out = [];
  let run = [], lead = "";
  const flush = trail => { if (run.length) { out.push(lead + runValues(run).join(" ") + (trail || "")); run = []; lead = ""; } };
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i], n = t.core ? lookup(t.core) : null;
    if (n) {
      if (!run.length) lead = t.lead;
      run.push(n);
      if (t.trail) flush(t.trail);
      continue;
    }
    // "one hundred and fifty": the "and" belongs to the number
    if (run.length && t.core.toLowerCase() === "and" && !t.trail && ["hundred", "thousand"].includes(run[run.length - 1].k)) {
      const nx = toks[i + 1], nn = nx && nx.core ? lookup(nx.core) : null;
      if (nn && ["ones", "teen", "tens"].includes(nn.k)) continue;
    }
    flush();
    out.push(t.raw);
  }
  flush();
  return out.join(" ");
}

function normalise(text, lang) {
  let t = " " + String(text || "").replace(/[\r\n]+/g, ". ").replace(/\s+/g, " ") + " ";
  t = t.replace(/\s*(?:\b(?:done|that's it|thats it|finish|finished|bas|ho gaya)\b|हो गया|बस|முடிந்தது|போதும்)[\s.!]*$/i, " ");
  t = t.replace(/[₹]/g, " ").replace(/\brs\.?(?=\s|\d)/gi, " ").replace(/\b(?:rupees?|rupaye|rupay)\b|रुपये|रुपए|ரூபாய்/gi, " ");
  t = t.replace(/(\d)\s*(?=[a-zA-Zऀ-ॿ஀-௿])/g, "$1 ");   // 5kg → 5 kg
  t = t.replace(/(\d),(\d{3})(?!\d)/g, "$1$2");                              // 1,200 → 1200
  t = t.replace(/\s+and\s+(?:a\s+)?(?:half|aadha|adha)\b/gi, " HALFMARK");   // "one and a half"
  t = t.replace(/\bdouble\s+(\d)\b/gi, "$1$1").replace(/\btriple\s+(\d)\b/gi, "$1$1$1");
  t = wordsToNumbers(t, lang);
  t = t.replace(/(\d+(?:\.\d+)?)\s+HALFMARK/g, (m, n) => String(parseFloat(n) + 0.5)).replace(/HALFMARK/g, " ");
  // digits spoken one by one: "9 8 4 0 0 1 2 3 4 5" → one number
  t = t.replace(/(?<![\d.])(?:\d\s+){5,}\d(?![\d.])/g, m => m.replace(/\s+/g, ""));
  return t;
}

/* ---------- loose matching of names ---------- */
const norm = s => String(s || "").toLowerCase().replace(/[^a-z0-9ऀ-ॿ஀-௿\s]/g, " ").replace(/\s+/g, " ").trim();
// Rough sound-alike key so "cheeni", "chini" and "dhal"/"daal"/"dal" meet in the middle.
const phon = s => norm(s).replace(/ee/g, "i").replace(/oo/g, "u").replace(/aa/g, "a").replace(/ph/g, "f").replace(/[wv]/g, "v")
  .replace(/z/g, "j").replace(/ck/g, "k").replace(/([tdbkg])h/g, "$1").replace(/(.)\1+/g, "$1").replace(/\s/g, "");
function lev(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}
const tol = len => len <= 3 ? 0 : len <= 6 ? 1 : 2;

function best(spoken, list, getName, strict) {
  const s = norm(spoken); if (!s) return null;
  const ps = phon(spoken);
  let hit = list.find(i => norm(getName(i)) === s) || list.find(i => ps && phon(getName(i)) === ps);
  if (hit) return hit;
  if (!strict && s.length >= 3) {
    const c = list.filter(i => {
      const n = norm(getName(i)); if (n.length < 3) return false;
      return (" " + n + " ").includes(" " + s + " ") || n.startsWith(s) || (" " + s + " ").includes(" " + n + " ");
    }).sort((a, b) => norm(getName(a)).length - norm(getName(b)).length);
    if (c.length) return c[0];
  }
  let bi = null, bd = Infinity;
  for (const i of list) {
    const pn = phon(getName(i)); if (!pn || !ps) continue;
    const d = lev(pn, ps);
    if (d <= tol(Math.max(pn.length, ps.length)) && d < bd) { bd = d; bi = i; }
  }
  return bi;
}

const ALIAS = {};
const addAlias = (eng, list) => list.split(" ").forEach(w => { ALIAS[w] = eng; });
addAlias("rice", "चावल அரிசி chawal chaval");
addAlias("sugar", "चीनी शक्कर சர்க்கரை chini cheeni shakkar sakkarai");
addAlias("oil", "तेल எண்ணெய் tel ennai");
addAlias("dal", "दाल பருப்பு daal paruppu");
addAlias("atta", "आटा மாவு");
addAlias("salt", "नमक உப்பு namak uppu");
addAlias("soap", "साबुन சோப்பு sabun");
addAlias("tea", "चाय டீ தேநீர் chai");
addAlias("milk", "दूध பால் doodh dudh paal");
addAlias("biscuit", "बिस्कुट பிஸ்கட்");
addAlias("maida", "मैदा");
addAlias("rava", "सूजी suji sooji");

function resolveProduct(spoken, products) {
  const clean = String(spoken).trim();
  let p = best(clean, products, x => x.name);
  if (p) return { name: p.name, product: p };
  const tr = clean.split(/\s+/).map(w => ALIAS[w.toLowerCase()] || w).join(" ");
  if (tr !== clean) {
    p = best(tr, products, x => x.name);
    return p ? { name: p.name, product: p } : { name: titleCase(tr), product: null };
  }
  return { name: titleCase(clean), product: null };
}

const findCustomer = (spoken, customers, strict = true) => best(spoken, customers, c => c.name, strict);

/* ---------- main ---------- */
const PLACE_SUFFIX = new Set("nagar colony street road layout puram pet pettai bazaar bazar market park garden gate chowk lane cross main extension mandi ganj pur palayam kudi".split(" "));
const PLACE_PREFIX = new Set("new old east west north south upper lower anna gandhi nehru shastri sri shri".split(" "));
const UNIT_RE = Object.keys(UNIT_MAP).filter(u => /^[a-z]+$/.test(u)).join("|");

export function parseBill(text, products = [], customers = [], opts = {}) {
  let t = normalise(text, opts.lang);
  const out = { customer: { name: "", phone: "", place: "" }, items: [], paid: null, paidFull: false };

  // how much was paid
  const FULL = /\b(?:paid\s+(?:in\s+)?full|fully\s+paid|full\s+(?:paid|payment)|paid\s+all|cash\s+paid)\b/i;
  if (FULL.test(t)) { out.paidFull = true; t = t.replace(FULL, " "); }
  const paid = t.match(/\b(?:paid|advance|received|gave|given|diya|jama|payment)\s+(?:rs\s*)?(\d+(?:\.\d+)?)/i);
  if (paid) { out.paid = parseFloat(paid[1]); t = t.replace(paid[0], " "); }
  const CREDIT = /\b(?:on\s+credit|credit|udhaar|udhar|baaki|unpaid|not\s+paid|no\s+payment)\b/i;
  if (out.paid == null && !out.paidFull && CREDIT.test(t)) { out.paid = 0; t = t.replace(CREDIT, " "); }

  // place: "from Anna Nagar". A second word is kept only when it clearly belongs to the place.
  const pm = t.match(new RegExp(`\\b(?:from|place|area)\\s+(${WORD})(?:\\s+(${WORD}))?`, "i"));
  if (pm) {
    const w1 = pm[1], w2 = pm[2] || "";
    const after = t.slice(pm.index + pm[0].length);
    const endsHere = /^\s*(?:[,.;!?]|$)/.test(after);
    const keep2 = w2 && (endsHere || PLACE_SUFFIX.has(w2.toLowerCase()) || (PLACE_PREFIX.has(w1.toLowerCase()) && !/^\s*\d/.test(after)));
    const used = keep2 || !w2 ? pm[0] : pm[0].slice(0, pm[0].lastIndexOf(w2)).trimEnd();
    out.customer.place = titleCase(keep2 ? `${w1} ${w2}` : w1);
    t = t.replace(used, " ");
  }

  // phone: 10 digits, possibly spoken in groups ("98400 12345"), optional +91
  const phone = t.match(/(?:\+?91[\s-]?)?((?:\d[\s-]?){9}\d)(?!\d)/);
  let head, body, hasPhone = false;
  if (phone) {
    out.customer.phone = phone[1].replace(/\D/g, "");
    const i = t.indexOf(phone[0]);
    const before = t.slice(0, i).replace(/\b(?:name|customer|naam|phone|number|mobile|contact|is|to|for|from|place|area)\b/gi, " ");
    if (/\d/.test(before) || !/[a-zA-Z\u0900-\u097F\u0B80-\u0BFF]/.test(before)) t = t.replace(phone[0], " ");   // items before the phone, or the name comes after it
    else { hasPhone = true; head = t.slice(0, i); body = t.slice(i + phone[0].length); }
  }
  if (!hasPhone) {
    const firstNum = t.search(/\d/);
    head = firstNum >= 0 ? t.slice(0, firstNum) : t;
    body = firstNum >= 0 ? t.slice(firstNum) : "";
  }

  // customer name = the words before the first item
  head = head.replace(/\b(?:name|customer|naam|bill\s+for|bill\s+to|phone|number|mobile|contact|is|to|for)\b/gi, " ");
  const segs = head.split(/[,.;:!?]/).map(s => s.trim()).filter(Boolean);
  const words = s => s.split(/\s+/).filter(Boolean);
  let nameWords = [], restWords = [];
  if (segs.length > 1) { nameWords = words(segs[0]); restWords = words(segs.slice(1).join(" ")); }
  else if (segs.length === 1) {
    const w = words(segs[0]);
    if (hasPhone) nameWords = w;
    else {
      let k = -1;
      for (let n = Math.min(3, w.length); n >= 1 && k < 0; n--) if (findCustomer(w.slice(0, n).join(" "), customers)) k = n;
      if (k < 0) for (let s = 0; s < w.length && k < 0; s++) if (best(w.slice(s).join(" "), products, p => p.name, true)) k = s;
      if (k < 0) {
        if (!body) k = w.length <= 3 ? w.length : 0;                    // only a name was said
        else if (w.length > 1) k = Math.min(w.length - 1, 3);
        else k = new RegExp(`^\\s*\\d+(?:\\.\\d+)?\\s+(?:${UNIT_RE})\\s+(?!(?:at|for|rate|into|x|each|per|total)\\b)${WORD}`, "i").test(body) ? 1 : 0;   // "Ramesh 5 kg rice"
      }
      nameWords = w.slice(0, k); restWords = w.slice(k);
    }
  }
  if (nameWords.length) {
    const c = findCustomer(nameWords.join(" "), customers, false);
    out.customer.name = c ? c.name : titleCase(nameWords.join(" "));
  }
  body = restWords.join(" ") + " " + body;

  // items
  const tk = body.match(/\d+(?:\.\d+)?|[^\s\d,.;:!?]+|[,.;:!?]/g) || [];
  const fresh = () => ({ name: [], qty: null, unit: "", price: null, mode: "per", pend: null, qtyFirst: false });
  let cur = fresh();
  const flush = () => {
    const name = cur.name.join(" ").trim();
    if (name && cur.qty == null && cur.price == null) {                // words with no numbers: maybe the place
      if (!out.customer.place && !out.items.length && cur.name.length <= 2 && !best(name, products, p => p.name)) out.customer.place = titleCase(name);
    } else if (name && !/^(?:from|place|phone|name|customer|paid)$/i.test(name)) {
      const { name: nm, product: p } = resolveProduct(name, products);
      let q = cur.qty, unit = cur.unit;
      const pu = p ? UNIT_MAP[String(p.unit || "").toLowerCase()] || "" : "";
      if (q != null && unit === "g" && pu !== "g") { q /= 1000; unit = "kg"; }           // 500 gm → 0.5 kg
      else if (q != null && unit === "ml" && pu !== "ml") { q /= 1000; unit = "l"; }
      q = q == null ? 1 : Math.round(q * 1000) / 1000;
      let rate = "";
      if (cur.price != null) rate = cur.mode === "total" ? Math.round((cur.price / (q || 1)) * 100) / 100 : cur.price;
      else if (p && Number(p.retail)) rate = Number(p.retail);
      out.items.push({ name: nm, qty: q, unit, rate, matched: !!p });
    }
    cur = fresh();
  };
  const isEmpty = () => !cur.name.length && cur.qty == null && cur.price == null;
  for (let i = 0; i < tk.length; i++) {
    const tok = tk[i], low = tok.toLowerCase();
    if (/^[,.;:!?]$/.test(tok)) { flush(); continue; }
    if (/^\d/.test(tok)) {
      const v = parseFloat(tok);
      const nu = UNIT_MAP[(tk[i + 1] || "").toLowerCase()];
      if (nu) {                                   // "5 kg" is always a quantity
        i++;
        if (cur.qty != null) flush();
        cur.qty = v; cur.unit = nu; cur.qtyFirst = !cur.name.length; cur.pend = null;
      } else if (cur.pend) { cur.price = v; cur.mode = cur.pend; flush(); }       // "at 60", "for 300"
      else if (cur.qty == null) { cur.qty = v; cur.qtyFirst = !cur.name.length; }
      else { cur.price = v; cur.mode = "per"; flush(); }                          // "rice 5 kg 60"
      continue;
    }
    if (PER.has(low) || TOTAL.has(low)) {
      if (low === "per" && UNIT_MAP[(tk[i + 1] || "").toLowerCase()]) { i++; continue; }   // "at 60 per kg"
      if (!isEmpty()) cur.pend = TOTAL.has(low) ? "total" : "per";
      continue;
    }
    if (FILLER.has(low)) continue;
    if (cur.qty != null && !cur.qtyFirst && cur.name.length) flush();               // next item starts
    cur.name.push(tok);
  }
  flush();
  return out;
}

function titleCase(s) {
  return String(s || "").replace(/(^|\s)([a-z])/g, (m, a, c) => a + c.toUpperCase());
}
