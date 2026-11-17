// "My plugins": plugins you made or changed, with their history (Undo, Restore to here, Save version), versions and
// updates, and sharing on GitHub. Git stays behind these words; the core does the work through its layr__plugin_*
// and layr__github_* tools (docs/ARCHITECTURE.md > The store > The git tools, GitHub).
await layr.ready;

const $ = (sel) => document.querySelector(sel);
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** A core tool's value (its structured content). */
async function core(tool, args = {}) {
  const r = await layr.tools.call(tool, args, { plugin: "layr" });
  const v = r?.structuredContent ?? JSON.parse(r?.content?.[0]?.text ?? "null");
  return v && typeof v === "object" && Object.keys(v).length === 1 && "result" in v ? v.result : v;
}
async function claude(tool, args) {
  const r = await layr.tools.call(tool, args, { plugin: "claude" });
  return r?.structuredContent ?? JSON.parse(r?.content?.[0]?.text ?? "null");
}
const notify = (text, kind = "info") => layr.ui.notify(text, kind).catch(() => {});

const state = {
  repos: [],
  git: true,
  selected: layr.info?.state?.selected ?? null,
  view: layr.info?.params?.view === "github" ? "github" : "plugin",
  tab: "history",
  history: null,
  pending: null,
  openCommit: null,
  diffs: new Map(),
  update: null,
  gh: null,
  forks: null,
  published: null,
  submitted: null,
  claude: false,
  /** What was typed into forms, kept across renders (by input id, or name for radios). */
  form: {},
};
const val = (id, dflt = "") => esc(state.form[id] ?? dflt);

// ------------------------------------------------------------------ helpers

function ago(ms) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 172800) return "yesterday";
  return new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}
function who(author) {
  if (author === "layr (Claude)") return { name: "Claude", cls: "by-claude" };
  if (author === "layr store") return { name: "Store", cls: "by-store" };
  if (author === "layr") return { name: "layr", cls: "" };
  return { name: "You", cls: "by-you" };
}
const kindLabel = { made: "Made by you", changed: "Your changes", store: "As it came" };
const current = () => state.repos.find((p) => p.id === state.selected);

function modal(html, wire) {
  const back = $("#modal");
  $("#modalBox").innerHTML = html;
  back.hidden = false;
  // Asked from inside an action: the panel isn't busy while it waits for the answer.
  const wasBusy = document.body.classList.contains("busy");
  document.body.classList.remove("busy");
  return new Promise((resolve) => {
    const done = (v) => {
      back.hidden = true;
      if (wasBusy) document.body.classList.add("busy");
      resolve(v);
    };
    back.onclick = (e) => {
      if (e.target === back) done(null);
    };
    $("#modalBox").onclick = (e) => {
      const b = e.target.closest("[data-answer]");
      if (b) done(b.dataset.answer === "ok" ? (wire ? wire() : true) : null);
    };
    $("#modalBox").querySelector("input,textarea,button.primary")?.focus();
  });
}
function confirm(title, text, ok = "OK", danger = false) {
  return modal(`<h3>${esc(title)}</h3><p class="layr-muted">${text}</p>
    <div class="buttons"><button class="layr-button" data-answer="no">Cancel</button>
    <button class="layr-button ${danger ? "danger" : "primary"}" data-answer="ok">${esc(ok)}</button></div>`);
}

/** Runs an action with the panel busy; errors become notifications. */
async function act(label, fn) {
  document.body.classList.add("busy");
  try {
    return await fn();
  } catch (e) {
    notify(`${label}: ${e.message}`, "error");
    return undefined;
  } finally {
    document.body.classList.remove("busy");
  }
}

// ------------------------------------------------------------------ loading

async function loadRepos() {
  const r = await core("plugin_repos");
  state.git = r.git;
  state.repos = r.plugins;
  if (!state.selected || !current()) {
    const first = r.plugins.find((p) => p.kind !== "store") ?? r.plugins[0];
    state.selected = first?.id ?? null;
  }
}

async function loadSelected() {
  const p = current();
  state.history = null;
  state.pending = null;
  state.update = null;
  state.forks = null;
  state.openCommit = null;
  state.diffs.clear();
  if (!p || p.insideRepo) return;
  const [history, pending] = await Promise.all([
    core("plugin_history", { plugin: p.id, limit: 50 }).catch((e) => ({ error: e.message })),
    p.kind !== "store" ? core("plugin_diff", { plugin: p.id }).catch(() => null) : null,
  ]);
  state.history = history;
  state.pending = pending;
  if (p.kind !== "made") {
    state.update = { checking: true };
    render();
    state.update = await core("plugin_update", { plugin: p.id, apply: false }).catch((e) => ({ error: e.message }));
    // Checking fetched the new version: it is on this PC now.
    if (state.update?.to && !p.versions?.includes(state.update.to)) await loadRepos().catch(() => {});
  }
}

