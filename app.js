// Google Sheet source (must remain shared as "Anyone with the link can view")
const SHEET_ID = "19WihBvQ8fUmkj9ioqvZMapAZAVFMij_6_Ca4rCWYh6k";
const GID = "0";
const SHEET_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&gid=${GID}`;

const REFRESH_INTERVAL_MS = 60 * 1000;

const state = {
  rows: [],
  sortKey: "days",
  sortDir: "desc",
  search: "",
  vaFilter: "",
  statusFilter: "",
};

function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ""));
}

function parseDate(str) {
  if (!str) return null;
  const parts = str.trim().split("/");
  if (parts.length !== 3) return null;
  const [m, d, y] = parts.map((p) => parseInt(p, 10));
  if (!m || !d || !y) return null;
  return new Date(y, m - 1, d);
}

function daysBetween(from, to) {
  const msPerDay = 24 * 60 * 60 * 1000;
  const a = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  const b = new Date(to.getFullYear(), to.getMonth(), to.getDate());
  return Math.round((b - a) / msPerDay);
}

function statusFor(daysOverdue) {
  if (daysOverdue >= 10) return "red";
  if (daysOverdue >= 7) return "orange";
  if (daysOverdue >= 5) return "yellow";
  return "ok";
}

const STATUS_LABEL = {
  ok: "On Time",
  yellow: "5+ Days Overdue",
  orange: "7+ Days Overdue",
  red: "10+ Days Overdue",
};

function rowsFromCSV(csvRows) {
  const [header, ...body] = csvRows;
  const idx = {
    va: header.findIndex((h) => h.trim().toLowerCase() === "va"),
    order: header.findIndex((h) => h.trim().toLowerCase() === "order number"),
    promised: header.findIndex((h) => h.trim().toLowerCase() === "promised date"),
  };

  const today = new Date();

  return body
    .map((r) => {
      const va = (r[idx.va] || "").trim();
      const order = (r[idx.order] || "").trim();
      const promisedRaw = (r[idx.promised] || "").trim();
      const promisedDate = parseDate(promisedRaw);
      if (!va && !order) return null;

      const daysOverdue = promisedDate ? daysBetween(promisedDate, today) : null;
      const status = daysOverdue === null ? "ok" : statusFor(daysOverdue);

      return {
        va,
        order,
        promisedRaw,
        promisedDate,
        daysOverdue,
        status,
      };
    })
    .filter(Boolean);
}

async function fetchData() {
  const errorBox = document.getElementById("errorBox");
  try {
    const res = await fetch(`${SHEET_URL}&_=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`Sheet request failed (${res.status})`);
    const text = await res.text();
    const csvRows = parseCSV(text);
    state.rows = rowsFromCSV(csvRows);
    errorBox.hidden = true;
    updateVAOptions();
    render();
    document.getElementById("lastUpdated").textContent =
      "Last updated: " + new Date().toLocaleTimeString();
  } catch (err) {
    errorBox.hidden = false;
    errorBox.textContent =
      "Couldn't load data from Google Sheets: " + err.message;
    console.error(err);
  }
}

function updateVAOptions() {
  const select = document.getElementById("vaFilter");
  const current = select.value;
  const vas = Array.from(new Set(state.rows.map((r) => r.va).filter(Boolean))).sort();
  select.innerHTML =
    '<option value="">All VAs</option>' +
    vas.map((va) => `<option value="${va}">${va}</option>`).join("");
  select.value = vas.includes(current) ? current : "";
}

function applyFiltersAndSort(rows) {
  let out = rows.filter((r) => {
    if (state.vaFilter && r.va !== state.vaFilter) return false;
    if (state.statusFilter && r.status !== state.statusFilter) return false;
    if (state.search) {
      const s = state.search.toLowerCase();
      if (!r.va.toLowerCase().includes(s) && !r.order.toLowerCase().includes(s)) {
        return false;
      }
    }
    return true;
  });

  const dir = state.sortDir === "asc" ? 1 : -1;
  out.sort((a, b) => {
    let av, bv;
    switch (state.sortKey) {
      case "va":
        av = a.va.toLowerCase();
        bv = b.va.toLowerCase();
        break;
      case "order":
        av = a.order;
        bv = b.order;
        break;
      case "promised":
        av = a.promisedDate ? a.promisedDate.getTime() : -Infinity;
        bv = b.promisedDate ? b.promisedDate.getTime() : -Infinity;
        break;
      case "status":
        av = a.status;
        bv = b.status;
        break;
      case "days":
      default:
        av = a.daysOverdue === null ? -Infinity : a.daysOverdue;
        bv = b.daysOverdue === null ? -Infinity : b.daysOverdue;
        break;
    }
    if (av < bv) return -1 * dir;
    if (av > bv) return 1 * dir;
    return 0;
  });

  return out;
}

function render() {
  const filtered = applyFiltersAndSort(state.rows);
  const tbody = document.getElementById("tableBody");

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" class="empty-row">No pending refunds match your filters.</td></tr>`;
  } else {
    tbody.innerHTML = filtered
      .map((r) => {
        const daysLabel = r.daysOverdue === null ? "—" : r.daysOverdue;
        const promisedLabel = r.promisedDate
          ? r.promisedDate.toLocaleDateString()
          : r.promisedRaw || "—";
        return `
          <tr class="row-${r.status}">
            <td>${escapeHTML(r.va)}</td>
            <td>${escapeHTML(r.order)}</td>
            <td>${escapeHTML(promisedLabel)}</td>
            <td>${daysLabel}</td>
            <td><span class="status-pill">${STATUS_LABEL[r.status]}</span></td>
          </tr>
        `;
      })
      .join("");
  }

  const counts = { ok: 0, yellow: 0, orange: 0, red: 0 };
  state.rows.forEach((r) => counts[r.status]++);
  document.getElementById("countTotal").textContent = state.rows.length;
  document.getElementById("countOk").textContent = counts.ok;
  document.getElementById("countYellow").textContent = counts.yellow;
  document.getElementById("countOrange").textContent = counts.orange;
  document.getElementById("countRed").textContent = counts.red;
}

function escapeHTML(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function initControls() {
  document.getElementById("refreshBtn").addEventListener("click", fetchData);

  document.getElementById("searchInput").addEventListener("input", (e) => {
    state.search = e.target.value;
    render();
  });

  document.getElementById("vaFilter").addEventListener("change", (e) => {
    state.vaFilter = e.target.value;
    render();
  });

  document.getElementById("statusFilter").addEventListener("change", (e) => {
    state.statusFilter = e.target.value;
    render();
  });

  document.querySelectorAll("th[data-sort]").forEach((th) => {
    th.addEventListener("click", () => {
      const key = th.dataset.sort;
      if (state.sortKey === key) {
        state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
      } else {
        state.sortKey = key;
        state.sortDir = "desc";
      }
      render();
    });
  });
}

initControls();
fetchData();
setInterval(fetchData, REFRESH_INTERVAL_MS);
