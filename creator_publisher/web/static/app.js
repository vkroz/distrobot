// Shared helpers for every page (window.CP).
(() => {
  // Server renders times in the viewer's time zone, read from this cookie.
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const current = document.cookie.match(/(?:^|;\s*)tz=([^;]*)/);
  if (tz && (!current || decodeURIComponent(current[1]) !== tz)) {
    document.cookie = `tz=${encodeURIComponent(tz)}; path=/; max-age=31536000; samesite=lax`;
    if (!sessionStorage.getItem("cp-tz-reloaded") && location.pathname !== "/login") {
      sessionStorage.setItem("cp-tz-reloaded", "1");
      location.reload();
    }
  }

  const NAMES = {
    youtube: "YouTube",
    tiktok: "TikTok",
    instagram: "Instagram Reels",
    x: "X",
    facebook: "Facebook",
    linkedin: "LinkedIn",
    vimeo: "Vimeo",
  };

  const CP = {
    platformName: (p) => NAMES[p] || p,
    esc: (s) =>
      String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]),
    jsonInit: (method, body) => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    /** fetch → { ok, status, data } (never throws). */
    async api(url, init = {}) {
      try {
        const res = await fetch(url, { cache: "no-store", ...init });
        const data = await res.json().catch(() => ({}));
        return { ok: res.ok, status: res.status, data };
      } catch (err) {
        return { ok: false, status: 0, data: { error: err.message || "Network error" } };
      }
    },
    fmtDateTime: (iso) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "—"),
    fmtBytes(bytes) {
      if (bytes === undefined || bytes === null) return "—";
      const units = ["B", "KB", "MB", "GB", "TB"];
      let v = bytes;
      let i = 0;
      while (v >= 1024 && i < units.length - 1) {
        v /= 1024;
        i++;
      }
      return `${v >= 10 || Number.isInteger(v) ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
    },
    fmtDuration(sec) {
      if (sec === undefined || sec === null) return "—";
      if (sec < 60) return `${Math.round(sec * 10) / 10}s`;
      const h = Math.floor(sec / 3600);
      const m = Math.floor((sec % 3600) / 60);
      const s = Math.round(sec % 60);
      return h ? `${h}h ${m}m` : `${m}m${s ? ` ${s}s` : ""}`;
    },
    /** `YYYY-MM-DDTHH:mm` in local time, for datetime-local inputs. */
    toLocalInput(d) {
      const pad = (n) => String(n).padStart(2, "0");
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    },
  };
  window.CP = CP;

  document.addEventListener("click", async (e) => {
    if (!e.target.closest("[data-logout]")) return;
    await fetch("/api/session", { method: "DELETE" }).catch(() => {});
    location.href = "/login";
  });
})();