async function refresh(keepView = true) {
  await act("Loading", async () => {
    await loadRepos();
    if (state.view === "plugin") await loadSelected();
    if (!keepView) state.view = "plugin";
  });
  render();
}

async function loadGithub() {
  state.gh = { checking: true };
  render();
  state.gh = await core("github_status").catch((e) => ({ error: e.message }));
  renderGithubNav();
  render();
}

// ------------------------------------------------------------------ rendering: the list

function renderList() {
  const groups = [
    ["made", "Made by you"],
    ["changed", "Changed by you"],
    ["store", "From the store"],
  ];
  let html = "";
  for (const [kind, title] of groups) {
    const items = state.repos.filter((p) => p.kind === kind);
    if (!items.length) continue;
    html += `<div class="group-title">${title}</div>`;
    for (const p of items) {
      const sel = state.view === "plugin" && p.id === state.selected;
      const meta = p.insideRepo
        ? "in a bigger project"
        : kind === "changed"
          ? p.running === "mine"
            ? `your changes on ${p.mineVersion ?? p.version}`
            : `using ${p.version} as it came`
          : p.version;
      html += `<button class="plugin-item" data-select="${esc(p.id)}" aria-current="${sel}">
        <span class="row"><span class="name">${esc(p.name)}</span>${p.dirty ? `<span class="dot" title="Changes not saved yet"></span>` : ""}</span>
        <span class="meta">${esc(meta)}</span></button>`;
    }
  }
  if (!html) html = `<div class="empty">No plugins installed yet.</div>`;
  $("#list").innerHTML = html;
  $("#githubNav").setAttribute("aria-current", String(state.view === "github"));
}

function renderGithubNav() {
  const g = state.gh;
  $("#githubState").textContent = !g || g.checking ? "GitHub" : g.signedIn ? `GitHub: ${g.user}` : "GitHub: not signed in";
}

// ------------------------------------------------------------------ rendering: one plugin

function render() {
  renderList();
  const el = $("#detail");
  if (!state.git) {
    el.innerHTML = `<div class="empty"><h2>git isn't installed</h2><p>History, undo and updates need git on this PC:
      <a href="https://git-scm.com" target="_blank">git-scm.com</a>.</p></div>`;
    return;
  }
  if (state.view === "github") {
    el.innerHTML = renderGithub();
    return;
  }
  const p = current();
  if (!p) {
    el.innerHTML = `<div class="empty"><h2>Nothing here yet</h2><p>Make a plugin with AI (Tools menu) and it shows up here,
      with every change Claude makes saved as a version you can undo.</p></div>`;
    return;
  }
  const tabs = p.kind === "made" ? ["history", "share"] : ["history", "versions"];
  if (!tabs.includes(state.tab)) state.tab = "history";
  const sub =
    p.kind === "made"
      ? esc(p.path)
      : p.running === "mine"
        ? `Running your changes on version ${esc(p.mineVersion ?? p.version)}`
        : `Running version ${esc(p.version)} as it came from the store`;
  el.innerHTML = `
    <div class="detail-head">
      <div class="title-row"><h1>${esc(p.name)}</h1>
        <span class="layr-badge badge-${p.kind}">${kindLabel[p.kind]}</span>
        <span class="layr-muted">${esc(p.version)}</span></div>
      <div class="sub">${sub}</div>
      <div class="actions">${actionButtons(p)}</div>
      <div class="tabs" role="tablist">${tabs
        .map((t) => `<button class="tab" role="tab" data-tab="${t}" aria-selected="${state.tab === t}">${{ history: "History", versions: "Versions", share: "Share" }[t]}</button>`)
        .join("")}</div>
    </div>
    <div class="body">${p.insideRepo ? insideNotice(p) : state.tab === "history" ? renderHistory(p) : state.tab === "versions" ? renderVersions(p) : renderShare(p)}</div>`;
}

