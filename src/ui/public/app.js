// Front-end for `claude-multiprofile ui`. Plain JavaScript, no build step.
// Everything from the server is rendered with textContent, never as HTML.

const TOKEN_KEY = "cmp-token";
const token = (() => {
  const m = location.hash.match(/t=([0-9a-f]+)/);
  if (m) {
    sessionStorage.setItem(TOKEN_KEY, m[1]);
    history.replaceState(null, "", location.pathname);
    return m[1];
  }
  return sessionStorage.getItem(TOKEN_KEY);
})();

const $ = (sel) => document.querySelector(sel);

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v == null) continue;
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

async function api(path, body) {
  const res = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "x-cmp-token": token || "", ...(body !== undefined && { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2600);
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast("Copied to clipboard");
  } catch {
    toast(text);
  }
}

// ---- Overview ------------------------------------------------------------

let state = null;

async function load() {
  if (!token) {
    renderFatal("This page needs the link printed by claude-multiprofile ui. Run it again and use that link.");
    return;
  }
  try {
    state = await api("/api/overview");
    render();
  } catch (e) {
    renderFatal(e.message);
  }
}

function renderFatal(msg) {
  $("#main").replaceChildren(el("div", { class: "banner bad" }, el("span", { text: msg })));
}

function render() {
  $("#version").textContent = state.version ? `v${state.version}` : "";
  renderBanners();
  renderChecklist();
  renderProfiles();
  renderDefaults();
}

function banner(kind, text, action) {
  return el("div", { class: `banner ${kind}` }, el("span", { text }), action || null);
}

function renderBanners() {
  const out = [];
  if (state.registry.state === "corrupt") {
    out.push(banner("bad", `Your profile list at ${state.registry.path} is not valid JSON. Fix it by hand (a .bak may sit next to it) before changing profiles.`));
  }
  if (state.fixesPending) {
    out.push(
      banner(
        "warn",
        `Version ${state.version} has changes that have not been applied to your profiles yet.`,
        el("button", { class: "primary", type: "button", onclick: () => runJob("doctor", ["--fix"]) }, "Apply now")
      )
    );
  }
  if (!state.mac) {
    out.push(banner("info", "Claude Desktop profiles need macOS. On this system you can set up Claude Code profiles."));
  }
  $("#banners").replaceChildren(...out);
}

function renderChecklist() {
  const d = state.defaults;
  const items = [];
  if (state.mac) {
    items.push([Boolean(d.desktop), "Claude Desktop is installed and has been opened once", d.desktop ? d.desktop.appPath : "Install Claude Desktop from claude.ai/download and open it once."]);
  }
  items.push([Boolean(state.claudeBinary), "Claude Code (the claude command) is on your PATH", state.claudeBinary ? `${state.claudeBinary.path} ${state.claudeBinary.version || ""}` : "Optional: needed for Claude Code profiles. npm install -g @anthropic-ai/claude-code"]);
  items.push([state.profiles.length > 0, "Create your first profile", "Use “Add profile”: pick Desktop, Code or both, then a name such as work or client-acme."]);
  items.push([false, "Sign in once in each new profile", "Open it from its card below and sign in with that profile's account. Each profile keeps its own login."]);

  const show = state.profiles.length === 0 || items.slice(0, -2).some(([done]) => !done);
  $("#setup").hidden = !show;
  $("#checklist").replaceChildren(
    ...items.map(([done, title, hint]) =>
      el(
        "li",
        {},
        el("span", { class: `check ${done ? "done" : "todo"}`, "aria-label": done ? "done" : "to do" }, done ? "✓" : "•"),
        el("div", {}, el("div", { text: title }), el("div", { class: "muted small", text: hint }))
      )
    )
  );
}

function cmdRow(text) {
  return el(
    "div",
    { class: "cmd mono" },
    el("span", { text, title: text }),
    el("button", { class: "link", type: "button", title: "Copy", "aria-label": `Copy ${text}`, onclick: () => copy(text) }, "⧉")
  );
}

async function launch(name, target) {
  try {
    await api("/api/launch", { name, target });
    toast(target === "desktop" ? `Opening Claude ${name}…` : `Opening a Terminal for ${name}…`);
  } catch (e) {
    toast(e.message);
  }
}

