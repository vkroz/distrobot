// Compose page: form state, uploads, live (server-side) validation, per-platform panels, TikTok settings.
(() => {
  const boot = JSON.parse(document.getElementById("boot").textContent);
  const { rules, statuses, meta, platformIds } = boot;
  const { esc, api } = CP;
  const $ = (id) => document.getElementById(id);

  const VIS_HINT = {
    public: "Everyone can see it",
    unlisted: "Anyone with the link (falls back to private where unsupported)",
    private: "Only you",
  };
  const PRIVACY_LABELS = boot.tiktok.privacyLabels;
  const LINKS = boot.tiktok.links;

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  const state = {
    draftId: boot.draft?.id ?? null,
    title: "",
    caption: "",
    hashtags: [],
    visibility: "public",
    scheduleEnabled: false,
    scheduleLocal: "",
    selected: ["youtube", "tiktok", "instagram"],
    /** platform → {title, caption, hashtags} (null = inherit) */
    overrides: {},
    /** platform → settings (TikTok posting UX) */
    settings: {},
    video: null,
    thumb: null,
    /** TikTok creator info: {status: loading|ok|error, ...} */
    creator: null,
    /** platform → server validation result */
    results: {},
    submitting: null,
  };
  const override = (p) => state.overrides[p] || { title: null, caption: null, hashtags: null };
  const base = () => ({ title: state.title, caption: state.caption, hashtags: state.hashtags });
  const current = (p) => {
    const o = override(p);
    return { title: o.title ?? state.title, caption: o.caption ?? state.caption, hashtags: o.hashtags ?? state.hashtags };
  };
  const scheduledAt = () => (state.scheduleEnabled && state.scheduleLocal ? new Date(state.scheduleLocal).toISOString() : null);
  const info = () => state.video?.info;
  const count = (s) => [...s].length;

  const normalizeHashtags = (tags) => {
    const seen = new Set();
    const out = [];
    for (const raw of tags) {
      const tag = String(raw).trim().replace(/^#+/, "").replace(/\s+/g, "");
      if (!tag || seen.has(tag.toLowerCase())) continue;
      seen.add(tag.toLowerCase());
      out.push(tag);
    }
    return out;
  };
  const sameTags = (a, b) => a.length === b.length && a.every((t, i) => t === b[i]);

  // ---------------------------------------------------------------------------
  // Small render helpers
  // ---------------------------------------------------------------------------
  const badge = (text, tone = "neutral") => `<span class="badge tone-${tone}">${esc(text)}</span>`;
  const picon = (p, size = "md") => `<span aria-hidden="true" class="picon picon-${size} ${meta[p].cls}">${esc(meta[p].short)}</span>`;
  function statusBadge(p) {
    const s = statuses[p];
    if (!s) return badge("…");
    if (s.dryRun) return badge("Dry-run", "amber");
    if (s.accounts.length) return badge(s.accounts[0].displayName, "green");
    return `<a href="/accounts">${badge("Not connected", "red")}</a>`;
  }

  /** Chip input for hashtags. Enter, comma or space commits; Backspace on empty removes the last. */
  function hashtagInput(el, { get, set, max, recommendedMax }) {
    el.classList.add("chip-input");
    const render = () => {
      const value = get();
      const over = max !== undefined && max !== null && value.length > max;
      const soft = !over && recommendedMax && value.length > recommendedMax;
      el.classList.toggle("over", over);
      el.innerHTML =
        value
          .map(
            (t, i) =>
              `<span class="chip${max !== undefined && max !== null && i >= max ? " chip-over" : ""}">#${esc(t)}<button type="button" aria-label="Remove ${esc(t)}" data-i="${i}">×</button></span>`,
          )
          .join("") +
        `<input placeholder="${value.length ? "" : "Add hashtag…"}">` +
        (over || soft ? `<span class="chip-count ${over ? "text-red" : "text-amber"}">${value.length}/${over ? max : recommendedMax}</span>` : "");
      const input = el.querySelector("input");
      const commit = (text) => {
        const parts = text.split(/[\s,]+/).filter(Boolean);
        if (parts.length) set(normalizeHashtags([...get(), ...parts]));
        input.value = "";
      };
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === "," || e.key === " ") {
          e.preventDefault();
          commit(input.value);
          render();
          el.querySelector("input").focus();
        } else if (e.key === "Backspace" && !input.value && get().length) {
          set(get().slice(0, -1));
          render();
          el.querySelector("input").focus();
        }
      });
      input.addEventListener("blur", () => {
        if (input.value) {
          commit(input.value);
          render();
        }
      });
      input.addEventListener("paste", (e) => {
        const text = e.clipboardData.getData("text");
        if (/[\s,]/.test(text)) {
          e.preventDefault();
          commit(input.value + text);
          render();
        }
      });
    };
    el.addEventListener("click", (e) => {
      const b = e.target.closest("button[data-i]");
      if (b) {
        const v = get().slice();
        v.splice(Number(b.dataset.i), 1);
        set(v);
        render();
      } else if (e.target === el) el.querySelector("input").focus();
    });
    render();
    return { render };
  }

  // ---------------------------------------------------------------------------
  // Uploads
  // ---------------------------------------------------------------------------
  function probeLocalVideo(file, url) {
    return new Promise((resolve) => {
      const baseInfo = { mimeType: file.type || undefined, sizeBytes: file.size };
      const v = document.createElement("video");
      v.preload = "metadata";
      v.muted = true;
      const done = (i) => {
        clearTimeout(timer);
        v.removeAttribute("src");
        v.load();
        resolve(i);
      };
      // Some codecs (e.g. HEVC in some browsers) can't be decoded: fall back to size/type only.
      const timer = setTimeout(() => done(baseInfo), 10000);
      v.onloadedmetadata = () =>
        done({
          ...baseInfo,
          durationSec: Number.isFinite(v.duration) ? Math.round(v.duration * 100) / 100 : undefined,
          width: v.videoWidth || undefined,
          height: v.videoHeight || undefined,
        });
      v.onerror = () => done(baseInfo);
      v.src = url;
    });
  }
  function probeLocalImage(url) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
      img.onerror = () => resolve({});
      img.src = url;
    });
  }
  /** Prefer the server's (ffprobe) values; keep browser values for anything the server didn't measure. */
  function mergeServerInfo(local, media) {
    const merged = {
      mimeType: media.mimeType ?? local.mimeType,
      sizeBytes: media.sizeBytes ?? local.sizeBytes,
      durationSec: media.durationSec ?? local.durationSec,
      width: media.width ?? local.width,
      height: media.height ?? local.height,
    };
    const source = media.metadataSource === "ffprobe" ? "ffprobe" : merged.durationSec || merged.width ? "browser" : null;
    return { info: merged, source };
  }
  const fromMedia = (media) => {
    if (!media) return null;
    const { info: i, source } = mergeServerInfo({}, media);
    return { file: null, name: media.originalFilename, objectUrl: `/api/media/${media.id}`, info: i, source, status: "done", progress: 1, media };
  };

  function clearUpload(kind) {
    const u = state[kind];
    if (u?.xhr) u.xhr.abort();
    if (u?.objectUrl?.startsWith("blob:")) URL.revokeObjectURL(u.objectUrl);
    state[kind] = null;
  }

  async function selectFile(kind, file) {
    clearUpload(kind);
    const objectUrl = URL.createObjectURL(file);
    const u = { file, name: file.name, objectUrl, info: { mimeType: file.type || undefined, sizeBytes: file.size }, source: null, status: "probing", progress: 0, media: null };
    state[kind] = u;
    renderUploads();
    const probed = kind === "video" ? await probeLocalVideo(file, objectUrl) : { ...u.info, ...(await probeLocalImage(objectUrl)) };
    if (state[kind] !== u) return;
    u.info = probed;
    u.source = probed.durationSec || probed.width ? "browser" : null;
    u.status = "uploading";
    renderUploads();
    changed();

    const params = new URLSearchParams({ filename: file.name });
    if (probed.durationSec) params.set("durationSec", String(probed.durationSec));
    if (probed.width) params.set("width", String(probed.width));
    if (probed.height) params.set("height", String(probed.height));
    const xhr = new XMLHttpRequest();
    u.xhr = xhr;
    xhr.open("POST", `/api/media?${params}`);
    xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && state[kind] === u) {
        u.progress = e.loaded / e.total;
        renderProgress(kind);
      }
    };
    const fail = (msg) => {
      if (state[kind] !== u) return;
      u.status = "error";
      u.error = msg;
      u.xhr = null;
      renderUploads();
      renderReady();
    };
    xhr.onload = () => {
      let body = {};
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        /* non-JSON error page */
      }
      if (state[kind] !== u) return;
      if (xhr.status >= 200 && xhr.status < 300 && body.media) {
        const merged = kind === "video" ? mergeServerInfo(u.info, body.media) : { info: u.info, source: u.source };
        Object.assign(u, merged, { media: body.media, status: "done", progress: 1, xhr: null });
        renderUploads();
        changed();
      } else fail(body.error ?? `Upload failed (${xhr.status})`);
    };
    xhr.onerror = () => fail("Network error during upload");
    xhr.onabort = () => fail("Upload cancelled");
    xhr.send(file);
  }

  function progressHtml(u) {
    if (u.status === "done") return `<span class="xs bold text-green">Uploaded</span>`;
    if (u.status === "error") return `<span class="xs bold text-red">${esc(u.error)}</span>`;
    const pct = Math.round(u.progress * 100);
    return `<span class="row gap-sm"><span class="bar"><span style="width:${pct}%"></span></span><span class="xs muted tabular">${u.status === "probing" ? "Reading…" : `${pct}%`}</span></span>`;
  }
  function renderProgress(kind) {
    const el = document.querySelector(`[data-progress="${kind}"]`);
    if (el && state[kind]) el.innerHTML = progressHtml(state[kind]);
  }
  function sourceHtml(u) {
    if (u.status === "probing") return "";
    if (u.source === "ffprobe") return `<p class="xxs text-green" title="Duration and dimensions were measured on the server with ffprobe">✓ Measured on server (ffprobe)</p>`;
    if (u.status === "uploading") return `<p class="xxs muted">From browser · server will re-measure after upload</p>`;
    if (u.source === "browser") return `<p class="xxs text-amber">From browser (server measurement unavailable)</p>`;
    return `<p class="xxs text-amber">Duration/dimensions unknown — aspect and length checks are skipped</p>`;
  }
  const orientation = (w, h) => (w / h < 0.8 ? "vertical" : w / h > 1.25 ? "horizontal" : "square");

  function dropZone(el, accept, inner, onFile) {
    el.innerHTML = `<button type="button" class="dropzone">${inner}<input type="file" accept="${accept}" hidden></button>`;
    const btn = el.querySelector(".dropzone");
    const input = el.querySelector("input");
    btn.addEventListener("click", () => input.click());
    input.addEventListener("change", () => input.files[0] && onFile(input.files[0]));
    btn.addEventListener("dragover", (e) => {
      e.preventDefault();
      btn.classList.add("over");
    });
    btn.addEventListener("dragleave", () => btn.classList.remove("over"));
    btn.addEventListener("drop", (e) => {
      e.preventDefault();
      btn.classList.remove("over");
      if (e.dataTransfer.files[0]) onFile(e.dataTransfer.files[0]);
    });
  }

  function renderUploads() {
    const v = state.video;
    const vp = $("video-picker");
    if (!v) {
      dropZone(
        vp,
        "video/*",
        `<span class="emoji">🎬</span><span class="small bold">Drop a video or click to browse</span><span class="xs muted">MP4 (H.264/AAC) works everywhere. Duration and size are detected locally.</span>`,
        (f) => selectFile("video", f),
      );
      vp.querySelector(".dropzone").classList.add("tall");
    } else {
      const i = v.info;
      const o = i.width && i.height ? orientation(i.width, i.height) : null;
      vp.innerHTML = `<div class="video-row">
        <div class="video-box"><video src="${esc(v.objectUrl)}" controls muted playsinline></video></div>
        <div class="grow min0 stack-sm">
          <p class="small bold truncate" title="${esc(v.name)}">${esc(v.name)}</p>
          <dl class="kv xs">
            <dt>Duration</dt><dd>${CP.fmtDuration(i.durationSec)}</dd>
            <dt>Resolution</dt><dd>${i.width && i.height ? `${i.width}×${i.height}` : "unknown"}${o ? ` <span class="muted">(${o})</span>` : ""}</dd>
            <dt>Size</dt><dd>${CP.fmtBytes(i.sizeBytes)}</dd>
            <dt>Type</dt><dd>${esc(i.mimeType ?? "unknown")}</dd>
          </dl>
          ${sourceHtml(v)}
          <div data-progress="video">${progressHtml(v)}</div>
          <div class="row gap-sm">
            <label class="xs bold text-violet link">Replace<input type="file" accept="video/*" hidden data-replace></label>
            <button type="button" class="xs bold muted link" data-remove>Remove</button>
          </div>
        </div></div>`;
      vp.querySelector("[data-replace]").addEventListener("change", (e) => e.target.files[0] && selectFile("video", e.target.files[0]));
      vp.querySelector("[data-remove]").addEventListener("click", () => {
        clearUpload("video");
        renderUploads();
        changed();
      });
    }

    const t = state.thumb;
    const tp = $("thumb-picker");
    if (!t) {
      dropZone(
        tp,
        "image/jpeg,image/png,image/webp",
        `<span class="emoji-sm">🖼️</span><span class="xs bold">Custom thumbnail</span><span class="xxs muted">JPG/PNG, 1280×720, ≤ 2 MB for YouTube</span>`,
        (f) => selectFile("thumb", f),
      );
      tp.querySelector(".dropzone").classList.add("aspect-video");
    } else {
      tp.innerHTML = `<div class="stack-sm">
        <div class="thumb-box"><img src="${esc(t.objectUrl)}" alt="Thumbnail preview"><button type="button" class="thumb-x" aria-label="Remove thumbnail" data-remove>×</button></div>
        <div class="row between gap-sm"><span class="xs muted">${t.info.width && t.info.height ? `${t.info.width}×${t.info.height} · ` : ""}${CP.fmtBytes(t.info.sizeBytes)}</span><span data-progress="thumb">${progressHtml(t)}</span></div>
        ${(t.info.sizeBytes ?? 0) > 2 * 1024 * 1024 ? `<p class="xs text-amber">Over 2 MB — YouTube will reject this thumbnail.</p>` : ""}
      </div>`;
      tp.querySelector("[data-remove]").addEventListener("click", () => {
        clearUpload("thumb");
        renderUploads();
        changed();
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Live validation (server-side engine, same as publish-time checks)
  // ---------------------------------------------------------------------------
  let validateTimer = null;
  let validateSeq = 0;
  function changed() {
    renderBasics();
    renderReady();
    clearTimeout(validateTimer);
    validateTimer = setTimeout(validate, 150);
  }

  async function validate() {
    const seq = ++validateSeq;
    if (!state.selected.length) {
      state.results = {};
      renderAll();
      return;
    }
    const body = {
      content: base(),
      media: info() ?? null,
      targets: state.selected.map((platform) => {
        const o = override(platform);
        return { platform, titleOverride: o.title, captionOverride: o.caption, hashtagsOverride: o.hashtags, settings: state.settings[platform] ?? {} };
      }),
      tiktokCreator: state.creator?.status === "ok" ? state.creator.creator : null,
    };
    const { ok, data } = await api("/api/validate", CP.jsonInit("POST", body));
    if (seq !== validateSeq || !ok) return;
    state.results = Object.fromEntries(data.results.map((r) => [r.platform, r]));
    renderAll();
  }

  // ---------------------------------------------------------------------------
  // TikTok creator info + settings card
  // ---------------------------------------------------------------------------
  async function loadCreator() {
    if (state.creator?.status === "ok" || state.creator?.status === "loading") return;
    state.creator = { status: "loading" };
    renderTikTok();
    const { ok, status, data } = await api("/api/tiktok/creator-info");
    state.creator =
      !ok || !data.creator
        ? { status: "error", error: data.error ?? `Couldn't load TikTok creator info (${status})` }
        : { status: "ok", source: data.source, reason: data.reason, accountName: data.account?.displayName, creator: data.creator };
    renderTikTok();
    changed();
  }

  const tiktokSettings = () => {
    const s = state.settings.tiktok ?? {};
    const c = s.commercial ?? {};
    return {
      privacyLevel: s.privacyLevel ?? null,
      allowComment: s.allowComment === true,
      allowDuet: s.allowDuet === true,
      allowStitch: s.allowStitch === true,
      commercial: { enabled: c.enabled === true, yourBrand: c.yourBrand === true, brandedContent: c.brandedContent === true },
    };
  };
  const setTikTok = (patch) => {
    state.settings.tiktok = { ...tiktokSettings(), ...patch };
    renderTikTok();
    changed();
  };
  function consentHtml(s) {
    const branded = s.commercial.enabled && s.commercial.brandedContent;
    const music = `<a href="${LINKS.musicUsage}" target="_blank" rel="noreferrer" class="underline">Music Usage Confirmation</a>`;
    return branded
      ? `By posting, you agree to TikTok's <a href="${LINKS.brandedContentPolicy}" target="_blank" rel="noreferrer" class="underline">Branded Content Policy</a> and ${music}.`
      : `By posting, you agree to TikTok's ${music}.`;
  }

  function renderTikTok() {
    const card = $("tiktok-card");
    const on = state.selected.includes("tiktok");
    card.hidden = !on;
    $("tiktok-consent").hidden = !on;
    if (!on) return;
    const s = tiktokSettings();
    const c = s.commercial;
    const cs = state.creator;
    const creator = cs?.status === "ok" ? cs.creator : null;
    const dur = info()?.durationSec;
    const label = c.enabled ? (c.brandedContent ? "Paid partnership" : c.yourBrand ? "Promotional content" : null) : null;
    const brandedConflict = c.enabled && c.brandedContent;
    const issues = (state.results.tiktok?.errors ?? []).filter((e) => e.field === "settings");

    let creatorHtml;
    if (!cs || cs.status === "loading") creatorHtml = `<p class="small muted">Loading TikTok creator info…</p>`;
    else if (cs.status === "error")
      creatorHtml = `<div class="small text-red"><p class="bold">TikTok is unavailable right now</p><p class="xs">${esc(cs.error)}</p>
        <p class="xs">Publishing to TikTok is disabled until creator info loads.</p><button type="button" class="btn-small mt-xs" data-tt="retry">Retry</button></div>`;
    else {
      const max = creator.maxVideoPostDurationSec;
      creatorHtml = `<div class="row gap">
        ${creator.avatarUrl ? `<img src="${esc(creator.avatarUrl)}" alt="" class="avatar">` : `<span class="avatar avatar-ph">${esc(creator.nickname.slice(0, 1).toUpperCase())}</span>`}
        <div class="grow min0"><p class="small bold truncate">Posting to ${esc(creator.nickname)}${creator.username ? ` <span class="muted normal">@${esc(creator.username)}</span>` : ""}</p>
          <p class="xs muted">${max ? `Max video length ${CP.fmtDuration(max)}` : "Max length unknown"}${dur !== undefined && max && dur > max ? `<span class="text-red"> · your video is ${CP.fmtDuration(dur)}</span>` : ""}</p></div>
        ${cs.source === "mock" ? `<span title="${esc(cs.reason)}">${badge("mock", "amber")}</span>` : ""}
      </div>${cs.source === "mock" && cs.reason ? `<p class="xxs text-amber mt-xs">Mock creator info: ${esc(cs.reason)}.</p>` : ""}`;
    }
    const options = creator?.privacyLevelOptions ?? [];
    const toggle = (key, text, disabledFlag, title) => {
      const disabled = !creator || (creator && creator[disabledFlag]);
      return `<label class="row gap-xs small ${disabled ? "faint" : "pointer"}" ${disabled && creator ? `title="${title}"` : ""}>
        <input type="checkbox" class="accent" data-tt="${key}" ${s[key] && !disabled ? "checked" : ""} ${disabled ? "disabled" : ""}>${text}</label>`;
    };
    card.innerHTML = `<div class="card pad stack-lg">
      <div class="row gap">${picon("tiktok")}<div><h2 class="h2">TikTok posting settings</h2><p class="xs muted">Required by TikTok before posting. Nothing is pre-selected.</p></div></div>
      <div class="soft-box">${creatorHtml}</div>
      <div class="field">
        <label for="tt-privacy" class="label">Who can view this video <span class="text-red">*</span></label>
        <select id="tt-privacy" class="input${s.privacyLevel ? "" : " faint"}" data-tt="privacy" ${creator ? "" : "disabled"}>
          <option value="" disabled ${s.privacyLevel ? "" : "selected"}>Select…</option>
          ${options
            .map((o) => {
              const blocked = o === "SELF_ONLY" && brandedConflict;
              return `<option value="${o}" ${blocked ? "disabled" : ""} ${s.privacyLevel === o ? "selected" : ""}>${esc(PRIVACY_LABELS[o])}${blocked ? " — not available for branded content" : ""}</option>`;
            })
            .join("")}
        </select>
        ${brandedConflict ? `<p class="xs muted">Branded content can't be private, so “Only me” is unavailable.</p>` : ""}
      </div>
      <div class="stack-sm"><p class="small bold">Allow users to</p><div class="row wrap gap-lg">
        ${toggle("allowComment", "Comment", "commentDisabled", "Comments are turned off in this creator's TikTok privacy settings")}
        ${toggle("allowDuet", "Duet", "duetDisabled", "Duet is turned off in this creator's TikTok privacy settings")}
        ${toggle("allowStitch", "Stitch", "stitchDisabled", "Stitch is turned off in this creator's TikTok privacy settings")}
      </div></div>
      <div class="stack-sm divider-top">
        <div class="row between gap"><div><p class="small bold">Disclose video content</p><p class="xs muted">Turn on if this video promotes yourself, a brand, product or service.</p></div>
          <button type="button" role="switch" aria-checked="${c.enabled}" class="switch${c.enabled ? " on" : ""}" data-tt="commercial" ${creator ? "" : "disabled"}><span></span></button></div>
        ${
          c.enabled
            ? `<div class="soft-box stack-sm">
          <label class="row gap-sm small pointer top"><input type="checkbox" class="accent" data-tt="yourBrand" ${c.yourBrand ? "checked" : ""}><span><span class="bold">Your brand</span><span class="block xs muted">You are promoting yourself or your own business.</span></span></label>
          <label class="row gap-sm small pointer top"><input type="checkbox" class="accent" data-tt="brandedContent" ${c.brandedContent ? "checked" : ""}><span><span class="bold">Branded content</span><span class="block xs muted">You are promoting another brand or a third party.</span></span></label>
          ${label ? `<p class="xs text-violet">Your video will be labeled “${label}”.</p>` : `<p class="xs text-amber">You need to indicate if your content promotes yourself, a third party, or both.</p>`}
        </div>`
            : ""
        }
      </div>
      ${issues.length ? `<ul class="stack-xs">${issues.map((i) => `<li class="xs text-red">✕ ${esc(i.message)}</li>`).join("")}</ul>` : ""}
      <p class="xs muted">${consentHtml(s)}</p>
    </div>`;
    $("tiktok-consent").innerHTML = consentHtml(s);
  }

  $("tiktok-card").addEventListener("change", (e) => {
    const key = e.target.dataset.tt;
    const s = tiktokSettings();
    if (key === "privacy") setTikTok({ privacyLevel: e.target.value || null });
    else if (["allowComment", "allowDuet", "allowStitch"].includes(key)) setTikTok({ [key]: e.target.checked });
    else if (key === "yourBrand") setTikTok({ commercial: { ...s.commercial, yourBrand: e.target.checked } });
    else if (key === "brandedContent") {
      // Branded content can't be private: clear an "Only me" choice instead of silently keeping it.
      const checked = e.target.checked;
      setTikTok({
        commercial: { ...s.commercial, brandedContent: checked },
        ...(checked && s.privacyLevel === "SELF_ONLY" ? { privacyLevel: null } : {}),
      });
    }
  });
  $("tiktok-card").addEventListener("click", (e) => {
    const key = e.target.closest("button")?.dataset.tt;
    const s = tiktokSettings();
    if (key === "commercial") {
      const enabled = !s.commercial.enabled;
      setTikTok({ commercial: enabled ? { ...s.commercial, enabled } : { enabled: false, yourBrand: false, brandedContent: false } });
    } else if (key === "retry") {
      state.creator = null;
      loadCreator();
    }
  });

  // ---------------------------------------------------------------------------
  // Platform list + panels
  // ---------------------------------------------------------------------------
  function resultBadge(r) {
    if (!r) return "";
    if (r.errors.length) return badge(String(r.errors.length), "red");
    if (r.warnings.length) return badge(String(r.warnings.length), "amber");
    return badge("✓", "green");
  }

  function renderPlatformList() {
    $("platform-list").innerHTML = platformIds
      .map((p) => {
        const on = state.selected.includes(p);
        return `<button type="button" class="pf-toggle${on ? " on" : ""}" aria-pressed="${on}" data-platform="${p}">
          ${picon(p)}<span class="grow min0"><span class="block small bold">${esc(rules[p].displayName)}</span><span class="block mt-xxs">${statusBadge(p)}</span></span>
          ${on ? resultBadge(state.results[p]) : ""}<span class="check">${on ? "✓" : ""}</span></button>`;
      })
      .join("");
  }
  $("platform-list").addEventListener("click", (e) => {
    if (e.target.closest("a")) return;
    const b = e.target.closest("[data-platform]");
    if (!b) return;
    const p = b.dataset.platform;
    state.selected = state.selected.includes(p) ? state.selected.filter((x) => x !== p) : platformIds.filter((x) => x === p || state.selected.includes(x));
    if (state.selected.includes("tiktok")) loadCreator();
    syncPanels();
    renderTikTok();
    changed();
  });

  const SEVERITY = { error: ["✕", "text-red"], warning: ["!", "text-amber"], info: ["i", "muted"] };

  function frameRatio(r, result) {
    if (result.shortForm) return 9 / 16;
    const pref = r.video.preferredOrientation;
    if (pref === "vertical") return 9 / 16;
    if (pref === "horizontal") return 16 / 9;
    const i = info();
    if (i?.width && i.height) return Math.min(Math.max(i.width / i.height, r.video.minAspectRatio ?? 0), r.video.maxAspectRatio ?? Infinity);
    const [w, h] = (r.video.recommendedAspectRatios[0] ?? "16:9").split(":").map(Number);
    return w / h;
  }

  /** Create panels for newly selected platforms, remove deselected ones, keep order. */
  function syncPanels() {
    const host = $("panels");
    for (const el of [...host.children]) if (!state.selected.includes(el.dataset.panel)) el.remove();
    for (const p of state.selected) {
      let el = host.querySelector(`[data-panel="${p}"]`);
      if (!el) el = createPanel(p);
      host.appendChild(el); // re-append keeps platform order
    }
    $("previews").hidden = state.selected.length === 0;
  }

  function createPanel(p) {
    const r = rules[p];
    const el = document.createElement("div");
    el.className = "panel";
    el.dataset.panel = p;
    el.innerHTML = `<div class="panel-head">${picon(p)}<div class="grow min0"><div class="row gap-sm"><span class="truncate bold">${esc(r.displayName)}</span><span data-custom></span></div>
        <div class="mt-xxs">${statusBadge(p)}</div></div><span data-state>${badge("…")}</span></div>
      <div class="panel-body stack">
        <div data-frame></div>
        <div data-text class="stack-xs small"></div>
        <div data-issues></div>
        <div data-fixes></div>
        <div><p class="eyebrow">Requirements</p><dl data-reqs class="reqs xs"></dl></div>
        <div class="divider-top">
          <button type="button" class="row between w-full small bold" data-edit-toggle><span>Customize for ${esc(r.displayName)}</span><span class="faint" data-caret>▾</span></button>
          <div class="stack mt" data-editor hidden>
            ${r.title.supported ? overrideField("title", r.title.label, `<input class="input" data-o="title">`) : ""}
            ${overrideField("caption", r.caption.label, `<textarea class="input textarea-sm" data-o="caption"></textarea>`)}
            ${overrideField("hashtags", r.hashtags.placement === "tags" ? "Tags" : "Hashtags", `<div data-o-tags></div>`)}
          </div>
        </div>
      </div>`;
    el.querySelector("[data-edit-toggle]").addEventListener("click", () => {
      const ed = el.querySelector("[data-editor]");
      ed.hidden = !ed.hidden;
      el.querySelector("[data-caret]").textContent = ed.hidden ? "▾" : "▴";
    });
    for (const input of el.querySelectorAll("[data-o]")) {
      input.addEventListener("input", () => {
        state.overrides[p] = { ...override(p), [input.dataset.o]: input.value };
        syncOverrideBadges(p);
        changed();
      });
    }
    el.addEventListener("click", (e) => {
      const reset = e.target.closest("[data-reset]");
      if (reset) {
        state.overrides[p] = { ...override(p), [reset.dataset.reset]: null };
        syncEditor(p, true);
        changed();
      }
      const fix = e.target.closest("[data-fix]");
      if (fix) applyFixes(p, fix.dataset.fix === "all" ? null : Number(fix.dataset.fix));
    });
    el._tags = hashtagInput(el.querySelector("[data-o-tags]"), {
      get: () => current(p).hashtags,
      set: (tags) => {
        state.overrides[p] = { ...override(p), hashtags: tags };
        syncOverrideBadges(p);
        changed();
      },
      max: r.hashtags.max ?? undefined,
      recommendedMax: r.hashtags.recommendedMax ?? undefined,
    });
    // Panels render before the first validation result arrives.
    setTimeout(() => syncEditor(p, true));
    return el;
  }

  function overrideField(key, label, control) {
    return `<div class="stack-xs"><div class="row between"><span class="xs bold">${esc(label)}</span><span data-ob="${key}"></span></div>${control}</div>`;
  }

  function syncOverrideBadges(p) {
    const el = document.querySelector(`[data-panel="${p}"]`);
    if (!el) return;
    const o = override(p);
    for (const b of el.querySelectorAll("[data-ob]")) {
      const custom = o[b.dataset.ob] !== null && o[b.dataset.ob] !== undefined;
      b.innerHTML = custom ? `${badge("custom", "violet")} <button type="button" class="btn-ghost" data-reset="${b.dataset.ob}">Reset</button>` : badge("inherited");
    }
    const n = ["title", "caption", "hashtags"].filter((k) => o[k] !== null && o[k] !== undefined).length;
    el.querySelector("[data-custom]").innerHTML = n ? badge(`${n} custom`, "violet") : "";
  }

  /** Show current (override ?? base) values in the editor; skips the focused field unless forced. */
  function syncEditor(p, force = false) {
    const el = document.querySelector(`[data-panel="${p}"]`);
    if (!el) return;
    const c = current(p);
    for (const input of el.querySelectorAll("[data-o]")) {
      if (force || document.activeElement !== input) input.value = c[input.dataset.o];
    }
    if (force || !el.querySelector("[data-o-tags]").contains(document.activeElement)) el._tags.render();
    syncOverrideBadges(p);
  }

  /** Apply automatic (text-only) adaptations, stored as per-platform overrides relative to the post. */
  function applyFixes(p, index) {
    const result = state.results[p];
    if (!result) return;
    const auto = result.adaptations.filter((a) => a.automatic);
    const list = index === null ? auto : [auto[index]];
    let next = { ...current(p), hashtags: [...current(p).hashtags] };
    for (const a of list) {
      if (a.type === "truncate_title" || a.type === "derive_title") next.title = a.title;
      else if (a.type === "strip_forbidden_chars") next = a.field === "title" ? { ...next, title: a.value } : { ...next, caption: a.value };
      else if (a.type === "trim_hashtags" || a.type === "truncate_caption") next = { ...next, caption: a.caption, hashtags: a.hashtags };
    }
    const b = base();
    state.overrides[p] = {
      title: next.title === b.title ? null : next.title,
      caption: next.caption === b.caption ? null : next.caption,
      hashtags: sameTags(next.hashtags, b.hashtags) ? null : next.hashtags,
    };
    syncEditor(p, true);
    changed();
  }

  function renderPanel(p) {
    const el = document.querySelector(`[data-panel="${p}"]`);
    const result = state.results[p];
    if (!el || !result) return;
    const r = rules[p];
    const eff = result.effective;
    const st = el.querySelector("[data-state]");
    st.innerHTML = result.errors.length
      ? badge(`${result.errors.length} error${result.errors.length > 1 ? "s" : ""}`, "red")
      : result.warnings.length
        ? badge(`${result.warnings.length} warning${result.warnings.length > 1 ? "s" : ""}`, "amber")
        : badge("Ready", "green");
    el.classList.toggle("has-errors", result.errors.length > 0);

    // Preview frame: only rebuild when what it shows changes (avoids reloading the <video>).
    const ratio = frameRatio(r, result);
    const thumbOk = statuses[p]?.capabilities.thumbnail;
    const videoUrl = state.video?.objectUrl;
    const thumbUrl = thumbOk ? state.thumb?.objectUrl : null;
    const label = result.shortForm ? r.shortForm?.name : r.video.recommendedAspectRatios.join(" · ");
    const key = [ratio, videoUrl, thumbUrl, label].join("|");
    const frame = el.querySelector("[data-frame]");
    if (frame.dataset.key !== key) {
      frame.dataset.key = key;
      const size = ratio < 1 ? `height:220px;aspect-ratio:${ratio}` : `width:100%;aspect-ratio:${ratio};max-height:220px`;
      frame.innerHTML = `<div class="frame-wrap"><div class="frame" style="${size}">
        ${videoUrl ? `<video src="${esc(videoUrl)}#t=0.1" ${thumbUrl ? `poster="${esc(thumbUrl)}"` : ""} muted playsinline preload="metadata"></video>` : `<div class="frame-empty">${esc(r.video.recommendedAspectRatios[0] ?? "")}</div>`}
        <span class="frame-label">${esc(label ?? "")}</span></div></div>`;
    }

    const long = eff.caption.split("\n").length > 4 || eff.caption.length > 200;
    const sched = scheduledAt();
    el.querySelector("[data-text]").innerHTML = `
      ${eff.title !== null ? `<p class="bold clamp-2">${eff.title ? esc(eff.title) : `<span class="faint">No title</span>`}</p>` : ""}
      ${eff.caption ? `<p class="pre xs clamp-4" data-cap>${esc(eff.caption)}</p>` : `<p class="xs faint">No ${esc(r.caption.label.toLowerCase())}</p>`}
      ${long ? `<button type="button" class="xxs bold muted link" data-more>Show more</button>` : ""}
      ${eff.tags.length ? `<div class="chips">${eff.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join("")}</div>` : ""}
      <p class="xxs muted capitalize">${state.visibility}${sched ? ` · goes live ${CP.fmtDateTime(sched)}` : ""}</p>`;
    el.querySelector("[data-more]")?.addEventListener("click", (e) => {
      const cap = el.querySelector("[data-cap]");
      cap.classList.toggle("clamp-4");
      e.target.textContent = cap.classList.contains("clamp-4") ? "Show more" : "Show less";
    });

    const issues = [...result.errors, ...result.warnings, ...result.infos];
    el.querySelector("[data-issues]").innerHTML = issues.length
      ? `<ul class="stack-xs">${issues
          .map((i) => `<li class="issue xs ${SEVERITY[i.severity][1]}"><span class="issue-icon">${SEVERITY[i.severity][0]}</span><span>${esc(i.message)}</span></li>`)
          .join("")}</ul>`
      : `<p class="xs text-green">✓ Meets all requirements</p>`;

    const auto = result.adaptations.filter((a) => a.automatic);
    const manual = result.adaptations.filter((a) => !a.automatic);
    el.querySelector("[data-fixes]").innerHTML = result.adaptations.length
      ? `<div class="soft-box stack-sm"><div class="row between"><span class="eyebrow">Suggested fixes</span>${auto.length > 1 ? `<button type="button" class="btn-small" data-fix="all">Apply all</button>` : ""}</div>
        <ul class="stack-sm">${auto.map((a, i) => `<li class="row between gap-sm xs"><span>${esc(a.description)}</span><button type="button" class="btn-small" data-fix="${i}">Apply</button></li>`).join("")}
        ${manual.map((a) => `<li class="row between gap-sm xs muted"><span>${esc(a.description)}</span><span class="xxs italic nowrap">needs video processing</span></li>`).join("")}</ul></div>`
      : "";

    el.querySelector("[data-reqs]").innerHTML = (result.requirements ?? [])
      .map((row) => `<div class="req"><dt class="muted">${esc(row.label)}</dt><dd class="lvl-${row.level} tabular">${esc(row.value)}</dd></div>`)
      .join("");
    syncEditor(p);
  }

  // ---------------------------------------------------------------------------
  // Basics, readiness, submit
  // ---------------------------------------------------------------------------
  function renderBasics() {
    const strictest = state.selected
      .map((p) => rules[p].title)
      .filter((t) => t.supported && t.maxLength)
      .reduce((min, t) => (min === null || t.maxLength < min ? t.maxLength : min), null);
    const tc = $("title-count");
    tc.textContent = strictest !== null ? `${count(state.title)} / ${strictest}` : "";
    tc.classList.toggle("text-red", strictest !== null && count(state.title) > strictest);
    $("caption-count").textContent = `${count(state.caption).toLocaleString()} chars`;
    for (const b of document.querySelectorAll("[data-vis]")) b.classList.toggle("on", b.dataset.vis === state.visibility);
    $("visibility-hint").textContent = VIS_HINT[state.visibility];
    const at = $("schedule-at");
    at.disabled = !state.scheduleEnabled;
    at.min = CP.toLocalInput(new Date());
    at.classList.toggle("invalid", scheduleInvalid());
    $("schedule-hint").textContent = state.scheduleEnabled
      ? `Your time zone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`
      : "Publishes as soon as you hit Publish.";
  }

  const scheduleInvalid = () => state.scheduleEnabled && (!state.scheduleLocal || Date.parse(scheduledAt()) < Date.now());
  const uploading = () => ["uploading", "probing"].includes(state.video?.status) || ["uploading", "probing"].includes(state.thumb?.status);

  function blockers() {
    const out = [];
    const v = state.video;
    if (!v) out.push("Add a video");
    else if (v.status === "error") out.push("Video upload failed");
    else if (!v.media) out.push("Waiting for upload to finish");
    if (state.thumb?.status === "error") out.push("Thumbnail upload failed — remove or replace it");
    if (!state.selected.length) out.push("Select at least one platform");
    const errors = state.selected.reduce((n, p) => n + (state.results[p]?.errors.length ?? 0), 0);
    if (errors) out.push(`Fix ${errors} error${errors > 1 ? "s" : ""}`);
    if (state.selected.some((p) => !state.results[p])) out.push("Checking requirements…");
    if (scheduleInvalid()) out.push("Pick a future schedule time");
    if (state.selected.includes("tiktok") && state.creator?.status === "error") out.push("TikTok creator info unavailable — retry in the TikTok panel or deselect TikTok");
    if (state.selected.includes("tiktok") && (!state.creator || state.creator.status === "loading")) out.push("Loading TikTok creator info");
    return out;
  }

  function renderReady() {
    const errors = state.selected.reduce((n, p) => n + (state.results[p]?.errors.length ?? 0), 0);
    const warnings = state.selected.reduce((n, p) => n + (state.results[p]?.warnings.length ?? 0), 0);
    $("counts").innerHTML =
      (errors ? badge(`${errors} error${errors === 1 ? "" : "s"}`, "red") : "") + (warnings ? badge(`${warnings} warning${warnings === 1 ? "" : "s"}`, "amber") : "");
    const bl = blockers();
    $("blockers").innerHTML = bl.map((b) => `<li>• ${esc(b)}</li>`).join("");
    const n = state.selected.length;
    const pub = $("btn-publish");
    pub.disabled = bl.length > 0 || uploading() || state.submitting !== null;
    pub.textContent =
      state.submitting === "publish"
        ? "Submitting…"
        : state.scheduleEnabled
          ? `Schedule ${n} post${n === 1 ? "" : "s"}`
          : `Publish to ${n} platform${n === 1 ? "" : "s"}`;
    const draft = $("btn-draft");
    draft.disabled = uploading() || state.submitting !== null;
    draft.title = uploading() ? "Wait for uploads to finish" : "Drafts can be saved before a video is added";
    draft.textContent = state.submitting === "draft" ? "Saving…" : state.draftId ? "Save changes" : "Save draft";
    const del = $("btn-delete");
    del.hidden = !state.draftId;
    del.disabled = state.submitting !== null;
    del.textContent = state.submitting === "delete" ? "Deleting…" : "Delete draft";
  }

  function renderAll() {
    renderBasics();
    renderPlatformList();
    for (const p of state.selected) renderPanel(p);
    renderTikTok();
    renderReady();
  }

  function showSubmitError(data, status) {
    const box = $("submit-error");
    const parts = [`<p class="bold">${esc(data.error ?? `Request failed (${status})`)}</p>`];
    for (const v of (data.validation ?? []).filter((v) => !v.ok)) {
      parts.push(`<div class="mt-xs"><p class="bold">${esc(rules[v.platform].displayName)}</p><ul class="bullets">${v.errors.map((e) => `<li>${esc(e.message)}</li>`).join("")}</ul></div>`);
    }
    box.innerHTML = parts.join("");
    box.hidden = false;
  }

  async function submit(action) {
    if (action === "publish" && !state.video?.media) return;
    state.submitting = action;
    $("submit-error").hidden = true;
    $("notice").hidden = true;
    renderReady();
    const body = {
      ...base(),
      mediaId: state.video?.media?.id ?? null,
      thumbnailId: state.thumb?.media?.id ?? null,
      visibility: state.visibility,
      scheduledAt: scheduledAt(),
      action,
      targets: state.selected.map((platform) => {
        const o = override(platform);
        return { platform, titleOverride: o.title, captionOverride: o.caption, hashtagsOverride: o.hashtags, settings: state.settings[platform] ?? {} };
      }),
    };
    const { ok, status, data } = await api(state.draftId ? `/api/posts/${state.draftId}` : "/api/posts", CP.jsonInit(state.draftId ? "PUT" : "POST", body));
    state.submitting = null;
    if (!ok) {
      showSubmitError(data, status);
      renderReady();
      return;
    }
    if (action === "draft") {
      if (!state.draftId) {
        state.draftId = data.post.id;
        // Update the URL without a navigation (keeps local previews).
        history.replaceState(null, "", `/compose?draft=${state.draftId}`);
        $("heading").textContent = "Edit draft";
        $("draft-badge").hidden = false;
        $("subheading").innerHTML = `Changes are saved when you click Save draft. <a href="/compose" class="link text-violet bold">Start a new post</a>`;
      }
      const n = $("notice");
      n.textContent = `Draft saved ${new Date().toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}.`;
      n.hidden = false;
      renderReady();
      return;
    }
    location.href = `/dashboard?post=${data.post.id}`;
  }

  async function deleteDraft() {
    if (!state.draftId || !confirm("Delete this draft? This can't be undone.")) return;
    state.submitting = "delete";
    renderReady();
    const { ok, status, data } = await api(`/api/posts/${state.draftId}`, { method: "DELETE" });
    state.submitting = null;
    if (!ok) {
      showSubmitError(data, status);
      renderReady();
      return;
    }
    location.href = "/dashboard";
  }

  // ---------------------------------------------------------------------------
  // Wire up
  // ---------------------------------------------------------------------------
  const d = boot.draft;
  if (d) {
    state.title = d.title;
    state.caption = d.caption;
    state.hashtags = d.hashtags;
    state.visibility = d.visibility;
    if (d.scheduledAt) {
      state.scheduleEnabled = true;
      state.scheduleLocal = CP.toLocalInput(new Date(d.scheduledAt));
    }
    state.selected = platformIds.filter((p) => d.targets.some((t) => t.platform === p));
    for (const t of d.targets) {
      state.overrides[t.platform] = { title: t.titleOverride, caption: t.captionOverride, hashtags: t.hashtagsOverride };
      state.settings[t.platform] = t.settings ?? {};
    }
    state.video = fromMedia(d.media);
    state.thumb = fromMedia(d.thumbnail);
  }

  $("title").value = state.title;
  $("caption").value = state.caption;
  $("schedule-enabled").checked = state.scheduleEnabled;
  $("schedule-at").value = state.scheduleLocal;
  $("title").addEventListener("input", (e) => {
    state.title = e.target.value;
    changed();
  });
  $("caption").addEventListener("input", (e) => {
    state.caption = e.target.value;
    changed();
  });
  hashtagInput($("hashtags"), {
    get: () => state.hashtags,
    set: (tags) => {
      state.hashtags = tags;
      changed();
    },
  });
  $("visibility").addEventListener("click", (e) => {
    const b = e.target.closest("[data-vis]");
    if (!b) return;
    state.visibility = b.dataset.vis;
    changed();
  });
  $("schedule-enabled").addEventListener("change", (e) => {
    state.scheduleEnabled = e.target.checked;
    if (state.scheduleEnabled && !state.scheduleLocal) {
      state.scheduleLocal = CP.toLocalInput(new Date(Date.now() + 60 * 60000));
      $("schedule-at").value = state.scheduleLocal;
    }
    changed();
  });
  $("schedule-at").addEventListener("input", (e) => {
    state.scheduleLocal = e.target.value;
    changed();
  });
  $("btn-draft").addEventListener("click", () => submit("draft"));
  $("btn-publish").addEventListener("click", () => submit("publish"));
  $("btn-delete").addEventListener("click", deleteDraft);
  window.addEventListener("beforeunload", () => {
    clearUpload("video");
    clearUpload("thumb");
  });

  renderUploads();
  syncPanels();
  if (state.selected.includes("tiktok")) loadCreator();
  renderAll();
  changed();
})();