function actionButtons(p) {
  const b = [];
  if (p.kind !== "store" && !p.insideRepo) {
    b.push(`<button class="layr-button primary" data-action="save" ${p.dirty ? "" : "disabled"}>Save version</button>`);
  }
  if (p.kind === "store" || (p.kind === "changed" && p.running !== "mine")) {
    b.push(`<button class="layr-button ${p.kind === "store" ? "primary" : ""}" data-action="edit">${p.kind === "store" ? "Change this plugin" : "Use my changes"}</button>`);
  }
  if ((p.kind === "made" || p.running === "mine") && state.claude && !p.insideRepo) {
    b.push(`<button class="layr-button" data-action="claude">Change it with Claude</button>`);
  }
  if (state.update?.to) b.push(`<button class="layr-button" data-tab="versions">Update to ${esc(state.update.to)}</button>`);
  if (p.kind === "made" && !p.insideRepo) b.push(`<button class="layr-button" data-tab="share">Publish</button>`);
  return b.join("");
}

function insideNotice(p) {
  return `<div class="notice warn"><div class="grow"><strong>This plugin lives inside a bigger project</strong><br>
    <span class="layr-muted">${esc(p.insideRepo)} keeps its history for all its parts: use git there. History and undo
    here work for plugins that have their own folder.</span></div></div>`;
}

function renderHistory(p) {
  let html = "";
  const pend = state.pending?.files ?? [];
  if (pend.length) {
    html += `<div class="notice warn"><div class="grow"><strong>${pend.length} file${pend.length > 1 ? "s" : ""} changed, not saved yet</strong>
      <div class="files">${pend.map((f) => `<span class="file-chip ${f.status}">${esc(f.path)}</span>`).join("")}</div></div>
      <button class="layr-button small" data-action="show-pending">${state.openCommit === "pending" ? "Hide" : "Show"} changes</button>
      <button class="layr-button small primary" data-action="save">Save version</button></div>`;
    if (state.openCommit === "pending") html += renderDiff(state.pending);
  }
  const h = state.history;
  if (!h) return html + `<div class="layr-muted">Loading…</div>`;
  if (h.error) return html + `<div class="notice bad">${esc(h.error)}</div>`;
  if (!h.commits.length) {
    return html + `<div class="empty">No saved versions yet. ${p.kind === "made" ? "Press Save version, or let Claude change it: every finished turn is saved here." : ""}</div>`;
  }
  const editable = p.kind === "made" || p.running === "mine";
  html += `<ol class="timeline">`;
  h.commits.forEach((c, i) => {
    const w = who(c.author);
    const open = state.openCommit === c.sha;
    const first = i === h.commits.length - 1 && !h.more;
    const canUndo = editable && w.cls !== "by-store" && !first;
    html += `<li class="commit ${w.cls}" data-sha="${esc(c.sha)}">
      <div class="commit-head" data-action="toggle" data-sha="${esc(c.sha)}">
        <span class="commit-subject">${esc(w.cls === "by-store" ? `Version ${c.subject.split(" ").pop()} from the store` : c.subject)}</span>
        <span class="commit-meta">${esc(w.name)} · ${esc(ago(c.time))}</span>
      </div>
      ${c.body ? `<div class="commit-body">${esc(c.body)}</div>` : ""}
      <div class="files">${c.files.slice(0, 12).map((f) => `<span class="file-chip ${f.status}">${esc(f.path)}</span>`).join("")}${c.files.length > 12 ? `<span class="layr-muted">+${c.files.length - 12} more</span>` : ""}</div>
      ${open ? `<div class="commit-actions">
          <button class="layr-button small" data-action="undo" data-sha="${esc(c.sha)}" ${canUndo ? "" : "disabled"} title="Take back just these changes">Undo</button>
          <button class="layr-button small" data-action="restore" data-sha="${esc(c.sha)}" ${editable && i > 0 ? "" : "disabled"} title="Make every file as it was here">Restore to here</button>
        </div>${state.diffs.has(c.sha) ? renderDiff(state.diffs.get(c.sha)) : `<div class="layr-muted">Loading changes…</div>`}` : ""}
    </li>`;
  });
  html += `</ol>`;
  if (h.more) html += `<button class="layr-button" data-action="more">Older versions</button>`;
  return html;
}

function renderDiff(d) {
  if (!d?.files?.length) return `<div class="layr-muted">No file changes.</div>`;
  return (
    d.files
      .map((f) => {
        const lines = f.patch
          .split("\n")
          .filter((l) => !/^(index |--- |\+\+\+ |new file mode|deleted file mode|similarity|rename (from|to))/.test(l))
          .map((l) => {
            const cls = l.startsWith("+") ? "add" : l.startsWith("-") ? "del" : l.startsWith("@@") ? "hunk" : "";
            return `<span class="${cls}">${esc(l) || " "}</span>`;
          })
          .join("");
        return `<div class="diff-file"><header><span class="file-chip ${f.status}">${f.status}</span>${esc(f.path)}</header><pre class="diff">${lines}</pre></div>`;
      })
      .join("") + (d.truncated ? `<div class="layr-muted">Only the first part is shown.</div>` : "")
  );
}

