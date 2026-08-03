/* Tab shell. Owns which view is on screen and nothing else — the pending
 * dashboard (app.js) and the metrics views (metrics.js) each keep their own
 * state and simply live inside these containers. */
(function () {
  const METRIC_VIEWS = new Set(["refunds", "cancels", "ladder", "rate", "recon"]);
  // Views where the month selector actually filters something.
  const MONTH_VIEWS = new Set(["refunds", "ladder"]);

  function show(name) {
    document.querySelectorAll(".apptab").forEach((t) =>
      t.classList.toggle("active", t.dataset.view === name));
    document.querySelectorAll(".view").forEach((v) =>
      v.classList.toggle("active", v.id === "view-" + name));

    // The metrics toolbar is shared by the three metrics views only.
    const onMetrics = METRIC_VIEWS.has(name);
    document.getElementById("mxBar").classList.toggle("active", onMetrics);
    const err = document.getElementById("mxError");
    err.classList.toggle("active", onMetrics && !err.hidden);

    document.getElementById("monthFilter").style.visibility =
      MONTH_VIEWS.has(name) ? "visible" : "hidden";

    try { localStorage.setItem("montanello.view", name); } catch { /* ignore */ }
    window.dispatchEvent(new CustomEvent("viewchange", { detail: { view: name } }));
  }

  document.getElementById("appTabs").addEventListener("click", (e) => {
    const b = e.target.closest(".apptab");
    if (b) show(b.dataset.view);
  });

  // Land on Pending Refunds unless the user was last somewhere else.
  let start = "pending";
  try {
    const saved = localStorage.getItem("montanello.view");
    if (saved && document.getElementById("view-" + saved)) start = saved;
  } catch { /* ignore */ }
  show(start);

  window.appShell = { show };
})();
