/* Refund Metrics — Montanello UK
 *
 * Reads both trackers live. Note the endpoint: /export?format=csv, NOT gviz.
 * gviz honours whatever filter is active on the sheet, so it currently returns
 * July only; /export ignores filters and returns every row. Both are CORS-safe.
 *
 * Wrapped in an IIFE: app.js declares its own top-level `state`, and two
 * top-level `const state` declarations on one page is a SyntaxError.
 */
(function () {

const SOURCES = {
  refunds: { id: "18nZ5isXR5KOKwftQKfCMucsgEm4n_kVwTeVbZlebKoI", gid: "1691212125" },
  pending: { id: "19WihBvQ8fUmkj9ioqvZMapAZAVFMij_6_Ca4rCWYh6k", gid: "0" },
};

// Order numbers below this belong to the store the pending tracker covers.
const STORE_SPLIT = 9000;

/* Cancellation reasons, read from the CommsLayer tickets in July 2026.
 * The dashboard cannot reach the helpdesk API from the browser, so this is a
 * fixed snapshot rather than a live feed — counts and values on this tab come
 * from the sheet and are live; these reasons cover the 71 July orders only. */
const CANCEL_REASON_LABELS = {
  delivery:  "Delivery too slow / won't arrive in time",
  oos:       "Out of stock after we took payment",
  error:     "Ordered by mistake / duplicate / checkout confusion",
  ourfault:  "Our own errors",
  trust:     "Lost trust after reading reviews",
  notneeded: "No longer needed / bought elsewhere",
  origin:    "Shipping origin discovered after paying",
  noreason:  "No reason provided",
};

// order -> reason category. The customer's actual words live in
// cancel-quotes.js, which is not committed (public repo, private
// conversations). Everything here works with or without that file.
const CANCEL_REASONS = {
  7358:"delivery", 7251:"delivery", 4908:"delivery", 3375:"delivery", 5164:"delivery",
  4756:"delivery", 6444:"delivery", 7004:"delivery", 6303:"delivery", 4708:"delivery",
  3966:"delivery", 5661:"delivery", 3877:"delivery", 4700:"delivery", 4594:"delivery",
  5387:"delivery",

  6228:"origin", 4940:"origin", 5307:"origin",

  7431:"trust", 4077:"trust", 6512:"trust", 6463:"trust", 4617:"trust",

  3925:"error", 7205:"error", 6975:"error", 2597:"error", 5303:"error", 4018:"error",
  5410:"error", 5360:"error", 5592:"error", 4765:"error", 6976:"error", 4846:"error",

  6024:"ourfault", 4523:"ourfault", 4858:"ourfault", 5598:"ourfault", 5987:"ourfault",
  3134:"ourfault", 6747:"ourfault",

  5573:"notneeded", 5469:"notneeded", 5420:"notneeded", 4835:"notneeded",
  6490:"notneeded", 7501:"notneeded",

  5168:"oos", 4750:"oos", 6213:"oos", 4307:"oos", 3999:"oos", 4534:"oos",
  4722:"oos", 5299:"oos", 4098:"oos",

  6132:"noreason", 5111:"noreason", 5732:"noreason", 6717:"noreason", 5015:"noreason",
  5907:"noreason", 3514:"noreason", 4651:"noreason", 5237:"noreason", 5075:"noreason",
  6782:"noreason", 1019:"noreason", 5065:"noreason",
};

const CANCEL_QUOTES = window.CANCEL_QUOTES || {};

/** A refund that never shipped: cancelled before dispatch, or sold without stock. */
const isCancelType = (r) => /cancel|out of stock|duplicate order/i.test(r.reason);
const ORDERS_KEY = "montanello.weeklyOrders.v1";
const REFRESH_MS = 5 * 60 * 1000;

const state = {
  refunds: [],
  pending: [],
  month: "",        // "" = all months
  ledgerSearch: "",
  ledgerScope: "all",
  refundSearch: "",
  quoteSearch: "",
  weeklyOrders: loadOrders(),
  textCells: [],    // values Sheets refuses to sum (stored as text)
};

/* ---------------- utilities ---------------- */

const csvUrl = (s) =>
  `https://docs.google.com/spreadsheets/d/${s.id}/export?format=csv&gid=${s.gid}&_=${Date.now()}`;

const gvizUrl = (s) =>
  `https://docs.google.com/spreadsheets/d/${s.id}/gviz/tq?tqx=out:csv&gid=${s.gid}&_=${Date.now()}`;

function parseCSV(text) {
  const rows = [];
  let row = [], field = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else { q = false; }
      } else field += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

function toObjects(rows) {
  if (!rows.length) return [];
  const head = rows[0].map((h) => h.trim().toLowerCase());
  return rows.slice(1).map((r) => {
    const o = {};
    head.forEach((h, i) => { o[h] = (r[i] || "").trim(); });
    return o;
  });
}

/** Money as typed by humans: "£19.98", "Â£1,234.56", and the "79/95" slip. */
function money(raw) {
  if (!raw) return { value: 0, ok: false, raw: raw || "" };
  const cleaned = raw.replace(/[^0-9./]/g, "").replace(/\//g, ".");
  const m = cleaned.match(/^[0-9]+(\.[0-9]+)?/);
  if (!m) return { value: 0, ok: false, raw };
  const typo = /\//.test(raw);
  return { value: parseFloat(m[0]), ok: true, raw, typo };
}

/** Dates, tolerating the mistyped "0206" year seen throughout July. */
function parseDate(raw) {
  if (!raw) return { date: null, ok: false, raw: raw || "" };
  const parts = raw.trim().split("/");
  if (parts.length !== 3) return { date: null, ok: false, raw };
  let [m, d, y] = parts.map((p) => parseInt(p, 10));
  if (!m || !d || !y) return { date: null, ok: false, raw };
  let repaired = false;
  if (y < 100) { y += 2000; repaired = true; }
  if (y >= 200 && y < 300) { y += 1820; repaired = true; }   // 0206 -> 2026
  if (y < 2000 || y > 2100) return { date: null, ok: false, raw };
  return { date: new Date(y, m - 1, d), ok: true, repaired, raw };
}

/** "Full Refund" -> 1, "40%" -> 0.4 */
function tier(raw) {
  const s = (raw || "").trim();
  if (!s) return { pct: null, label: "—", full: false };
  if (/full/i.test(s)) return { pct: 1, label: "Full", full: true };
  const n = parseFloat(s.replace(/[^0-9.]/g, ""));
  if (!isFinite(n) || n <= 0 || n >= 100) return { pct: null, label: s, full: false };
  return { pct: n / 100, label: `${n}%`, full: false };
}

const gbp = (n) => "£" + n.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const gbp0 = (n) => "£" + n.toLocaleString("en-GB", { maximumFractionDigits: 0 });
const pct = (n) => (n * 100).toFixed(1) + "%";
const monthKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
const monthName = (k) => {
  const [y, m] = k.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString("en-GB", { month: "long", year: "numeric" });
};

/** Monday of the week containing d. */
function weekStart(d) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const shift = (x.getDay() + 6) % 7;
  x.setDate(x.getDate() - shift);
  return x;
}
const weekKey = (d) => {
  const w = weekStart(d);
  return `${w.getFullYear()}-${String(w.getMonth() + 1).padStart(2, "0")}-${String(w.getDate()).padStart(2, "0")}`;
};

function esc(s) {
  const d = document.createElement("div");
  d.textContent = s == null ? "" : String(s);
  return d.innerHTML;
}

function loadOrders() {
  try { return JSON.parse(localStorage.getItem(ORDERS_KEY)) || {}; }
  catch { return {}; }
}
function saveOrders() {
  try { localStorage.setItem(ORDERS_KEY, JSON.stringify(state.weeklyOrders)); } catch { /* private mode */ }
}

/* ---------------- loading ---------------- */

async function fetchCsv(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return toObjects(parseCSV(await res.text()));
}

function normaliseRefunds(rows) {
  return rows
    .map((r) => {
      const order = (r["order"] || r["order "] || "").trim();
      if (!order) return null;
      const d = parseDate(r["date refunded"]);
      const v = money(r["refund value"]);
      const t = tier(r["refund %"]);
      const num = parseInt(order.replace(/[^0-9]/g, ""), 10);
      return {
        kind: "refund",
        va: r["va"] || "",
        order,
        num: isFinite(num) ? num : 0,
        date: d.date,
        dateRaw: d.raw,
        dateOk: d.ok,
        dateRepaired: !!d.repaired,
        reason: (r["reason"] || r["reason "] || "").trim() || "(none)",
        tierPct: t.pct,
        tierLabel: t.label,
        isFull: t.full,
        value: v.value,
        valueOk: v.ok,
        valueRaw: v.raw,
        valueTypo: !!v.typo,
        store: isFinite(num) && num < STORE_SPLIT ? "Montanello UK" : "Second brand",
      };
    })
    .filter(Boolean);
}

function normalisePending(rows) {
  return rows
    .map((r) => {
      const order = (r["order number"] || "").trim();
      if (!order) return null;
      const status = (r["status"] || "").trim();
      if (status && !/pending/i.test(status)) return null;   // closed cases live in the refund tracker
      const d = parseDate(r["promised date"]);
      const v = money(r["amount to refund"]);
      const num = parseInt(order.replace(/[^0-9]/g, ""), 10);
      return {
        kind: "pending",
        va: r["va"] || "",
        order,
        num: isFinite(num) ? num : 0,
        date: d.date,
        dateRaw: d.raw,
        dateOk: d.ok,
        reason: "(awaiting payment)",
        tierPct: null,
        tierLabel: "—",
        isFull: false,
        value: v.value,
        valueOk: v.ok,
        valueRaw: v.raw,
        valueTypo: !!v.typo,
        store: isFinite(num) && num < STORE_SPLIT ? "Montanello UK" : "Second brand",
      };
    })
    .filter(Boolean);
}

/**
 * Cross-check: /export returns a cell's contents, gviz returns what Sheets
 * evaluates. A value present in one and blank in the other is stored as text,
 * which means SUM() silently skips it and the sheet's own total is short.
 */
async function findTextCells(refunds) {
  try {
    const seen = await fetchCsv(gvizUrl(SOURCES.refunds));
    const blanks = new Set();
    seen.forEach((r) => {
      const order = (r["order"] || r["order "] || "").trim();
      if (order && !(r["refund value"] || "").trim()) blanks.add(order);
    });
    return refunds.filter((r) => blanks.has(r.order) && r.valueOk && r.value > 0);
  } catch {
    return [];   // filter view unavailable; skip this check rather than fail
  }
}

function showError(msg) {
  const err = document.getElementById("mxError");
  if (msg) {
    err.textContent = msg;
    err.hidden = false;
    err.classList.add("active");
  } else {
    err.hidden = true;
    err.classList.remove("active");
  }
}

async function load() {
  const status = document.getElementById("mxStatus");
  status.textContent = "Loading data from both trackers…";
  status.classList.remove("err");
  try {
    const [rRows, pRows] = await Promise.all([
      fetchCsv(csvUrl(SOURCES.refunds)),
      fetchCsv(csvUrl(SOURCES.pending)),
    ]);
    state.refunds = normaliseRefunds(rRows);
    state.pending = normalisePending(pRows);
    state.textCells = await findTextCells(state.refunds);
    showError(null);
    buildMonthOptions();
    renderAll();
    status.textContent =
      `${state.refunds.length} refunds · ${state.pending.length} awaiting payment · ` +
      `updated ${new Date().toLocaleTimeString("en-GB")}`;
  } catch (e) {
    showError("Could not load the trackers: " + e.message +
      ". Both sheets must stay shared as “Anyone with the link can view”.");
    status.textContent = "Load failed.";
    status.classList.add("err");
  }
}

/* ---------------- selectors ---------------- */

const inMonth = (r) => !state.month || (r.date && monthKey(r.date) === state.month);
const scopedRefunds = () => state.refunds.filter(inMonth);

/** Per-case saving implied by the tier: a 40% refund of £19.98 retained £29.97. */
function savings(list) {
  let saved = 0, exposure = 0, paid = 0, n = 0;
  list.forEach((r) => {
    if (r.tierPct != null && r.tierPct < 1 && r.tierPct > 0 && r.valueOk && r.value > 0) {
      const full = r.value / r.tierPct;
      saved += full - r.value;
      exposure += full;
      paid += r.value;
      n++;
    }
  });
  return { saved, exposure, paid, n };
}

/* ---------------- render: ladder ---------------- */

function renderLadder() {
  const list = scopedRefunds();
  const s = savings(list);
  const partials = list.filter((r) => r.tierPct != null && r.tierPct < 1);
  const fulls = list.filter((r) => r.isFull);
  const totalValue = list.reduce((a, r) => a + r.value, 0);

  document.getElementById("ladderCards").innerHTML = [
    card("good", gbp0(s.saved), "Retained by partial settlements", `${s.n} cases`),
    card("accent", list.length ? pct(partials.length / list.length) : "—", "Acceptance rate", "settled below full"),
    card("", s.exposure ? pct(s.saved / s.exposure) : "—", "Save rate", "of implied full value"),
    card("warn", gbp0(totalValue), "Paid out", `${list.length} refunds`),
    card("", fulls.length.toString(), "Full refunds", "no saving possible"),
  ].join("");

  // by agent
  const byVa = {};
  list.forEach((r) => {
    const k = r.va || "(unassigned)";
    (byVa[k] = byVa[k] || []).push(r);
  });
  const agentRows = Object.entries(byVa)
    .map(([va, rows]) => {
      const sv = savings(rows);
      const p = rows.filter((r) => r.tierPct != null && r.tierPct < 1).length;
      return { va, n: rows.length, p, acc: rows.length ? p / rows.length : 0, saved: sv.saved, rate: sv.exposure ? sv.saved / sv.exposure : 0 };
    })
    .sort((a, b) => b.saved - a.saved);

  const bestAcc = Math.max(...agentRows.map((a) => a.acc), 0.0001);
  document.querySelector("#agentTable tbody").innerHTML = agentRows.length
    ? agentRows.map((a) => `
        <tr>
          <td>${esc(a.va)}</td>
          <td class="num">${a.n}</td>
          <td class="num">${a.p}</td>
          <td class="num">${pct(a.acc)}
            <div class="trk" style="margin-top:4px"><i class="${a.acc >= bestAcc * 0.8 ? "good" : a.acc >= bestAcc * 0.55 ? "warn" : "bad"}" style="width:${(a.acc / bestAcc) * 100}%"></i></div>
          </td>
          <td class="num">${gbp(a.saved)}</td>
          <td class="num">${a.rate ? pct(a.rate) : "—"}</td>
        </tr>`).join("")
    : `<tr><td colspan="6" class="hint">No refunds in this period.</td></tr>`;

  // tier usage
  const byTier = {};
  list.forEach((r) => {
    const k = r.tierLabel;
    (byTier[k] = byTier[k] || []).push(r);
  });
  const tierRows = Object.entries(byTier)
    .map(([label, rows]) => {
      const sv = savings(rows);
      return { label, n: rows.length, paid: rows.reduce((a, r) => a + r.value, 0), saved: sv.saved,
               ord: rows[0].isFull ? 999 : (rows[0].tierPct || 0) * 100 };
    })
    .sort((a, b) => a.ord - b.ord);

  document.querySelector("#tierTable tbody").innerHTML = tierRows.length
    ? tierRows.map((t) => `
        <tr>
          <td>${esc(t.label)}</td>
          <td class="num">${t.n}</td>
          <td class="num">${list.length ? pct(t.n / list.length) : "—"}</td>
          <td class="num">${gbp(t.paid)}</td>
          <td class="num">${t.saved ? gbp(t.saved) : "—"}</td>
        </tr>`).join("")
    : `<tr><td colspan="5" class="hint">No refunds in this period.</td></tr>`;

  // evidence lines under the draft policy
  const t40 = byTier["40%"] || [];
  const s40 = savings(t40);
  const sizing = list.filter((r) => /siz/i.test(r.reason));
  const high = list.filter((r) => r.tierPct != null && r.tierPct >= 0.5 && r.tierPct < 1);
  const sHigh = savings(high);
  const autoFull = list.filter((r) => /cancel|stock|lost|customs|duplicate|returned to sender/i.test(r.reason));
  const ev = {
    tier40: t40.length ? `Used ${t40.length}× this period · retained ${gbp(s40.saved)}` : "Not used in this period",
    sizing: sizing.length ? `${sizing.length} sizing refunds this period · ${gbp(sizing.reduce((a, r) => a + r.value, 0))} paid out` : "No sizing refunds in this period",
    tierHigh: high.length ? `${high.length} settled at 50–70% · retained ${gbp(sHigh.saved)}` : "Higher tiers not used in this period",
    full: autoFull.length ? `${autoFull.length} refunds this period were non-negotiable causes` : "None in this period",
  };
  document.querySelectorAll("#ladderSteps .ev").forEach((el) => {
    el.textContent = ev[el.dataset.ev] || "";
  });
}

function card(cls, value, key, note) {
  return `<div class="card ${cls}"><span class="v">${esc(value)}</span>` +
         `<span class="k">${esc(key)}</span>${note ? `<span class="n">${esc(note)}</span>` : ""}</div>`;
}

/* ---------------- render: refunds ---------------- */

function renderRefunds() {
  const list = scopedRefunds();
  const total = list.reduce((a, r) => a + r.value, 0);
  const label = state.month ? monthName(state.month) : "all months";

  document.getElementById("refundCards").innerHTML = [
    card("warn", gbp0(total), "Refunded", label),
    card("", list.length.toString(), "Refunds paid", label),
    card("", list.length ? gbp(total / list.length) : "—", "Average refund", ""),
    card("accent", new Set(list.map((r) => r.reason)).size.toString(), "Distinct reasons", "as recorded"),
  ].join("");

  const byReason = {};
  list.forEach((r) => { (byReason[r.reason] = byReason[r.reason] || []).push(r); });
  const reasonRows = Object.entries(byReason)
    .map(([reason, rows]) => ({ reason, n: rows.length, v: rows.reduce((a, r) => a + r.value, 0) }))
    .sort((a, b) => b.v - a.v);

  document.querySelector("#reasonTable tbody").innerHTML = reasonRows.length
    ? reasonRows.map((r) => `
        <tr><td>${esc(r.reason)}</td><td class="num">${r.n}</td>
        <td class="num">${list.length ? pct(r.n / list.length) : "—"}</td>
        <td class="num">${gbp(r.v)}</td><td class="num">${gbp(r.v / r.n)}</td></tr>`).join("")
    : `<tr><td colspan="5" class="hint">No refunds in this period.</td></tr>`;

  const byVa = {};
  list.forEach((r) => { const k = r.va || "(unassigned)"; (byVa[k] = byVa[k] || []).push(r); });
  const vaRows = Object.entries(byVa)
    .map(([va, rows]) => ({ va, n: rows.length, v: rows.reduce((a, r) => a + r.value, 0) }))
    .sort((a, b) => b.v - a.v);

  document.querySelector("#refundAgentTable tbody").innerHTML = vaRows.length
    ? vaRows.map((r) => `
        <tr><td>${esc(r.va)}</td><td class="num">${r.n}</td>
        <td class="num">${gbp(r.v)}</td><td class="num">${gbp(r.v / r.n)}</td></tr>`).join("")
    : `<tr><td colspan="4" class="hint">No refunds in this period.</td></tr>`;

  const q = (state.refundSearch || "").toLowerCase();
  let rows = q
    ? list.filter((r) => r.order.toLowerCase().includes(q) || r.va.toLowerCase().includes(q) || r.reason.toLowerCase().includes(q))
    : list;
  rows = rows.slice().sort((a, b) => (b.date ? b.date.getTime() : 0) - (a.date ? a.date.getTime() : 0));
  const shown = rows.slice(0, 400);

  document.querySelector("#refundTable tbody").innerHTML = shown.length
    ? shown.map((r) => `
        <tr>
          <td class="num">${esc(r.order)}</td><td>${esc(r.va)}</td>
          <td>${r.date ? r.date.toLocaleDateString("en-GB") : esc(r.dateRaw || "—")}</td>
          <td>${esc(r.reason)}</td><td class="num">${esc(r.tierLabel)}</td>
          <td class="num">${r.valueOk ? gbp(r.value) : esc(r.valueRaw || "—")}</td>
          <td>${esc(r.store)}</td>
        </tr>`).join("")
    : `<tr><td colspan="7" class="hint">Nothing matches.</td></tr>`;

  document.getElementById("refundCount").textContent =
    `Showing ${shown.length} of ${rows.length}` + (rows.length > 400 ? " (first 400)" : "");
}

/* ---------------- render: cancellations ---------------- */

function renderCancels() {
  const cancels = state.refunds.filter(isCancelType);
  const allRefunds = state.refunds;
  const totalV = cancels.reduce((a, r) => a + r.value, 0);
  const allV = allRefunds.reduce((a, r) => a + r.value, 0);

  document.getElementById("cancelCards").innerHTML = [
    card("bad", cancels.length.toString(), "Orders never shipped", "cancelled or out of stock"),
    card("bad", gbp0(totalV), "Refunded on them", "all time"),
    card("warn", allV ? pct(totalV / allV) : "—", "Of all refund value", "the money never earned"),
    card("", cancels.length ? gbp(totalV / cancels.length) : "—", "Average order lost", ""),
  ].join("");

  // by month, with share of that month's refunds
  const m = {}, mAll = {};
  cancels.forEach((r) => { if (r.date) { const k = monthKey(r.date); (m[k] = m[k] || []).push(r); } });
  allRefunds.forEach((r) => { if (r.date) { const k = monthKey(r.date); (mAll[k] = mAll[k] || []).push(r); } });
  const months = Object.keys(m).sort();
  const maxShare = Math.max(...months.map((k) => {
    const cv = m[k].reduce((a, r) => a + r.value, 0);
    const av = (mAll[k] || []).reduce((a, r) => a + r.value, 0);
    return av ? cv / av : 0;
  }), 0.0001);

  document.querySelector("#cancelMonthTable tbody").innerHTML = months.map((k) => {
    const cv = m[k].reduce((a, r) => a + r.value, 0);
    const av = (mAll[k] || []).reduce((a, r) => a + r.value, 0);
    const share = av ? cv / av : 0;
    return `<tr>
      <td>${monthName(k)}</td><td class="num">${m[k].length}</td><td class="num">${gbp(cv)}</td>
      <td class="num">${av ? pct(share) : "—"}</td>
      <td><div class="trk"><i class="${share > 0.4 ? "bad" : share > 0.25 ? "warn" : ""}" style="width:${(share / maxShare) * 100}%"></i></div></td>
    </tr>`;
  }).join("") || `<tr><td colspan="5" class="hint">None found.</td></tr>`;

  const byVa = {};
  cancels.forEach((r) => { const k = r.va || "(unassigned)"; (byVa[k] = byVa[k] || []).push(r); });
  document.querySelector("#cancelAgentTable tbody").innerHTML = Object.entries(byVa)
    .map(([va, rows]) => ({ va, n: rows.length, v: rows.reduce((a, r) => a + r.value, 0) }))
    .sort((a, b) => b.v - a.v)
    .map((r) => `<tr><td>${esc(r.va)}</td><td class="num">${r.n}</td>
                 <td class="num">${gbp(r.v)}</td><td class="num">${gbp(r.v / r.n)}</td></tr>`).join("")
    || `<tr><td colspan="4" class="hint">None found.</td></tr>`;

  // July reason snapshot, valued from whatever the sheet holds for those orders
  const valueOf = {};
  state.refunds.forEach((r) => { valueOf[r.order.replace(/[^0-9]/g, "")] = r.value; });
  const byCat = {};
  Object.entries(CANCEL_REASONS).forEach(([order, cat]) => {
    (byCat[cat] = byCat[cat] || []).push({ order, v: valueOf[order] || 0 });
  });
  const catRows = Object.entries(byCat)
    .map(([cat, rows]) => ({ cat, n: rows.length, v: rows.reduce((a, r) => a + r.v, 0) }))
    .sort((a, b) => b.v - a.v);
  const totalCat = catRows.reduce((a, r) => a + r.v, 0);
  const maxCat = Math.max(...catRows.map((r) => r.v), 1);

  document.querySelector("#cancelReasonTable tbody").innerHTML = catRows.map((r) => `
    <tr>
      <td>${esc(CANCEL_REASON_LABELS[r.cat] || r.cat)}</td>
      <td class="num">${r.n}</td><td class="num">${gbp(r.v)}</td>
      <td class="num">${gbp(r.v / r.n)}</td>
      <td><div class="trk"><i class="${/delivery|origin|oos|ourfault/.test(r.cat) ? "bad" : /error|trust/.test(r.cat) ? "warn" : ""}" style="width:${(r.v / maxCat) * 100}%"></i></div></td>
    </tr>`).join("") +
    `<tr class="tot"><td>Total</td><td class="num">${Object.keys(CANCEL_REASONS).length}</td>
     <td class="num">${gbp(totalCat)}</td><td class="num"></td><td></td></tr>`;

  const sel = document.getElementById("quoteFilter");
  if (sel.options.length <= 1) {
    sel.innerHTML = `<option value="">All reasons</option>` +
      catRows.map((r) => `<option value="${r.cat}">${esc(CANCEL_REASON_LABELS[r.cat] || r.cat)}</option>`).join("");
  }
  renderQuotes();
}

function renderQuotes() {
  const block = document.getElementById("quoteBlock");
  const withQuote = Object.keys(CANCEL_QUOTES).length;

  // cancel-quotes.js is deliberately not published; hide the section without it
  if (!withQuote) {
    if (block) block.hidden = true;
    return;
  }
  if (block) block.hidden = false;

  const cat = document.getElementById("quoteFilter").value;
  const q = (state.quoteSearch || "").toLowerCase();
  const valueOf = {};
  state.refunds.forEach((r) => { valueOf[r.order.replace(/[^0-9]/g, "")] = r.value; });

  let rows = Object.entries(CANCEL_QUOTES)
    .filter(([order]) => !cat || CANCEL_REASONS[order] === cat)
    .map(([order, quote]) => ({ order, cat: CANCEL_REASONS[order], quote, v: valueOf[order] || 0 }));

  if (q) rows = rows.filter((r) => r.quote.toLowerCase().includes(q) || r.order.includes(q));
  rows.sort((a, b) => b.v - a.v);

  document.getElementById("quoteList").innerHTML = rows.length
    ? rows.map((r) => `
        <div class="qrow">
          <div class="qmeta"><span class="qid">#${esc(r.order)}</span><span class="qv">${r.v ? gbp(r.v) : ""}</span></div>
          <div class="qtext">“${esc(r.quote)}”</div>
          <div class="qcat">${esc(CANCEL_REASON_LABELS[r.cat] || r.cat)}</div>
        </div>`).join("")
    : `<p class="hint">No quotes match.</p>`;

  document.getElementById("quoteCount").textContent =
    `${rows.length} of ${withQuote} quoted. ${Object.keys(CANCEL_REASONS).length - withQuote} orders gave no reason or had no ticket.`;
}

/* ---------------- render: refund rate ---------------- */

function renderRate() {
  const dated = state.refunds.filter((r) => r.date);

  // weekly
  const byWeek = {};
  dated.forEach((r) => {
    const k = weekKey(r.date);
    (byWeek[k] = byWeek[k] || []).push(r);
  });
  const weeks = Object.keys(byWeek).sort().reverse().slice(0, 16);

  let ratedWeeks = 0, refundSum = 0, orderSum = 0;
  weeks.forEach((w) => {
    const o = parseInt(state.weeklyOrders[w], 10);
    if (isFinite(o) && o > 0) { ratedWeeks++; refundSum += byWeek[w].length; orderSum += o; }
  });
  const overall = orderSum ? refundSum / orderSum : null;

  document.getElementById("rateCards").innerHTML = [
    card(overall == null ? "" : overall > 0.1 ? "bad" : overall > 0.05 ? "warn" : "good",
         overall == null ? "—" : pct(overall), "Refund rate", ratedWeeks ? `${ratedWeeks} weeks with order data` : "enter order counts below"),
    card("", weeks.length ? byWeek[weeks[0]].length.toString() : "0", "Refunds, latest week", weeks[0] ? fmtWeek(weeks[0]) : ""),
    card("warn", gbp0(dated.reduce((a, r) => a + r.value, 0)), "Refunded, all time", `${dated.length} refunds`),
    card("", state.pending.length.toString(), "Still awaiting payment", gbp0(state.pending.reduce((a, r) => a + r.value, 0))),
  ].join("");

  const maxRate = Math.max(...weeks.map((w) => {
    const o = parseInt(state.weeklyOrders[w], 10);
    return isFinite(o) && o > 0 ? byWeek[w].length / o : 0;
  }), 0.0001);

  document.querySelector("#weekTable tbody").innerHTML = weeks.length
    ? weeks.map((w) => {
        const rows = byWeek[w];
        const val = rows.reduce((a, r) => a + r.value, 0);
        const o = parseInt(state.weeklyOrders[w], 10);
        const has = isFinite(o) && o > 0;
        const rate = has ? rows.length / o : null;
        const cls = rate == null ? "" : rate > 0.1 ? "bad" : rate > 0.05 ? "warn" : "good";
        return `<tr>
          <td>${fmtWeek(w)}</td>
          <td class="num">${rows.length}</td>
          <td class="num">${gbp(val)}</td>
          <td class="num"><input class="inp-orders" type="number" min="0" step="1" data-week="${w}"
               value="${has ? o : ""}" placeholder="—" aria-label="Orders placed week of ${fmtWeek(w)}" /></td>
          <td class="num">${rate == null ? "<span class='hint'>needs orders</span>" : pct(rate)}</td>
          <td>${rate == null ? "" : `<div class="trk"><i class="${cls}" style="width:${(rate / maxRate) * 100}%"></i></div>`}</td>
        </tr>`;
      }).join("")
    : `<tr><td colspan="6" class="hint">No dated refunds found.</td></tr>`;

  document.querySelectorAll(".inp-orders").forEach((el) => {
    el.addEventListener("change", (e) => {
      const w = e.target.dataset.week;
      const v = parseInt(e.target.value, 10);
      if (isFinite(v) && v > 0) state.weeklyOrders[w] = v; else delete state.weeklyOrders[w];
      saveOrders();
      renderRate();
    });
  });

  const saved = Object.keys(state.weeklyOrders).length;
  document.getElementById("ordersSavedNote").textContent =
    saved ? `${saved} week${saved === 1 ? "" : "s"} of order counts saved in this browser.`
          : "Nothing saved yet — order counts live only in this browser, so enter them on the machine you report from.";

  // monthly
  const byMonth = {};
  dated.forEach((r) => {
    const k = monthKey(r.date);
    (byMonth[k] = byMonth[k] || []).push(r);
  });
  const months = Object.keys(byMonth).sort();
  const maxVal = Math.max(...months.map((m) => byMonth[m].reduce((a, r) => a + r.value, 0)), 1);

  document.querySelector("#monthTable tbody").innerHTML = months.map((m) => {
    const rows = byMonth[m];
    const val = rows.reduce((a, r) => a + r.value, 0);
    return `<tr>
      <td>${monthName(m)}</td>
      <td class="num">${rows.length}</td>
      <td class="num">${gbp(val)}</td>
      <td class="num">${gbp(val / rows.length)}</td>
      <td><div class="trk"><i style="width:${(val / maxVal) * 100}%"></i></div></td>
    </tr>`;
  }).join("");
}

function fmtWeek(k) {
  const [y, m, d] = k.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

/* ---------------- render: reconciliation ---------------- */

function detectIssues() {
  const issues = [];
  const refundOrders = new Map();
  state.refunds.forEach((r) => {
    if (!refundOrders.has(r.order)) refundOrders.set(r.order, []);
    refundOrders.get(r.order).push(r);
  });

  const textCells = state.textCells;
  if (textCells.length) {
    issues.push({
      sev: "bad",
      title: "Refund values stored as text",
      count: textCells.length,
      desc: "Google Sheets will not include a text cell in a SUM, so the sheet's own column total is short by this amount. " +
            "Retype each cell as a plain number to fix. Total hidden: " + gbp(textCells.reduce((a, r) => a + r.value, 0)) + ".",
      items: textCells.map((r) => `${r.order} (${r.valueRaw})`),
    });
  }

  const badDates = state.refunds.filter((r) => r.dateRepaired);
  if (badDates.length) {
    issues.push({
      sev: "warn",
      title: "Mistyped year in Date Refunded",
      count: badDates.length,
      desc: "Dates such as 7/22/0206 were read as 2026. They are included in every figure here, but any filter or " +
            "sort in the sheet itself will treat them as year 206 and place them out of range.",
      items: [...new Set(badDates.map((r) => r.dateRaw))],
    });
  }

  const undated = state.refunds.filter((r) => !r.dateOk);
  if (undated.length) {
    issues.push({
      sev: "warn", title: "Refunds with no usable date", count: undated.length,
      desc: "These cannot be placed in a month or week, so they are excluded from the rate and trend figures.",
      items: undated.slice(0, 40).map((r) => r.order),
    });
  }

  const badMoney = [...state.refunds, ...state.pending].filter((r) => r.valueTypo || (!r.valueOk && r.valueRaw));
  if (badMoney.length) {
    issues.push({
      sev: "bad", title: "Amounts that are not clean numbers", count: badMoney.length,
      desc: "Values such as 79/95 (a slash typed instead of a decimal point). Read literally these distort every total.",
      items: badMoney.map((r) => `${r.order} (“${r.valueRaw}”)`),
    });
  }

  const dupes = [...refundOrders.entries()].filter(([, rows]) => rows.length > 1);
  if (dupes.length) {
    issues.push({
      sev: "warn", title: "Order refunded more than once", count: dupes.length,
      desc: "Either a genuine second part-refund, or the same refund logged twice. Worth confirming — duplicates inflate every total.",
      items: dupes.map(([o, rows]) => `${o} (${rows.length}× · ${rows.map((r) => r.dateRaw).join(", ")})`),
    });
  }

  const paidButPending = state.pending.filter((p) => refundOrders.has(p.order));
  if (paidButPending.length) {
    issues.push({
      sev: "bad", title: "Still marked pending, but already refunded", count: paidButPending.length,
      desc: "These appear in the refund tracker yet remain open in the pending tracker, overstating what you owe by " +
            gbp(paidButPending.reduce((a, r) => a + r.value, 0)) + ". Close them off.",
      items: paidButPending.map((r) => r.order),
    });
  }

  const noAmount = state.pending.filter((p) => !p.valueOk || p.value === 0);
  if (noAmount.length) {
    issues.push({
      sev: "warn", title: "Pending refunds with no amount", count: noAmount.length,
      desc: "The backlog total understates the true liability by however much these are worth.",
      items: noAmount.slice(0, 40).map((r) => r.order),
    });
  }

  // The agent column should hold a person. Anything that also appears as a
  // reason code is a mis-keyed row, and it skews every per-agent figure.
  const reasonWords = new Set(state.refunds.map((r) => r.reason.toLowerCase()));
  const badVa = state.refunds.filter((r) => r.va && reasonWords.has(r.va.toLowerCase()));
  if (badVa.length) {
    issues.push({
      sev: "warn",
      title: "Reason code entered in the agent column",
      count: badVa.length,
      desc: "These rows name a status rather than a person, so they appear as a phantom agent in every " +
            "per-agent breakdown and no real agent gets credit for the work. Value affected: " +
            gbp(badVa.reduce((a, r) => a + r.value, 0)) + ".",
      items: [...new Set(badVa.map((r) => `${r.order} (“${r.va}”)`))],
    });
  }

  const mixed = state.refunds.filter((r) => r.store !== "Montanello UK");
  if (mixed.length) {
    issues.push({
      sev: "warn", title: "Two stores in one tracker", count: mixed.length,
      desc: "The refund tracker holds records from a second brand, separable only by order number. Adding a Store column " +
            "would make every figure attributable instead of inferred.",
      items: [],
    });
  }

  return issues;
}

function renderRecon() {
  const issues = detectIssues();
  const total = state.refunds.length + state.pending.length;
  const flagged = new Set();
  issues.forEach((i) => i.items.forEach((s) => flagged.add(String(s).split(" ")[0])));

  document.getElementById("reconCards").innerHTML = [
    card(issues.length ? "bad" : "good", issues.length.toString(), "Issue types found", issues.length ? "see below" : "all clean"),
    card("", total.toString(), "Records reconciled", "both trackers"),
    card(flagged.size ? "warn" : "good", flagged.size.toString(), "Records flagged", flagged.size ? "need a human look" : "none"),
    card("", total ? pct(1 - flagged.size / total) : "—", "Clean", "no flags raised"),
  ].join("");

  document.getElementById("issueList").innerHTML = issues.length
    ? issues.map((i) => `
        <div class="issue ${i.sev === "bad" ? "" : "warn"}">
          <div class="h">${esc(i.title)} <span class="c">${i.count} record${i.count === 1 ? "" : "s"}</span></div>
          <div class="d">${esc(i.desc)}</div>
          ${i.items.length ? `<div class="list">${esc(i.items.slice(0, 25).join("  ·  "))}${i.items.length > 25 ? `  … +${i.items.length - 25} more` : ""}</div>` : ""}
        </div>`).join("")
    : `<div class="issue ok"><div class="h">No problems detected</div>
         <div class="d">Both trackers reconcile cleanly against each other.</div></div>`;

  renderLedger(flagged);
}

function renderLedger(flagged) {
  const q = state.ledgerSearch.toLowerCase();
  let rows = [...state.refunds, ...state.pending];

  if (state.ledgerScope === "refunded") rows = rows.filter((r) => r.kind === "refund");
  else if (state.ledgerScope === "pending") rows = rows.filter((r) => r.kind === "pending");
  else if (state.ledgerScope === "issues") rows = rows.filter((r) => flagged.has(r.order));

  if (q) {
    rows = rows.filter((r) =>
      r.order.toLowerCase().includes(q) ||
      r.va.toLowerCase().includes(q) ||
      r.reason.toLowerCase().includes(q));
  }

  rows.sort((a, b) => (b.date ? b.date.getTime() : 0) - (a.date ? a.date.getTime() : 0));
  const shown = rows.slice(0, 400);

  document.querySelector("#ledgerTable tbody").innerHTML = shown.length
    ? shown.map((r) => {
        const flags = [];
        if (r.valueTypo) flags.push("amount typo");
        if (r.dateRepaired) flags.push("year typo");
        if (!r.valueOk && r.valueRaw) flags.push("bad amount");
        if (!r.valueOk && !r.valueRaw) flags.push("no amount");
        if (state.textCells.some((t) => t.order === r.order && r.kind === "refund")) flags.push("stored as text");
        if (r.kind === "pending" && state.refunds.some((x) => x.order === r.order)) flags.push("already refunded");
        return `<tr>
          <td><span class="pill ${r.kind === "refund" ? "refunded" : "pending"}">${r.kind === "refund" ? "Refunded" : "Pending"}</span></td>
          <td class="num">${esc(r.order)}</td>
          <td>${esc(r.va)}</td>
          <td>${r.date ? r.date.toLocaleDateString("en-GB") : esc(r.dateRaw || "—")}</td>
          <td>${esc(r.reason)}</td>
          <td class="num">${esc(r.tierLabel)}</td>
          <td class="num">${r.valueOk ? gbp(r.value) : esc(r.valueRaw || "—")}</td>
          <td>${esc(r.store)}</td>
          <td>${flags.map((f) => `<span class="pill flag">${esc(f)}</span>`).join("")}</td>
        </tr>`;
      }).join("")
    : `<tr><td colspan="9" class="hint">Nothing matches.</td></tr>`;

  document.getElementById("ledgerCount").textContent =
    `Showing ${shown.length} of ${rows.length} records` + (rows.length > 400 ? " (first 400)" : "");
}

function downloadCsv(head, body, name) {
  const csv = [head, ...body]
    .map((r) => r.map((c) => `"${String(c == null ? "" : c).replace(/"/g, '""')}"`).join(","))
    .join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  a.download = `${name}-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function exportRefunds() {
  const list = scopedRefunds();
  downloadCsv(
    ["Order", "Agent", "Date", "Reason", "Tier", "Value", "Store"],
    list.map((r) => [
      r.order, r.va,
      r.date ? r.date.toLocaleDateString("en-GB") : r.dateRaw,
      r.reason, r.tierLabel,
      r.valueOk ? r.value.toFixed(2) : r.valueRaw,
      r.store,
    ]),
    "montanello-refunds"
  );
}

function exportLedger() {
  const rows = [...state.refunds, ...state.pending];
  const head = ["State", "Order", "Agent", "Date", "Reason", "Tier", "Value", "Store"];
  const body = rows.map((r) => [
    r.kind === "refund" ? "Refunded" : "Pending",
    r.order, r.va,
    r.date ? r.date.toLocaleDateString("en-GB") : r.dateRaw,
    r.reason, r.tierLabel,
    r.valueOk ? r.value.toFixed(2) : r.valueRaw,
    r.store,
  ]);
  const csv = [head, ...body]
    .map((r) => r.map((c) => `"${String(c == null ? "" : c).replace(/"/g, '""')}"`).join(","))
    .join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  a.download = `montanello-unified-ledger-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

/* ---------------- shell ---------------- */

function buildMonthOptions() {
  const sel = document.getElementById("monthFilter");
  const keys = [...new Set(state.refunds.filter((r) => r.date).map((r) => monthKey(r.date)))].sort().reverse();
  const current = state.month;
  sel.innerHTML = `<option value="">All months</option>` +
    keys.map((k) => `<option value="${k}">${monthName(k)}</option>`).join("");
  // Default to every month: landing on the current one shows a near-empty
  // tab for the first few days of each month.
  if (current && keys.includes(current)) sel.value = current;
  else { state.month = ""; sel.value = ""; }
}

function renderAll() {
  renderRefunds();
  renderCancels();
  renderLadder();
  renderRate();
  renderRecon();
}

function init() {
  document.getElementById("monthFilter").addEventListener("change", (e) => {
    state.month = e.target.value;
    renderLadder();
    renderRefunds();
  });

  document.getElementById("refundSearch").addEventListener("input", (e) => {
    state.refundSearch = e.target.value;
    renderRefunds();
  });
  document.getElementById("exportRefunds").addEventListener("click", exportRefunds);

  document.getElementById("quoteFilter").addEventListener("change", renderQuotes);
  document.getElementById("quoteSearch").addEventListener("input", (e) => {
    state.quoteSearch = e.target.value;
    renderQuotes();
  });

  document.getElementById("mxRefresh").addEventListener("click", load);

  document.getElementById("ledgerSearch").addEventListener("input", (e) => {
    state.ledgerSearch = e.target.value;
    renderRecon();
  });
  document.getElementById("ledgerScope").addEventListener("change", (e) => {
    state.ledgerScope = e.target.value;
    renderRecon();
  });
  document.getElementById("exportCsv").addEventListener("click", exportLedger);

  document.getElementById("clearOrders").addEventListener("click", () => {
    state.weeklyOrders = {};
    saveOrders();
    renderRate();
  });

  load();
  setInterval(load, REFRESH_MS);
  window.addEventListener("focus", () => {
    if (document.visibilityState === "visible") load();
  });
}

init();

})();