function renderVersions(p) {
  let html = "";
  const u = state.update;
  if (u?.checking) html += `<div class="notice">Looking for a newer version…</div>`;
  else if (u?.error) html += `<div class="notice bad"><div class="grow">${esc(u.error)}</div></div>`;
  else if (u?.to) {
    const perms = u.newPermissions?.length ? `<br><span>It asks for more: <strong>${esc(u.newPermissions.join(", "))}</strong></span>` : "";
    if (!u.mine) {
      html += `<div class="notice good"><div class="grow"><strong>Version ${esc(u.to)} is available</strong><br>
        <span class="layr-muted">It replaces ${esc(u.from)}. You can switch back to ${esc(u.from)} here any time.</span>${perms}</div>
        <button class="layr-button primary" data-action="update">Update</button></div>`;
    } else if (u.merges) {
      html += `<div class="notice good"><div class="grow"><strong>Version ${esc(u.to)} is available</strong><br>
        <span class="layr-muted">${u.resolved ? "Your changes were combined with it." : "Your changes fit into it without problems."}
        Your changes on ${esc(u.from)} stay available below.</span>${perms}</div>
        <button class="layr-button primary" data-action="update">Update with my changes</button></div>`;
    } else {
      html += `<div class="notice warn"><div class="grow"><strong>Version ${esc(u.to)} changes the same places you changed</strong><br>
        <span class="layr-muted">In ${esc(u.conflicts.join(", "))}. ${esc(p.name)} keeps running as it is until they are combined${
          state.claude ? ": Claude can do it for you, and you look at the result before using it" : " (by hand, or with Claude once the Claude plugin is installed)"
        }.</span></div>
        ${state.claude ? `<button class="layr-button primary" data-action="merge-claude">Combine with Claude</button>` : ""}
        <button class="layr-button" data-action="merge-folder">Combine by hand</button></div>`;
    }
  } else if (u) html += `<div class="notice"><span class="grow">${esc(p.name)} is up to date.</span></div>`;

  const versions = p.versions ?? [];
  const mineOn = new Set(p.mineVersions ?? []);
  if (p.mineVersion) mineOn.add(p.mineVersion);
  html += `<h3>Versions on this PC</h3><div class="versions">`;
  for (const v of versions) {
    const asCame = p.running !== "mine" && p.version === v;
    const withMine = p.running === "mine" && (p.mineVersion ?? p.version) === v;
    html += `<div class="version-row ${asCame || withMine ? "current" : ""}"><span class="v">${esc(v)}</span>
      <span class="layr-muted" style="flex:1">${asCame ? "in use, as it came" : withMine ? "in use, with your changes" : ""}</span>
      ${asCame ? "" : `<button class="layr-button small" data-action="switch" data-version="${esc(v)}">Use as it came</button>`}
      ${mineOn.has(v) && !withMine ? `<button class="layr-button small" data-action="switch-mine" data-version="${esc(v)}">Use with my changes</button>` : ""}
    </div>`;
  }
  html += `</div>`;
  if (!versions.length) html += `<div class="layr-muted">No versions recorded yet.</div>`;
  // Other people's versions of a store plugin: their signer is compared with the one installed.
  if (p.repository) html += renderForks(p.repository);
  return html;
}

