// Dashboard actions (event delegation, so live-refreshed markup keeps working).
(() => {
  const { api, fmtDateTime } = window.CP;

  const showNotice = (text) => {
    const el = document.getElementById("notice");
    if (!el) return;
    el.textContent = text;
    el.hidden = !text;
  };
  const reloadWith = (notice) => {
    if (notice) sessionStorage.setItem("cp-notice", notice);
    location.reload();
  };
  const pending = sessionStorage.getItem("cp-notice");
  if (pending) {
    sessionStorage.removeItem("cp-notice");
    showNotice(pending);
  }

  // Scroll to ?post=<id>.
  const hl = document.querySelector(".post-card.highlight");
  if (hl) hl.scrollIntoView({ behavior: "smooth", block: "center" });

  function showError(card, data, status) {
    const box = card.querySelector("[data-error]");
    const parts = [`<p class="bold">${CP.esc(data.error || `Request failed (${status})`)}</p>`];
    for (const v of (data.validation || []).filter((v) => !v.ok)) {
      parts.push(`<p><span class="bold">${CP.esc(CP.platformName(v.platform))}:</span> ${CP.esc(v.errors.map((e) => e.message).join(" "))}</p>`);
    }
    if (card.dataset.draft === "1" && data.validation) {
      parts.push(`<a class="bold underline" href="/compose?draft=${card.dataset.post}">Fix in editor →</a>`);
    }
    box.innerHTML = parts.join("");
    box.hidden = false;
  }

  async function postAction(card, btn, url, init, success) {
    btn.disabled = true;
    const { ok, status, data } = await api(url, init);
    btn.disabled = false;
    if (!ok) return showError(card, data, status);
    reloadWith(success);
  }

  document.addEventListener("click", async (e) => {
    const t = e.target.closest("button");
    if (!t) return;
    const card = t.closest("[data-post]");

    if (t.matches("[data-run-worker]")) {
      t.disabled = true;
      t.textContent = "Running…";
      const { ok, status, data } = await api("/api/jobs/run", { method: "POST" });
      const n = (data.processed || []).length;
      reloadWith(ok ? (n ? `Processed ${n} job${n > 1 ? "s" : ""}.` : "No jobs were due.") : data.error || `Worker run failed (${status})`);
      return;
    }
    if (t.matches("[data-retry]")) {
      t.disabled = true;
      t.textContent = "Retrying…";
      const { ok, status, data } = await api(`/api/jobs/${t.dataset.retry}/retry`, { method: "POST" });
      reloadWith(ok ? "" : data.error || `Retry failed (${status})`);
      return;
    }
    if (!card) return;
    const title = card.dataset.title;
    const id = card.dataset.post;

    if (t.matches("[data-publish]")) {
      t.textContent = "Publishing…";
      await postAction(card, t, `/api/posts/${id}/publish`, CP.jsonInit("POST", { scheduledAt: null }), `Publishing “${title}”…`);
      t.textContent = "Publish now";
    } else if (t.matches("[data-schedule-toggle]")) {
      const form = card.querySelector("[data-schedule-form]");
      form.hidden = !form.hidden;
    } else if (t.matches("[data-schedule-confirm]")) {
      const value = card.querySelector("[data-schedule-form] input").value;
      const when = value ? new Date(value) : null;
      if (!when || when.getTime() <= Date.now()) return showError(card, { error: "Pick a future time" }, 400);
      const iso = when.toISOString();
      await postAction(card, t, `/api/posts/${id}/publish`, CP.jsonInit("POST", { scheduledAt: iso }), `Scheduled “${title}” for ${fmtDateTime(iso)}.`);
    } else if (t.matches("[data-delete]")) {
      const draft = card.dataset.draft === "1";
      const msg = draft
        ? "Delete this draft? This can't be undone."
        : card.dataset.pending === "1"
          ? "Delete this post? Queued and scheduled jobs will be cancelled. Already-published videos stay on the platforms."
          : "Delete this post from the history? Already-published videos stay on the platforms.";
      if (!confirm(msg)) return;
      await postAction(card, t, `/api/posts/${id}`, { method: "DELETE" }, draft ? "Draft deleted." : "Post deleted.");
    }
  });

  // Live refresh: fast while jobs are in flight, slow while only scheduled/retrying jobs are pending.
  function schedule() {
    const body = document.getElementById("dash-body");
    if (!body) return;
    const ms = body.dataset.active === "1" ? 2000 : body.dataset.pending === "1" ? 15000 : 0;
    if (ms) setTimeout(refresh, ms);
  }
  async function refresh() {
    const body = document.getElementById("dash-body");
    const busy = body.contains(document.activeElement) && document.activeElement !== document.body;
    const formOpen = [...body.querySelectorAll("[data-schedule-form], [data-error]")].some((el) => !el.hidden);
    if (!busy && !formOpen) {
      try {
        const res = await fetch(location.href, { cache: "no-store" });
        if (res.ok && !res.redirected) {
          const doc = new DOMParser().parseFromString(await res.text(), "text/html");
          const next = doc.getElementById("dash-body");
          const notice = document.getElementById("notice");
          if (next) {
            const keep = notice && !notice.hidden ? notice.textContent : "";
            body.replaceWith(next);
            if (keep) showNotice(keep);
          }
        }
      } catch {
        /* offline: try again later */
      }
    }
    schedule();
  }
  schedule();
})();
