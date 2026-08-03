# Pending Refunds Dashboard

Live dashboard that pulls pending refund data directly from Google Sheets and
flags overdue refunds by color:

| Days overdue (from Promised Date) | Color  |
|---|---|
| 5+  | Yellow |
| 7+  | Orange |
| 10+ | Red    |

## How it works

- The page fetches the sheet's CSV export (`.../gviz/tq?tqx=out:csv`) directly
  in the browser, so data is always live — no backend, no build step.
- "Days overdue" = today's date minus the **Promised Date** column.
- Data auto-refreshes every 30 seconds, refetches when the tab regains
  focus, or click **Refresh**.

## Requirements

- The Google Sheet must stay shared as **"Anyone with the link can view"**.
  If sharing is changed to private, the dashboard will fail to load data.
- Sheet columns expected (header row, any order): `VA`, `Order Number`,
  `Promised Date` (format `M/D/YYYY`), `Status` (`Pending`, `Refunded`,
  `Chargeback`, or `Ethoca Alert`; blank = Pending), and `Date Refunded`
  (the date the status was last changed, format `M/D/YYYY`; the headers
  `Status Date`, `Date Updated`, `Updated`, and `Closed Date` also work).

## Frozen overdue counts

Cases marked `Refunded`, `Chargeback`, or `Ethoca Alert` are closed: their
"Days Overdue" stops counting on the `Date Refunded` instead of increasing
daily. If `Date Refunded` is blank for a closed case, the dashboard falls
back to a live count, so make sure the date gets filled in when the status
changes. To stamp it automatically, add this Apps Script to the sheet
(Extensions → Apps Script), adjusting the column numbers if yours differ:

```js
function onEdit(e) {
  const STATUS_COL = 4;      // D = Status
  const STATUS_DATE_COL = 5; // E = Status Date
  const range = e.range;
  if (range.getColumn() !== STATUS_COL || range.getRow() < 2) return;
  const sheet = range.getSheet();
  sheet
    .getRange(range.getRow(), STATUS_DATE_COL)
    .setValue(Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "M/d/yyyy"));
}
```

## Source data

Everything comes from one Google Sheet — the **Refunds** workbook,
`18nZ5isXR5KOKwftQKfCMucsgEm4n_kVwTeVbZlebKoI` — across three tabs:

| Tab | gid | Used for |
|---|---|---|
| Refunds | `1691212125` | Refunds paid, Save-Rate Ladder, historical cancellations |
| Cancellation | `1204712776` | Live cancellation reasons |
| Pending Refunds | `478000033` | The pending queue |

The standalone "Pending Refunds" sheet (`19WihBv…`) was retired on
3 August 2026 and is no longer read.

Cancellations are logged on the **Cancellation** tab and no longer added to
**Refunds**, so a cancellation appears in exactly one of the two. The
dashboard concatenates them without deduplicating, which is safe only while
that stays true.

To repoint it, edit `SHEET_ID` / `GID` at the top of [`app.js`](app.js) and
the `SOURCES` block in [`metrics.js`](metrics.js). `gid` is the number in the
sheet URL when that tab is open.

Read through `/export?format=csv`, **not** `gviz` — gviz applies whatever
filter is active on a tab and will silently return only the visible rows.

## Local preview

This is a static site — open `index.html` directly, or serve it locally:

```
npx serve .
```