function renderShare(p) {
  const r = state.published;
  const g = state.gh;
  let html = "";
  if (!g || g.checking) html += `<div class="notice">Checking GitHub…</div>`;
  else if (!g.signedIn) {
    html += `<div class="notice warn"><div class="grow"><strong>Sign in to GitHub first</strong><br>
      <span class="layr-muted">${esc(g.error ?? "")}</span></div><button class="layr-button" data-action="view-github">GitHub settings</button></div>`;
  }
  html += `<section><h2>Publish on GitHub</h2>
    <p class="layr-muted">Puts ${esc(p.name)} in ${p.repository ? `<a href="${esc(p.repository)}" target="_blank">${esc(p.repository)}</a>` : "a new repository of yours"}
    with this version as a release others can install. Your saved versions go with it.</p>
    <div class="form" id="publishForm">
      ${p.repository ? "" : `<div><div class="layr-label">Who can see it</div><div class="radio-row">
        <label><input type="radio" name="vis" value="private" ${state.form.vis !== "public" ? "checked" : ""}> Only me (private)</label>
        <label><input type="radio" name="vis" value="public" ${state.form.vis === "public" ? "checked" : ""}> Everyone (public)</label></div></div>
      <label>Repository name <input class="layr-input" id="repoName" value="${val("repoName", p.id)}"></label>`}
      <label>Version <input class="layr-input" id="pubVersion" value="${val("pubVersion", p.version)}" placeholder="like 0.2.0"></label>
      <label>What's new <textarea class="layr-textarea" id="pubNotes" rows="3" placeholder="A sentence for the release">${val("pubNotes")}</textarea></label>
      <div><button class="layr-button primary" data-action="publish" ${g?.signedIn ? "" : "disabled"}>Publish</button></div>
    </div>
    ${r ? `<div class="notice good result" style="margin-top:12px"><div class="grow"><strong>Published ${esc(r.tag)}</strong><br>
      <a href="${esc(r.release)}" target="_blank">${esc(r.release)}</a><br><span class="layr-muted">Package: ${esc(r.asset)}</span></div></div>` : ""}
  </section>`;
  html += `<section><h2>Add to a store</h2>
    <p class="layr-muted">Asks a store (a GitHub repository with an index of plugins) to list your latest release, by pull request.</p>
    <div class="form"><label>Store <input class="layr-input" id="storeRepo" value="${val("storeRepo")}" placeholder="owner/layr-store"></label>
      <div><button class="layr-button" data-action="submit" ${p.repository && g?.signedIn ? "" : "disabled"}>Ask to be added</button></div></div>
    ${state.submitted ? `<div class="notice good result" style="margin-top:12px">Pull request: <a href="${esc(state.submitted.pr)}" target="_blank">${esc(state.submitted.pr)}</a></div>` : ""}
  </section>`;
  if (p.repository) html += renderForks(p.repository);
  return html;
}

/** A publisher key's fingerprint as people compare it: its first 16 hex digits in groups of four. */
function shortKey(fingerprint) {
  return (String(fingerprint ?? "").slice(0, 16).match(/.{1,4}/g) ?? []).join(" ");
}

/** Who signed a fork's release, and whether that is someone else than the installed plugin's publisher. */
function forkSigner(k) {
  const by = k.signed ? `signed by ${esc(shortKey(k.fingerprint))}` : k.sigError ? "bad signature" : "not signed";
  const what = k.signerChange === "changed" ? "another publisher" : "unsigned, yours is signed";
  const other = k.signerChange ? ` <strong class="other-signer">· ${what}</strong>` : "";
  return `<span class="layr-muted">· ${by}</span>${other}`;
}

/** The warning when installing replaces the installed plugin's publisher (signed packages). */
function signerWarning(s) {
  const what = `${esc(s.id)} ${esc(s.to)}`;
  const pinned = esc(shortKey(s.pinnedFingerprint));
  const after = "it replaces the installed one, and its permissions and tool rights start over.";
  return s.signerChange === "changed"
    ? `${what} is signed by someone else (key ${esc(shortKey(s.fingerprint))}; the installed one is signed by ` +
        `${pinned}). Install it only if you trust them: ${after}`
    : `${what} is not signed, but the installed one is (key ${pinned}). Install it only if you trust where it comes ` +
        `from: ${after}`;
}

function renderForks(repository) {
  const f = state.forks;
  let html = `<section><h2>Other people's versions</h2><p class="layr-muted">Copies (forks) of this plugin on GitHub that have a release.</p>`;
  if (!f) html += `<button class="layr-button" data-action="forks" data-repo="${esc(repository)}">Look for them</button>`;
  else if (f.error) html += `<div class="notice bad">${esc(f.error)}</div>`;
  else if (!f.forks.length) html += `<div class="layr-muted">None yet.</div>`;
  else {
    html += `<div class="versions">${f.forks
      .map((k) => `<div class="version-row"><span class="v">${esc(k.owner)}</span><span style="flex:1">${esc(k.version)}
        <span class="layr-muted">· ${esc(k.repository)}</span> ${forkSigner(k)}</span>
        <button class="layr-button small" data-action="install-release" data-repo="${esc(k.repository)}" data-tag="${esc(k.tag)}">Install</button></div>`)
      .join("")}</div>`;
  }
  return html + `</section>`;
}