function profileCard(p) {
  const actions = [el("button", { type: "button", onclick: () => runJob("rename", [p.name]) }, "Rename")];
  if (p.desktop && state.mac) {
    actions.push(el("button", { type: "button", title: "Re-register the launcher with macOS", onclick: () => runJob("repair", [p.name]) }, "Repair launcher"));
    actions.push(
      el(
        "button",
        {
          type: "button",
          title: p.desktop.selfUpdate ? "Let the launcher keep this copy current (default)" : "Let Claude update this copy itself",
          onclick: () => runJob("self-update", [p.name, p.desktop.selfUpdate ? "off" : "on"]),
        },
        p.desktop.selfUpdate ? "Self-update: on" : "Self-update: off"
      )
    );
  }
  actions.push(el("button", { type: "button", class: "danger", onclick: () => runJob("remove", [p.name]) }, "Remove…"));

  const desktop = p.desktop
    ? el(
        "div",
        { class: "surface" },
        el(
          "div",
          { class: "surface-head" },
          el("strong", {}, "Claude Desktop"),
          state.mac
            ? el("button", { type: "button", class: "primary", disabled: !p.desktop.launcherExists, onclick: () => launch(p.name, "desktop") }, "Open")
            : null
        ),
        p.desktop.launcherExists ? null : el("div", { class: "pill bad", text: "Launcher missing: run Doctor --fix" }),
        cmdRow(p.desktop.launchCommand),
        el("div", { class: "path", text: `Data: ${p.desktop.dataDir}` })
      )
    : null;

  const code = p.code
    ? el(
        "div",
        { class: "surface" },
        el(
          "div",
          { class: "surface-head" },
          el("strong", {}, "Claude Code"),
          state.mac ? el("button", { type: "button", class: "primary", onclick: () => launch(p.name, "code") }, "Open in Terminal") : null
        ),
        cmdRow(p.code.aliasName),
        el("div", { class: "path", text: `Config: ${p.code.configDir}${p.code.rcPath ? ` · alias in ${p.code.rcPath}` : ""}` }),
        p.code.ghConfigDir ? el("div", { class: "path", text: `Own GitHub CLI login: ${p.code.ghConfigDir}` }) : null
      )
    : null;

  const type = p.type === "both" ? "Desktop + Code" : p.type === "desktop" ? "Desktop" : "Code";
  return el(
    "article",
    { class: "card profile" },
    el(
      "div",
      { class: "profile-head" },
      el("span", { class: `dot ${(p.desktop && p.desktop.color) || ""}`, title: (p.desktop && p.desktop.color) || "no colour" }),
      el("h3", { text: p.name }),
      el("span", { class: "pill", text: type })
    ),
    desktop,
    code,
    el("div", { class: "profile-actions" }, actions)
  );
}

function renderProfiles() {
  const box = $("#profiles");
  if (state.profiles.length === 0) {
    box.replaceChildren(
      el(
        "div",
        { class: "empty" },
        el("div", { text: "No profiles yet. A profile is a separate Claude login, with its own chats, settings and connectors, next to your existing one." }),
        el("button", { type: "button", class: "primary", onclick: () => runJob("add") }, "Create your first profile")
      )
    );
    return;
  }
  box.replaceChildren(...state.profiles.map(profileCard));
}

function renderDefaults() {
  const rows = [];
  const d = state.defaults;
  if (d.desktop) rows.push(["Desktop app", d.desktop.appPath], ["Desktop data", d.desktop.dataDir]);
  else if (state.mac) rows.push(["Desktop", "not detected"]);
  if (d.code) rows.push(["Code config", d.code.configDir]);
  if (state.claudeBinary) {
    rows.push(["claude binary", `${state.claudeBinary.path} (${state.claudeBinary.version || "unknown version"})`]);
    if (state.claudeBinary.shadowed.length) rows.push(["Also on PATH", state.claudeBinary.shadowed.join(", ")]);
  } else rows.push(["claude binary", "not found on PATH"]);
  rows.push(["Profile list", state.registry.path]);
  $("#defaults").replaceChildren(...rows.flatMap(([k, v]) => [el("dt", { text: k }), el("dd", { class: "mono", text: v })]));
}

// ---- Jobs ------------------------------------------------------------------

let job = null;

function setStatus(text, kind) {
  const s = $("#job-status");
  s.textContent = text;
  s.className = `pill ${kind}`;
}

async function runJob(command, args = []) {
  if (job && !job.done) return;
  let id;
  try {
    ({ id } = await api("/api/jobs", { command, args }));
  } catch (e) {
    toast(e.message);
    return;
  }
  job = { id, done: false, command };
  $("#job-title").textContent = ["claude-multiprofile", command, ...args].join(" ");
  $("#job-log").replaceChildren();
  $("#prompt").hidden = true;
  $("#job-cancel").hidden = false;
  $("#job-close").hidden = true;
  setStatus("running", "run");
  $("#job").hidden = false;

  const es = new EventSource(`/api/jobs/${id}/events?t=${encodeURIComponent(token)}`);
  job.es = es;
  es.onmessage = (m) => onEvent(JSON.parse(m.data));
  es.onerror = () => {
    if (job && job.done) es.close();
  };
}

