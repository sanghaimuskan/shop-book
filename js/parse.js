// Turns a spoken or typed bill into customer details and line items.
// Runs fully on the device, no internet needed.
//
// Understands sentences like:
//   "Ramesh 98400 12345 from Tambaram rice 5 kg at 60 sugar 2 kg at 45 done"
//   "Name Lakshmi, phone 9876543210, Velachery. Oil 2 litre for 300, soap 4 at 35"
//   "dal 3 into 120"            (into / x / at / rate / each = price per unit)
//   "biscuit 6 packet for 90"   (for / total = price for the whole line)
//   "paid 200"                  (amount paid now)

const UNITS = "kg|kgs|kilo|kilos|g|gm|gms|gram|grams|l|ltr|litre|litres|liter|liters|ml|pc|pcs|piece|pieces|packet|packets|pkt|box|boxes|bag|bags|dozen|nos|no|bottle|bottles|meter|metre|meters|metres";
const PER = "at|@|rate|into|x|each|per";
const TOTAL = "for|total|amount";
const WORD = "[a-zA-Z\\u0900-\\u097F\\u0B80-\\u0BFF][a-zA-Z\\u0900-\\u097F\\u0B80-\\u0BFF'-]*";

const NUM_WORDS = { one:1, two:2, three:3, four:4, five:5, six:6, seven:7, eight:8, nine:9, ten:10,
  eleven:11, twelve:12, fifteen:15, twenty:20, "half":0.5 };

function normalise(text) {
  let t = " " + String(text || "").replace(/\s+/g, " ") + " ";
  t = t.replace(/\b(done|that's it|thats it|finish|finished|bas|ho gaya)\b[.!]?\s*$/i, " ");
  t = t.replace(/[₹]/g, " ").replace(/\brs\.?\s*/gi, " ").replace(/\brupees?\b/gi, " ");
  t = t.replace(/\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|half)\b/gi, w => " " + NUM_WORDS[w.toLowerCase()] + " ");
  t = t.replace(/(\d),(\d{3})\b/g, "$1$2");        // 1,200 → 1200
  return t;
}

export function parseBill(text, products = []) {
  let t = normalise(text);
  const out = { customer: { name: "", phone: "", place: "" }, items: [], paid: null };

  // paid amount
  const paid = t.match(/\b(?:paid|advance|received|gave)\s+(\d+(?:\.\d+)?)/i);
  if (paid) { out.paid = parseFloat(paid[1]); t = t.replace(paid[0], " "); }

  // place: "from Anna Nagar" — a second word is kept unless it starts an item
  const placeRe = new RegExp(`\\b(?:from|place)\\s+(${WORD})(?:\\s+(${WORD})(?=[\\s,.;]|$)(?!\\s+\\d))?`, "i");
  const pm = t.match(placeRe);
  if (pm) { out.customer.place = titleCase([pm[1], pm[2]].filter(Boolean).join(" ")); t = t.replace(pm[0], " "); }

  // phone: 10 digits, possibly spoken in groups ("98400 12345"), optional +91
  const phone = t.match(/(?:\+?91[\s-]?)?((?:\d[\s-]?){9}\d)\b/);
  let head, body;
  if (phone) {
    out.customer.phone = phone[1].replace(/\D/g, "");
    const i = t.indexOf(phone[0]);
    head = t.slice(0, i);
    body = t.slice(i + phone[0].length);
  } else {
    // no phone: customer name is whatever comes before the first item
    const firstNum = t.search(/\d/);
    head = firstNum > 0 ? t.slice(0, firstNum) : "";
    body = firstNum > 0 ? t.slice(firstNum) : t;
    const words = head.trim().split(/\s+/).filter(Boolean);
    if (words.length > 1) { const last = words.pop(); head = words.join(" "); body = last + " " + body; }
    else { body = head + " " + body; head = ""; }
  }

  // name
  out.customer.name = titleCase(head.replace(/\b(name|customer|is|phone|number|mobile)\b/gi, " ").replace(/[,.:;]/g, " ").replace(/\s+/g, " ").trim());

  // items
  const itemRe = new RegExp(
    `(${WORD}(?:\\s+${WORD}){0,3}?)\\s+(\\d+(?:\\.\\d+)?)(?![\\d.])\\s*(?:(${UNITS})\\b)?\\s*(?:(${PER}|${TOTAL})\\b)?\\s*(\\d+(?:\\.\\d+)?)`, "gi");
  let m;
  const knownNames = products.map(p => (p.name || "").toLowerCase());
  while ((m = itemRe.exec(body))) {
    let nm = m[1].replace(/\b(and|then|also|plus|aur)\b/gi, " ").replace(/\s+/g, " ").trim();
    if (!nm || /^(from|place|phone|name)$/i.test(nm)) continue;
    const qty = parseFloat(m[2]);
    const word = (m[4] || "").toLowerCase();
    let rate = parseFloat(m[5]);
    if (TOTAL.split("|").includes(word) && qty) rate = Math.round((rate / qty) * 100) / 100;
    nm = matchProduct(nm, knownNames, products);
    out.items.push({ name: nm, qty, unit: m[3] || "", rate });
  }

  // items said without a price ("rice 5 kg") → fill retail price from stock
  const noPrice = new RegExp(`(${WORD})\\s+(\\d+(?:\\.\\d+)?)(?![\\d.])\\s*(${UNITS})\\b(?!\\s*(?:${PER}|${TOTAL})?\\s*\\d)`, "gi");
  const covered = new Set(out.items.map(i => i.name.toLowerCase()));
  while ((m = noPrice.exec(body))) {
    const nm = matchProduct(m[1], knownNames, products);
    if (covered.has(nm.toLowerCase())) continue;
    const p = products.find(p => (p.name || "").toLowerCase() === nm.toLowerCase());
    out.items.push({ name: nm, qty: parseFloat(m[2]), unit: m[3], rate: p && p.retail ? Number(p.retail) : "" });
  }

  // a matched product with no rate spoken gets its retail price
  out.items.forEach(i => {
    if (i.rate === "" || i.rate == null) {
      const p = products.find(p => (p.name || "").toLowerCase() === i.name.toLowerCase());
      if (p && p.retail) i.rate = Number(p.retail);
    }
  });
  return out;
}

function matchProduct(spoken, knownNames, products) {
  const s = spoken.toLowerCase().trim();
  let i = knownNames.indexOf(s);
  if (i < 0) i = knownNames.findIndex(n => n && (n.startsWith(s) || s.startsWith(n) || n.includes(s)));
  return i >= 0 ? products[i].name : titleCase(spoken.trim());
}

function titleCase(s) {
  return String(s || "").replace(/\b([a-z])/g, c => c.toUpperCase());
}