function renderGithub() {
  const g = state.gh;
  let status;
  if (!g || g.checking) status = `<div class="notice">Checking…</div>`;
  else if (g.signedIn) {
    status = `<div class="notice good"><div class="grow"><strong>Signed in as ${esc(g.user)}</strong><br><span class="layr-muted">${
      g.via === "token" ? "With the token you pasted (kept encrypted on this PC)." : "Through the GitHub CLI on this PC."
    }</span></div>${g.tokenSaved ? `<button class="layr-button small" data-action="token-clear">Forget the token</button>` : ""}</div>`;
  } else {
    status = `<div class="notice warn"><div class="grow"><strong>Not signed in</strong><br><span class="layr-muted">${esc(g.error ?? "")}</span></div></div>`;
  }
  const tokenForm = g && !g.checking && !g.signedIn && g.gh
    ? `<section><h2>Sign in</h2><p class="layr-muted">Easiest: run <code>gh auth login</code> once in a terminal. Or paste a
        GitHub token (Settings › Developer settings › Personal access tokens, with access to repositories): layr keeps it
        encrypted for your Windows user.</p>
        <div class="form"><label>Token <input class="layr-input" id="token" type="password" autocomplete="off" placeholder="github_pat_…"></label>
        <div><button class="layr-button primary" data-action="token-set">Keep it</button></div></div></section>`
    : "";
  return `<div class="detail-head"><div class="title-row"><h1>GitHub</h1></div>
      <div class="sub">Plugins are shared through GitHub: a repository per plugin, releases to install, forks for other people's versions.</div></div>
    <div class="body">${status}${tokenForm}
      <section><h2>Install from GitHub</h2><p class="layr-muted">A plugin repository's latest release (or a fork's).</p>
        <div class="form"><label>Repository <input class="layr-input" id="installRepo" value="${val("installRepo")}" placeholder="owner/name or https://github.com/owner/name"></label>
          <div><button class="layr-button" data-action="install-release" ${g?.signedIn ? "" : "disabled"}>Show what it installs</button></div></div></section>
    </div>`;
}

// ------------------------------------------------------------------ actions

async function openWithClaude(path, prompt, title) {
  const { project } = await claude("project_add", { path });
  const { thread } = await claude("thread_start", { project: project.id, prompt, permissionMode: "acceptEdits", title });
  await layr.panels.open("thread", { thread: thread.id }, { plugin: "claude" });
}

// A release's `.sig` is checked and pinned like a store install's: signed by another key than the installed plugin
// (or unsigned while it is signed), it installs only as a replacement, which the button says.
async function installRelease(repository, tag) {
  const plan = await core("github_release_install", { repository, tag });
  const steps = plan.steps ?? [];
  const replace = steps.filter((s) => s.signerChange).map((s) => s.id);
  const signer = (s) => (s.signed ? ` · signed by ${esc(shortKey(s.fingerprint))}` : " · not signed");
  const asks = (s) => (s.newPermissions?.length ? ` · asks for ${esc(s.newPermissions.join(", "))}` : "");
  const lines = steps
    .map((s) => `<li><strong>${esc(s.id)}</strong> ${s.from ? `${esc(s.from)} → ` : ""}${esc(s.to)}` +
      `${signer(s)}${asks(s)}</li>`)
    .join("");
  const replaces = (s) =>
    `This replaces ${esc(s.id)} from ${esc(s.replacesText ?? s.replacesOrigin)} with one from ` +
    `${esc(s.originText ?? s.origin)}: the tool rights you gave it reset to the defaults.`;
  const warnings = steps
    .map((s) => (s.signerChange ? signerWarning(s) : s.replacesOrigin ? replaces(s) : ""))
    .filter(Boolean)
    .map((w) => `<span class="signer-warning">${w}</span>`)
    .join("");
  const verb = replace.length ? "Install as replacement" : "Install";
  const body = `${warnings}<ul>${lines || "<li>Nothing to change</li>"}</ul>`;
  const ok = await confirm(`Install ${plan.release?.asset ?? "the release"}?`, body, verb, replace.length > 0);
  if (!ok) return;
  await core("github_release_install", { repository, tag, approved: true, ...(replace.length ? { replace } : {}) });
  notify(`Installed ${plan.release?.asset}`, "success");
  await refresh();
}

