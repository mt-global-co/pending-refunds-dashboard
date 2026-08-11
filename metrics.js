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

/* All three tabs now live in one "Refunds" workbook. The old standalone
 * pending sheet (19WihBv…) was retired on 3 Aug 2026.
 *
 * Cancellations moved to their own tab with a "Reason for Cancellation"
 * dropdown, and the Refunds tab stopped receiving them — so a cancellation
 * appears in exactly one of the two. They are combined, not deduplicated. */
const SHEET_ID = "18nZ5isXR5KOKwftQKfCMucsgEm4n_kVwTeVbZlebKoI";
const SOURCES = {
  refunds:      { id: SHEET_ID, gid: "1691212125" },  // Refunds
  cancellations:{ id: SHEET_ID, gid: "1204712776" },  // Cancellation
  pending:      { id: SHEET_ID, gid: "478000033"  },  // Pending Refunds
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

/** A refund that never shipped: cancelled before dispatch, or sold without
 *  stock. Anything on the Cancellation tab qualifies by definition — its
 *  reasons ("Delivery Timeline") do not contain the word "cancel". */
const isCancelType = (r) =>
  r.source === "cancellation" || /cancel|out of stock|duplicate order/i.test(r.reason);
const REFRESH_MS = 5 * 60 * 1000;

const state = {
  refunds: [],      // Refunds tab + Cancellation tab combined
  cancelTab: [],    // Cancellation tab alone, for its live reason breakdown
  pending: [],
  month: "",        // "" = all months (Refunds and Save-Rate Ladder)
  refundSearch: "",
  quoteSearch: "",
  cancelFrom: "",   // "" = unbounded (Cancellations)
  cancelTo: "",
};

/* ---------------- utilities ---------------- */

const csvUrl = (s) =>
  `https://docs.google.com/spreadsheets/d/${s.id}/export?format=csv&gid=${s.gid}&_=${Date.now()}`;

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

// Column names we expect to see. Used to locate the header row rather than
// assuming it is the first one — a note pinned above the table ("No Refunds
// over the Weekends!") once shifted every tab down by a row and silently
// emptied the whole dashboard.
const KNOWN_HEADERS = [
  "va", "order", "order number", "date refunded", "reason",
  "reason for cancellation", "refund %", "refund value",
  "promised date", "status", "amount to refund",
];

/** Index of the first row that looks like a header, or 0 if none does. */
function findHeaderRow(rows) {
  const limit = Math.min(rows.length, 10);
  for (let i = 0; i < limit; i++) {
    const hits = rows[i]
      .map((c) => c.trim().toLowerCase())
      .filter((c) => c && KNOWN_HEADERS.includes(c)).length;
    if (hits >= 2) return i;
  }
  return 0;
}

function toObjects(rows) {
  if (!rows.length) return [];
  const h = findHeaderRow(rows);
  const head = rows[h].map((c) => c.trim().toLowerCase());
  return rows.slice(h + 1).map((r) => {
    const o = {};
    head.forEach((k, i) => { o[k] = (r[i] || "").trim(); });
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

function esc(s) {
  const d = document.createElement("div");
  d.textContent = s == null ? "" : String(s);
  return d.innerHTML;
}

/** Is this refund inside the Cancellations tab's date range? */
function inCancelRange(r) {
  if (!r.date) return !state.cancelFrom && !state.cancelTo;
  const day = `${r.date.getFullYear()}-${String(r.date.getMonth() + 1).padStart(2, "0")}-${String(r.date.getDate()).padStart(2, "0")}`;
  if (state.cancelFrom && day < state.cancelFrom) return false;
  if (state.cancelTo && day > state.cancelTo) return false;
  return true;
}

/* ---------------- loading ---------------- */

async function fetchCsv(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return toObjects(parseCSV(await res.text()));
}

/** Ethoca alerts are dispute warnings, not refunds the team negotiated, and
 *  they carry "Ethoca Alert" in the agent column instead of a name — which put
 *  a phantom agent in every per-agent table and dragged the acceptance rate
 *  down. Excluded from all metrics; the status line reports how many. */
const isEthoca = (r) =>
  /ethoca/i.test(r["va"] || "") ||
  /ethoca/i.test(r["reason"] || r["reason "] || r["reason for cancellation"] || "");

let ethocaSkipped = 0;

/** Shared by the Refunds and Cancellation tabs — same shape, different
 *  reason header. `source` records which tab a row came from. */
function normaliseRefunds(rows, source) {
  return rows
    .map((r) => {
      const order = (r["order"] || r["order "] || "").trim();
      if (!order) return null;
      if (isEthoca(r)) { ethocaSkipped++; return null; }
      const d = parseDate(r["date refunded"]);
      const v = money(r["refund value"]);
      const t = tier(r["refund %"]);
      const num = parseInt(order.replace(/[^0-9]/g, ""), 10);
      return {
        kind: "refund",
        source,
        va: r["va"] || "",
        order,
        num: isFinite(num) ? num : 0,
        date: d.date,
        dateRaw: d.raw,
        dateOk: d.ok,
        dateRepaired: !!d.repaired,
        // "Reason for Cancellation" is the Cancellation tab's header
        reason: (r["reason"] || r["reason "] || r["reason for cancellation"] || "").trim() || "(none)",
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
  status.textContent = "Loading all three tabs…";
  status.classList.remove("err");
  try {
    const [rRows, cRows, pRows] = await Promise.all([
      fetchCsv(csvUrl(SOURCES.refunds)),
      fetchCsv(csvUrl(SOURCES.cancellations)),
      fetchCsv(csvUrl(SOURCES.pending)),
    ]);
    // Kept strictly apart so each dashboard tab mirrors its sheet tab.
    // Only the Cancellations view combines them, via allRefunds().
    ethocaSkipped = 0;
    state.refunds = normaliseRefunds(rRows, "refunds");        // Refunds tab only
    state.cancelTab = normaliseRefunds(cRows, "cancellation"); // Cancellation tab only
    state.pending = normalisePending(pRows);
    showError(null);
    buildMonthOptions();
    renderAll();
    status.textContent =
      `${state.refunds.length} refunds · ${state.cancelTab.length} cancellations · ` +
      `${state.pending.length} awaiting payment` +
      (ethocaSkipped ? ` · ${ethocaSkipped} Ethoca alerts excluded` : "") +
      ` · updated ${new Date().toLocaleTimeString("en-GB")}`;
  } catch (e) {
    showError("Could not load the Refunds workbook: " + e.message +
      ". It must stay shared as “Anyone with the link can view”.");
    status.textContent = "Load failed.";
    status.classList.add("err");
  }
}

/* ---------------- selectors ---------------- */

const inMonth = (r) => !state.month || (r.date && monthKey(r.date) === state.month);
/** Settled below full value. */
const isPartial = (r) => r.tierPct != null && r.tierPct < 1;

/** Could a partial even have been offered? Only when the customer ended up
 *  holding the goods. Cancelled, out of stock, lost, stuck in customs or
 *  returned means there is nothing for them to keep, so a full refund is the
 *  only outcome and it is not a negotiating failure. */
const NON_NEGOTIABLE =
  /cancel|out of stock|lost package|in customs|returned to sender|duplicate|returned by customer|escalation|uk\/law/i;
const isNegotiable = (r) => !NON_NEGOTIABLE.test(r.reason);

/** Refunds tab only — what the Refunds view and the Save-Rate Ladder report on. */
const scopedRefunds = () => state.refunds.filter(inMonth);

/** Both tabs. Only the Cancellations view needs this, to express cancellations
 *  as a share of everything refunded. There is no overlap between the two. */
const allRefunds = () => state.refunds.concat(state.cancelTab);

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
  const partials = list.filter(isPartial);
  const fulls = list.filter((r) => r.isFull);
  const totalValue = list.reduce((a, r) => a + r.value, 0);

  // Judging agents on all refunds is unfair: you cannot offer someone 40% to
  // keep goods that were cancelled, went out of stock or never cleared customs.
  // The honest measure is how often a partial was secured when one was possible.
  const negotiable = list.filter(isNegotiable);
  const nonNegotiable = list.filter((r) => !isNegotiable(r));
  const negPartials = negotiable.filter(isPartial);

  document.getElementById("ladderCards").innerHTML = [
    card("good", gbp0(s.saved), "Kept in the business", `across ${s.n} settlements`),
    card("good", negotiable.length ? pct(negPartials.length / negotiable.length) : "—",
         "Partial secured", "where one was possible"),
    card("accent", s.exposure ? pct(s.saved / s.exposure) : "—", "Save rate", "of what those cases would have cost"),
    card("warn", gbp0(totalValue), "Paid out", `${list.length} refunds`),
    card("", nonNegotiable.length.toString(), "Full refund unavoidable",
         "never received or cancelled"),
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
      const neg = rows.filter(isNegotiable);
      const negP = neg.filter(isPartial);
      return {
        va, n: rows.length,
        neg: neg.length,
        secured: neg.length ? negP.length / neg.length : 0,
        saved: sv.saved,
        rate: sv.exposure ? sv.saved / sv.exposure : 0,
      };
    })
    .sort((a, b) => b.saved - a.saved);

  document.querySelector("#agentTable tbody").innerHTML = agentRows.length
    ? agentRows.map((a) => `
        <tr>
          <td>${esc(a.va)}</td>
          <td class="num">${a.n}</td>
          <td class="num">${a.neg}</td>
          <td class="num">${pct(a.secured)}
            <div class="trk" style="margin-top:4px"><i class="${a.secured >= 0.9 ? "good" : a.secured >= 0.8 ? "warn" : "bad"}" style="width:${a.secured * 100}%"></i></div>
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
  const everything = allRefunds().filter(inCancelRange);
  const cancels = everything.filter(isCancelType);
  const totalV = cancels.reduce((a, r) => a + r.value, 0);
  const allV = everything.reduce((a, r) => a + r.value, 0);

  const fmt = (s) => s ? new Date(s + "T00:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : null;
  const rangeLabel = (!state.cancelFrom && !state.cancelTo) ? "all time"
    : `${fmt(state.cancelFrom) || "start"} – ${fmt(state.cancelTo) || "today"}`;
  document.getElementById("cancelRangeNote").textContent =
    `Showing ${cancels.length} of ${allRefunds().filter(isCancelType).length} cancellations · ${rangeLabel}`;

  document.getElementById("cancelCards").innerHTML = [
    card("bad", cancels.length.toString(), "Orders never shipped", "cancelled or out of stock"),
    card("bad", gbp0(totalV), "Refunded on them", rangeLabel),
    card("warn", allV ? pct(totalV / allV) : "—", "Of all refund value", "in this range"),
    card("", cancels.length ? gbp(totalV / cancels.length) : "—", "Average order lost", ""),
  ].join("");

  // by month, with share of that month's refunds
  const m = {}, mAll = {};
  cancels.forEach((r) => { if (r.date) { const k = monthKey(r.date); (m[k] = m[k] || []).push(r); } });
  everything.forEach((r) => { if (r.date) { const k = monthKey(r.date); (mAll[k] = mAll[k] || []).push(r); } });
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

  // Live reasons straight off the Cancellation tab
  const live = state.cancelTab.filter(inCancelRange);
  const liveTotal = live.reduce((a, r) => a + r.value, 0);
  const byLive = {};
  live.forEach((r) => { (byLive[r.reason] = byLive[r.reason] || []).push(r); });
  const liveRows = Object.entries(byLive)
    .map(([reason, rows]) => ({ reason, n: rows.length, v: rows.reduce((a, x) => a + x.value, 0) }))
    .sort((a, b) => b.v - a.v);
  const maxLive = Math.max(...liveRows.map((r) => r.v), 1);

  document.querySelector("#liveReasonTable tbody").innerHTML = liveRows.length
    ? liveRows.map((r) => `
        <tr>
          <td>${esc(r.reason)}</td>
          <td class="num">${r.n}</td>
          <td class="num">${gbp(r.v)}</td>
          <td class="num">${gbp(r.v / r.n)}</td>
          <td><div class="trk"><i style="width:${(r.v / maxLive) * 100}%"></i></div></td>
        </tr>`).join("") +
      `<tr class="tot"><td>Total</td><td class="num">${live.length}</td>
       <td class="num">${gbp(liveTotal)}</td><td class="num"></td><td></td></tr>`
    : `<tr><td colspan="5" class="hint">No cancellations logged on that tab in this date range.</td></tr>`;

  document.getElementById("liveReasonNote").textContent = state.cancelTab.length
    ? `${state.cancelTab.length} cancellation${state.cancelTab.length === 1 ? "" : "s"} logged on the Cancellation tab in total. Cancellations recorded before that tab existed sit in the Refunds tab and carry no reason.`
    : "Nothing logged on the Cancellation tab yet.";

  // Quote filter options come straight from the categories that have quotes.
  const sel = document.getElementById("quoteFilter");
  if (sel.options.length <= 1) {
    const cats = [...new Set(Object.keys(CANCEL_QUOTES).map((o) => CANCEL_REASONS[o]).filter(Boolean))];
    sel.innerHTML = `<option value="">All reasons</option>` +
      cats.map((c) => `<option value="${c}">${esc(CANCEL_REASON_LABELS[c] || c)}</option>`).join("");
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
  allRefunds().forEach((r) => { valueOf[r.order.replace(/[^0-9]/g, "")] = r.value; });

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
}

/** Set the cancellation range from a preset chip and re-render. */
function applyPreset(kind) {
  const today = new Date();
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  let from = null, to = null;

  if (kind === "30" || kind === "90") {
    const d = new Date(today);
    d.setDate(d.getDate() - Number(kind));
    from = iso(d); to = iso(today);
  } else if (kind === "thismonth") {
    from = iso(new Date(today.getFullYear(), today.getMonth(), 1));
    to = iso(today);
  } else if (kind === "lastmonth") {
    from = iso(new Date(today.getFullYear(), today.getMonth() - 1, 1));
    to = iso(new Date(today.getFullYear(), today.getMonth(), 0));
  }

  state.cancelFrom = from || "";
  state.cancelTo = to || "";
  document.getElementById("cancelFrom").value = state.cancelFrom;
  document.getElementById("cancelTo").value = state.cancelTo;
  document.querySelectorAll("#cancelPresets .chip")
    .forEach((c) => c.classList.toggle("active", c.dataset.range === kind));
  renderCancels();
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

  // Cancellation date range
  document.getElementById("cancelPresets").addEventListener("click", (e) => {
    const chip = e.target.closest(".chip");
    if (chip) applyPreset(chip.dataset.range);
  });
  ["cancelFrom", "cancelTo"].forEach((id) => {
    document.getElementById(id).addEventListener("change", (e) => {
      state[id] = e.target.value;
      document.querySelectorAll("#cancelPresets .chip").forEach((c) => c.classList.remove("active"));
      renderCancels();
    });
  });
  applyPreset("all");

  load();
  setInterval(load, REFRESH_MS);
  window.addEventListener("focus", () => {
    if (document.visibilityState === "visible") load();
  });
}

// A stale cached copy of this file paired with newer HTML would otherwise
// throw here and leave the page sitting on "Loading metrics…" forever.
try {
  init();
} catch (e) {
  const s = document.getElementById("mxStatus");
  if (s) { s.textContent = "Metrics failed to start."; s.classList.add("err"); }
  showError("The metrics tabs could not start: " + e.message +
    ". This is usually a cached copy of an older dashboard — reload the page, " +
    "or press Ctrl+Shift+R. The pending queue above is unaffected.");
  console.error(e);
}

})();