function appendLog(text, stream) {
  const log = $("#job-log");
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  log.append(stream === "stderr" ? el("span", { class: "err", text }) : document.createTextNode(text));
  if (atBottom) log.scrollTop = log.scrollHeight;
}

function onEvent(ev) {
  if (ev.type === "output") appendLog(ev.text, ev.stream);
  else if (ev.type === "prompt") showPrompt(ev);
  else if (ev.type === "exit") {
    job.done = true;
    job.es.close();
    $("#prompt").hidden = true;
    $("#job-cancel").hidden = true;
    $("#job-close").hidden = false;
    $("#job-close").focus();
    if (ev.code === 0) setStatus("done", "ok");
    else if (ev.code === 130) setStatus("cancelled", "");
    else setStatus(`failed (exit ${ev.code})`, "bad");
    load();
  }
}

async function answer(prompt, value) {
  $("#prompt").hidden = true;
  try {
    await api(`/api/jobs/${job.id}/answer`, { id: prompt.id, value });
  } catch (e) {
    toast(e.message);
  }
}

function showPrompt(p) {
  const form = $("#prompt");
  const parts = [el("div", { class: "q", text: p.message })];
  if (p.error) parts.push(el("div", { class: "error", role: "alert", text: p.error }));

  if (p.kind === "confirm") {
    const yes = el("button", { type: "button", class: p.default ? "primary" : "", onclick: () => answer(p, true) }, "Yes");
    const no = el("button", { type: "button", class: p.default ? "" : "primary", onclick: () => answer(p, false) }, "No");
    parts.push(el("div", { class: "prompt-actions" }, no, yes));
    form.onsubmit = (e) => {
      e.preventDefault();
      answer(p, p.default);
    };
    form.replaceChildren(...parts);
    form.hidden = false;
    (p.default ? yes : no).focus();
    return;
  }

  let collect;
  if (p.kind === "select" || p.kind === "checkbox") {
    const type = p.kind === "select" ? "radio" : "checkbox";
    const opts = p.choices.map((c) =>
      el(
        "label",
        { class: `option ${c.disabled ? "disabled" : ""}` },
        el("input", {
          type,
          name: "choice",
          value: String(c.index),
          disabled: Boolean(c.disabled),
          checked: type === "radio" ? c.index === p.default : c.checked && !c.disabled,
        }),
        el(
          "div",
          {},
          el("div", { text: c.name }),
          c.description ? el("div", { class: "desc", text: c.description }) : null,
          typeof c.disabled === "string" ? el("div", { class: "desc", text: c.disabled }) : null
        )
      )
    );
    parts.push(el("div", { class: "options" }, opts));
    collect = () => {
      const picked = [...form.querySelectorAll("input[name=choice]:checked")].map((i) => Number(i.value));
      return type === "radio" ? (picked.length ? picked[0] : null) : picked;
    };
  } else {
    const field = el("input", {
      type: p.secret ? "password" : "text",
      value: p.default || "",
      autocomplete: "off",
      spellcheck: "false",
      "aria-label": p.message,
    });
    parts.push(field);
    collect = () => field.value;
  }

  parts.push(el("div", { class: "prompt-actions" }, el("button", { type: "submit", class: "primary" }, "Continue")));
  form.onsubmit = (e) => {
    e.preventDefault();
    answer(p, collect());
  };
  form.replaceChildren(...parts);
  form.hidden = false;
  const focusable = form.querySelector("input:checked, input[type=text], input[type=password], input:not(:disabled)");
  if (focusable) focusable.focus();
}

function closeJob() {
  if (job && !job.done) return;
  $("#job").hidden = true;
}

$("#job-cancel").addEventListener("click", async () => {
  if (!job || job.done) return;
  try {
    await api(`/api/jobs/${job.id}/cancel`, {});
  } catch (e) {
    toast(e.message);
  }
});
$("#job-close").addEventListener("click", closeJob);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("#job").hidden) {
    if (job && job.done) closeJob();
    else $("#job-cancel").click();
  }
});

$("#refresh").addEventListener("click", load);
$("#add-profile").addEventListener("click", () => runJob("add"));
for (const b of document.querySelectorAll("[data-run]")) {
  const [command, ...args] = b.dataset.run.split(" ");
  b.addEventListener("click", () => runJob(command, args));
}

load();