const actions = {
  async save() {
    const p = current();
    const message = await modal(`<h3>Save version</h3><p class="layr-muted">A few words about what changed (you can leave it empty).</p>
      <input class="layr-input" id="saveMsg" style="width:100%" placeholder="Bigger buttons">
      <div class="buttons"><button class="layr-button" data-answer="no">Cancel</button><button class="layr-button primary" data-answer="ok">Save</button></div>`,
      () => $("#saveMsg").value);
    if (message === null) return;
    const r = await core("plugin_save", { plugin: p.id, message });
    notify(r.commit ? "Saved" : "Nothing to save", r.commit ? "success" : "info");
    await refresh();
  },
  async edit() {
    const p = current();
    const r = await core("plugin_edit", { plugin: p.id });
    notify(`${p.name} now runs from your copy: ${r.path}`, "success");
    await refresh();
  },
  async claude() {
    const p = current();
    const prompt = await modal(`<h3>Change ${esc(p.name)} with Claude</h3><p class="layr-muted">Say what you'd like different. Every change is saved here, so you can undo it.</p>
      <textarea class="layr-textarea" id="claudeAsk" rows="4" style="width:100%"></textarea>
      <div class="buttons"><button class="layr-button" data-answer="no">Cancel</button><button class="layr-button primary" data-answer="ok">Start</button></div>`,
      () => $("#claudeAsk").value.trim());
    if (!prompt) return;
    // A thread on the plugin (claude 0.3.2: it shows under Plugins, and knows how layr plugins work); older ones: its folder.
    const started = await claude("thread_start", { target: { kind: "plugin", plugin: p.id }, prompt }).catch(() => null);
    if (started?.thread) return void (await layr.panels.open("thread", { thread: started.thread.id }, { plugin: "claude" }));
    await openWithClaude(p.path, `This folder is the layr plugin "${p.name}". ${prompt}`, `${p.name}: ${prompt.slice(0, 40)}`);
  },
  async toggle(el) {
    const sha = el.dataset.sha;
    state.openCommit = state.openCommit === sha ? null : sha;
    render();
    if (state.openCommit && !state.diffs.has(sha)) {
      state.diffs.set(sha, await core("plugin_diff", { plugin: state.selected, commit: sha }).catch((e) => ({ files: [], error: e.message })));
      render();
    }
  },
  "show-pending"() {
    state.openCommit = state.openCommit === "pending" ? null : "pending";
    render();
  },
  async more() {
    const more = await core("plugin_history", { plugin: state.selected, limit: 50, skip: state.history.commits.length });
    state.history = { commits: [...state.history.commits, ...more.commits], more: more.more };
    render();
  },
  async undo(el) {
    const c = state.history.commits.find((x) => x.sha === el.dataset.sha);
    if (!(await confirm("Undo these changes?", `“${esc(c.subject)}” is taken back. Later changes stay, and this undo is saved as a version too.`, "Undo"))) return;
    const r = await core("plugin_undo", { plugin: state.selected, commit: c.sha });
    notify(r.commit ? "Undone" : "Nothing to undo", "success");
    await refresh();
  },
  async restore(el) {
    const c = state.history.commits.find((x) => x.sha === el.dataset.sha);
    if (!(await confirm("Go back to this version?", `Every file becomes as it was at “${esc(c.subject)}”. Nothing is lost: what you have now stays in the history.`, "Restore"))) return;
    await core("plugin_restore", { plugin: state.selected, commit: c.sha });
    notify("Restored", "success");
    await refresh();
  },
  async update() {
    const p = current();
    const u = state.update;
    const perms = u.newPermissions?.length > 0;
    if (perms && !(await confirm(`Update ${p.name}?`, `Version ${esc(u.to)} asks for more: <strong>${esc(u.newPermissions.join(", "))}</strong>`, "Allow and update"))) return;
    await core("plugin_update", { plugin: p.id, version: u.to, approved: perms });
    notify(`${p.name} ${u.to}`, "success");
    await refresh();
  },
  async "merge-claude"() {
    const p = current();
    const h = await core("plugin_merge_help", { plugin: p.id, version: state.update.to });
    await openWithClaude(h.path, h.prompt, `${p.name}: combine with ${state.update.to}`);
    notify("When Claude is done, press Update here to use the combined version.", "info");
  },
  async "merge-folder"() {
    const p = current();
    const h = await core("plugin_merge_help", { plugin: p.id, version: state.update.to });
    await modal(`<h3>Combine by hand</h3><p>The new version and your changes are in <code>${esc(h.path)}</code>. These files have both, marked
      with &lt;&lt;&lt;&lt;&lt;&lt;&lt; and &gt;&gt;&gt;&gt;&gt;&gt;&gt;: ${esc(h.conflicts.join(", ") || "none left")}.</p>
      <p class="layr-muted">Edit them to keep what you want, save, then press Update here.</p>
      <div class="buttons"><button class="layr-button primary" data-answer="ok">OK</button></div>`);
  },
  async switch(el) {
    const p = current();
    await core("plugin_switch", { plugin: p.id, version: el.dataset.version });
    notify(`${p.name} ${el.dataset.version}, as it came`, "success");
    await refresh();
  },
  async "switch-mine"(el) {
    const p = current();
    await core("plugin_switch", { plugin: p.id, version: el.dataset.version, mine: true });
    notify(`${p.name} ${el.dataset.version} with your changes`, "success");
    await refresh();
  },
  async publish() {
    const p = current();
    const visibility = document.querySelector('input[name="vis"]:checked')?.value ?? "private";
    const name = $("#repoName")?.value.trim() || undefined;
    const version = $("#pubVersion").value.trim();
    const notes = $("#pubNotes").value.trim() || undefined;
    const where = p.repository ?? `a new ${visibility} repository “${name}”`;
    if (!(await confirm(`Publish ${p.name} ${version}?`, `It goes to ${esc(where)} on GitHub, as a release anyone ${visibility === "public" || p.repository ? "who can see the repository" : "you allow"} can install.`, "Publish"))) return;
    state.form = {};
    state.published = await core("github_publish", { plugin: p.id, visibility, name, version: version !== p.version ? version : undefined, notes });
    notify(`Published ${state.published.tag}`, "success");
    await refresh();
  },
  async submit() {
    const p = current();
    const store = $("#storeRepo").value.trim();
    if (!store) return notify("Give the store, like owner/layr-store", "error");
    state.submitted = await core("github_store_submit", { repository: p.repository, store });
    notify("Pull request opened", "success");
    render();
  },
  async forks(el) {
    state.forks = await core("github_forks", { repository: el.dataset.repo }).catch((e) => ({ error: e.message }));
    render();
  },
  async "install-release"(el) {
    const repo = el.dataset.repo ?? $("#installRepo")?.value.trim();
    if (!repo) return notify("Give a repository, like owner/name", "error");
    await installRelease(repo, el.dataset.tag || undefined);
  },
  async "token-set"() {
    await core("github_token_set", { token: $("#token").value });
    $("#token").value = "";
    await loadGithub();
  },
  async "token-clear"() {
    await core("github_token_clear");
    await loadGithub();
  },
  async "view-github"() {
    state.view = "github";
    render();
    if (!state.gh || state.gh.error) await loadGithub();
  },
};

