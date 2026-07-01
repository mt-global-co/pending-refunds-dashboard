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
- Data auto-refreshes every 60 seconds, or click **Refresh**.

## Requirements

- The Google Sheet must stay shared as **"Anyone with the link can view"**.
  If sharing is changed to private, the dashboard will fail to load data.
- Sheet columns expected (header row, any order): `VA`, `Order Number`,
  `Promised Date` (format `M/D/YYYY`).

## Updating the source sheet

If you ever need to point this at a different sheet or tab, edit the
constants at the top of [`app.js`](app.js):

```js
const SHEET_ID = "19WihBvQ8fUmkj9ioqvZMapAZAVFMij_6_Ca4rCWYh6k";
const GID = "0";
```

`SHEET_ID` is the long string in the sheet's URL; `GID` is the tab id
(`gid=` in the URL when that tab is open).

## Local preview

This is a static site — open `index.html` directly, or serve it locally:

```
npx serve .
```