document.addEventListener("click", async (e) => {
  const sel = e.target.closest("[data-select]");
  if (sel) {
    state.selected = sel.dataset.select;
    state.view = "plugin";
    state.published = null;
    state.submitted = null;
    state.form = {};
    layr.panel.setState({ selected: state.selected }).catch(() => {});
    render();
    await act("Loading", loadSelected);
    render();
    return;
  }
  const tab = e.target.closest("[data-tab]");
  if (tab && !tab.disabled) {
    state.tab = tab.dataset.tab;
    render();
    return;
  }
  const a = e.target.closest("[data-action]");
  if (a && !a.disabled && actions[a.dataset.action]) await act(a.textContent.trim() || a.dataset.action, () => actions[a.dataset.action](a));
});
$("#refresh").onclick = () => refresh();
// Keep what is typed into the detail's forms when it is drawn again (not the token, nor modal fields).
$("#detail").addEventListener("input", (e) => {
  const el = e.target;
  if (el.type === "password") return;
  if (el.type === "radio") state.form[el.name] = el.value;
  else if (el.id) state.form[el.id] = el.value;
});

layr.panel.onParams?.((params) => {
  if (params?.view === "github") actions["view-github"]();
  if (params?.plugin) {
    state.selected = params.plugin;
    state.view = "plugin";
    refresh();
  }
});
// Plugins installed, linked, switched elsewhere: show it.
let soon = null;
layr.events.on("layr:packages", (e) => {
  if (e?.phase !== "done") return;
  clearTimeout(soon);
  const later = () => {
    // Not while someone types or answers a question.
    if (!$("#modal").hidden || document.activeElement?.matches("input,textarea")) soon = setTimeout(later, 1500);
    else refresh();
  };
  soon = setTimeout(later, 400);
});

if (layr.info?.params?.plugin) state.selected = layr.info.params.plugin;
state.claude = await layr.tools
  .list({ plugin: "claude" })
  .then((t) => t.some((x) => x.name === "thread_start"))
  .catch(() => false);
await refresh();
loadGithub();
