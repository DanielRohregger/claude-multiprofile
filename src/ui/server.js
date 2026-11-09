// `claude-multiprofile ui` - a small local web UI around the CLI.
//
// The UI does not reimplement any command. It reads the registry for its
// dashboard and runs the real commands (add, doctor, rename, ...) as child
// processes. Their questions reach the browser through the prompt bridge
// (bridge-loader.js swaps @inquirer/prompts for bridge-prompts.js), so the
// browser asks exactly what the terminal would and the command validates the
// answers itself.
//
// Because it can run commands that change your machine, the server:
//   - listens on 127.0.0.1 only,
//   - accepts requests only for its own Host (stops DNS rebinding),
//   - requires a random per-run token on every API call, which only the URL
//     it opens carries (in the #fragment, so it never reaches logs),
//   - runs only the CLI's own commands, with allowlisted arguments.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getRegistry, findProfile, registryHealth, registryLocation } from "../registry.js";
import { detectDefaults } from "../detect.js";
import { resolveClaude } from "../claudebin.js";
import { fixPassDue, readState, toolVersion } from "../state.js";
import { COLORS } from "../appclone.js";
import { fileExists, isMac, tildify } from "../util.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(HERE, "public");
const BIN_PATH = path.join(HERE, "..", "..", "bin", "claude-multiprofile.js");
const HOOK_URL = pathToFileURL(path.join(HERE, "bridge-hook.js")).href;

const STATIC = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/app.css": ["app.css", "text/css; charset=utf-8"],
};

const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
const MAX_BODY = 64 * 1024;
const MAX_EVENTS = 5000;

// ---- Command allowlist -------------------------------------------------

function existingProfile(name) {
  return typeof name === "string" && NAME_RE.test(name) && Boolean(findProfile(name));
}

// Returns null when the arguments are acceptable, otherwise a reason.
export function checkCommand(command, args) {
  if (!Array.isArray(args) || args.some((a) => typeof a !== "string")) return "Arguments must be strings.";
  const n = args.length;
  switch (command) {
    case "add":
    case "list":
    case "status":
      return n === 0 ? null : `${command} takes no arguments here.`;
    case "doctor":
      return n === 0 || (n === 1 && ["--fix", "--undo"].includes(args[0])) ? null : "Unsupported doctor option.";
    case "upgrade":
      return n === 0 || (n === 1 && args[0] === "--no-fix") ? null : "Unsupported upgrade option.";
    case "extensions":
      return n === 0 ? null : "extensions is interactive here.";
    case "repair":
    case "remove":
      if (n === 0) return null;
      return n === 1 && existingProfile(args[0]) ? null : "Unknown profile.";
    case "rename":
      if (n === 0) return null;
      if (!existingProfile(args[0])) return "Unknown profile.";
      if (n === 1) return null;
      return n === 2 && NAME_RE.test(args[1]) ? null : "New name: lowercase letters, numbers and hyphens only.";
    case "self-update":
      if (n === 0) return null;
      if (!existingProfile(args[0])) return "Unknown profile.";
      return n === 1 || (n === 2 && ["on", "off"].includes(args[1])) ? null : 'Expected "on" or "off".';
    default:
      return "Unknown command.";
  }
}

// ---- Overview ------------------------------------------------------------

export function overview() {
  const version = toolVersion();
  const reg = getRegistry();
  const health = registryHealth();
  const defaults = detectDefaults();
  const bin = resolveClaude();
  let fixesPending = false;
  try {
    fixesPending = fixPassDue(version, reg.profiles.length, readState().fixesAppliedFor);
  } catch {
    // Same as the CLI: a failed check never blocks anything.
  }

  return {
    version,
    platform: process.platform,
    mac: isMac(),
    registry: { state: health.state, path: tildify(registryLocation()) },
    fixesPending,
    colors: Object.keys(COLORS),
    defaults: {
      desktop: defaults.desktop
        ? { appPath: defaults.desktop.appPath, dataDir: tildify(defaults.desktop.dataDir) }
        : null,
      code: defaults.code ? { configDir: tildify(defaults.code.configDir) } : null,
    },
    claudeBinary: bin.found
      ? { path: tildify(bin.winner), version: bin.version, shadowed: (bin.shadowed || []).map(tildify) }
      : null,
    profiles: reg.profiles.map((p) => ({
      name: p.name,
      type: p.type,
      createdAt: p.createdAt || null,
      desktop: p.desktop
        ? {
            dataDir: tildify(p.desktop.dataDir),
            appPath: tildify(p.desktop.appPath),
            color: p.desktop.color || null,
            selfUpdate: Boolean(p.desktop.selfUpdate),
            launcherExists: fileExists(p.desktop.appPath),
            launchCommand: `open "${p.desktop.appPath}"`,
          }
        : null,
      code: p.code
        ? {
            configDir: tildify(p.code.configDir),
            aliasName: p.code.aliasName,
            rcPath: p.code.rcPath ? tildify(p.code.rcPath) : null,
            ghConfigDir: p.code.ghConfigDir ? tildify(p.code.ghConfigDir) : null,
            configExists: fileExists(p.code.configDir),
          }
        : null,
    })),
  };
}

// ---- Launching -----------------------------------------------------------

function run(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 15000 }, (e, _out, stderr) =>
      e ? reject(new Error((stderr || e.message).trim())) : resolve()
    );
  });
}

// Opens a profile the same way you would by hand: its launcher .app for
// Desktop, a new Terminal window running its alias for Code.
export async function launch(name, target, runner = run) {
  const p = typeof name === "string" && NAME_RE.test(name) ? findProfile(name) : null;
  if (!p) throw new Error("Unknown profile.");
  if (!isMac()) throw new Error("Launching from the UI needs macOS. Use the command shown instead.");

  if (target === "desktop") {
    if (!p.desktop || !p.desktop.appPath) throw new Error("This profile has no Desktop launcher.");
    if (!fileExists(p.desktop.appPath)) {
      throw new Error("The launcher is missing. Run doctor --fix to rebuild it.");
    }
    await runner("/usr/bin/open", [p.desktop.appPath]);
    return;
  }
  if (target === "code") {
    const alias = p.code && p.code.aliasName;
    if (!alias || !/^[A-Za-z0-9._-]+$/.test(alias)) throw new Error("This profile has no Claude Code alias.");
    // Terminal starts an interactive shell, which loads the rc file the alias
    // lives in. The alias is checked above, so it cannot break out of the
    // AppleScript string.
    await runner("/usr/bin/osascript", [
      "-e",
      `tell application "Terminal" to do script "${alias}"`,
      "-e",
      'tell application "Terminal" to activate',
    ]);
    return;
  }
  throw new Error("Unknown launch target.");
}

// ---- Jobs: one running command at a time ---------------------------------

class Job {
  constructor(id, command, args) {
    this.id = id;
    this.command = command;
    this.args = args;
    this.events = [];
    this.listeners = new Set();
    this.done = false;
    this.pendingPrompt = null;
  }

  emit(event) {
    if (this.events.length < MAX_EVENTS) this.events.push(event);
    for (const l of this.listeners) l(event);
  }
}

export function createUiServer({ spawnCommand } = {}) {
  const token = crypto.randomBytes(24).toString("hex");
  let port = null;
  let current = null;
  let seq = 0;

  const startChild =
    spawnCommand ||
    ((command, args) =>
      spawn(process.execPath, ["--import", HOOK_URL, BIN_PATH, command, ...args], {
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        env: { ...process.env, CLAUDE_MULTIPROFILE_UI: "1", NO_COLOR: "1", FORCE_COLOR: "0" },
      }));

  function startJob(command, args) {
    const job = new Job(String(++seq), command, args);
    const child = startChild(command, args);
    job.child = child;
    current = job;

    const out = (stream) => (chunk) => job.emit({ type: "output", stream, text: chunk.toString("utf8") });
    child.stdout?.on("data", out("stdout"));
    child.stderr?.on("data", out("stderr"));
    child.on("message", (msg) => {
      if (msg && msg.type === "prompt") {
        job.pendingPrompt = msg;
        job.emit(msg);
      }
    });
    child.on("error", (e) => job.emit({ type: "output", stream: "stderr", text: `${e.message}\n` }));
    child.on("exit", (code, signal) => {
      job.done = true;
      job.pendingPrompt = null;
      job.emit({ type: "exit", code: code ?? (signal ? 130 : 1) });
      for (const l of job.listeners) l(null);
      job.listeners.clear();
    });
    return job;
  }

  function getJob(id) {
    return current && current.id === id ? current : null;
  }

  // ---- Request plumbing ----

  function send(res, status, body, headers = {}) {
    const isJson = typeof body !== "string" && !Buffer.isBuffer(body);
    res.writeHead(status, {
      "Content-Type": isJson ? "application/json; charset=utf-8" : headers["Content-Type"] || "text/plain",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      ...headers,
    });
    res.end(isJson ? JSON.stringify(body) : body);
  }

  function hostAllowed(req) {
    return req.headers.host === `127.0.0.1:${port}` || req.headers.host === `localhost:${port}`;
  }

  function tokenOk(provided) {
    if (typeof provided !== "string" || provided.length !== token.length) return false;
    return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(token));
  }

  function readJson(req) {
    return new Promise((resolve, reject) => {
      if (!(req.headers["content-type"] || "").startsWith("application/json")) {
        reject(Object.assign(new Error("Expected JSON."), { status: 415 }));
        return;
      }
      let size = 0;
      const chunks = [];
      req.on("data", (c) => {
        size += c.length;
        if (size > MAX_BODY) {
          reject(Object.assign(new Error("Request too large."), { status: 413 }));
          req.destroy();
        } else chunks.push(c);
      });
      req.on("end", () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
        } catch {
          reject(Object.assign(new Error("Invalid JSON."), { status: 400 }));
        }
      });
      req.on("error", reject);
    });
  }

  function serveStatic(res, file, type) {
    fs.readFile(path.join(PUBLIC_DIR, file), (e, data) => {
      if (e) return send(res, 404, "Not found");
      send(res, 200, data, {
        "Content-Type": type,
        "Content-Security-Policy":
          "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        "X-Frame-Options": "DENY",
      });
    });
  }

  function streamEvents(req, res, job) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "X-Content-Type-Options": "nosniff",
    });
    const write = (event) => {
      if (event === null) return res.end();
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    for (const e of job.events) write(e);
    if (job.done) return res.end();
    job.listeners.add(write);
    const ping = setInterval(() => res.write(": ping\n\n"), 15000);
    res.on("close", () => {
      clearInterval(ping);
      job.listeners.delete(write);
    });
  }

  async function handleApi(req, res, url) {
    const route = `${req.method} ${url.pathname}`;

    if (route === "GET /api/overview") return send(res, 200, overview());

    if (route === "POST /api/jobs") {
      const { command, args = [] } = await readJson(req);
      const problem = checkCommand(command, args);
      if (problem) return send(res, 400, { error: problem });
      if (current && !current.done) {
        return send(res, 409, { error: `"${current.command}" is still running. Finish or cancel it first.` });
      }
      const job = startJob(command, args);
      return send(res, 201, { id: job.id });
    }

    const m = url.pathname.match(/^\/api\/jobs\/(\d+)(?:\/(events|answer|cancel))?$/);
    if (m) {
      const job = getJob(m[1]);
      if (!job) return send(res, 404, { error: "No such job." });
      const action = m[2];
      if (req.method === "GET" && action === "events") return streamEvents(req, res, job);
      if (req.method === "POST" && action === "answer") {
        const { id, value } = await readJson(req);
        if (job.done || !job.pendingPrompt || job.pendingPrompt.id !== id) {
          return send(res, 409, { error: "That question is no longer open." });
        }
        job.pendingPrompt = null;
        job.child.send({ type: "answer", id, value });
        return send(res, 200, { ok: true });
      }
      if (req.method === "POST" && action === "cancel") {
        if (!job.done) {
          if (job.pendingPrompt) job.child.send({ type: "cancel" });
          else job.child.kill("SIGINT");
        }
        return send(res, 200, { ok: true });
      }
    }

    if (route === "POST /api/launch") {
      const { name, target } = await readJson(req);
      await launch(name, target);
      return send(res, 200, { ok: true });
    }

    return send(res, 404, { error: "Not found." });
  }

  const server = http.createServer(async (req, res) => {
    try {
      if (!hostAllowed(req)) return send(res, 403, "Forbidden");
      const url = new URL(req.url, `http://${req.headers.host}`);

      if (req.method === "GET" && STATIC[url.pathname]) {
        const [file, type] = STATIC[url.pathname];
        return serveStatic(res, file, type);
      }
      if (!url.pathname.startsWith("/api/")) return send(res, 404, "Not found");

      // EventSource cannot send headers, so the stream takes the token in
      // the query string; everything else must use the header.
      const provided = url.pathname.endsWith("/events")
        ? url.searchParams.get("t")
        : req.headers["x-cmp-token"];
      if (!tokenOk(provided)) return send(res, 401, { error: "Missing or wrong token. Reopen the UI from the terminal." });

      await handleApi(req, res, url);
    } catch (e) {
      if (!res.headersSent) send(res, e.status || 500, { error: e.message || String(e) });
      else res.end();
    }
  });

  return {
    token,
    server,
    listen(requestedPort = 0) {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(requestedPort, "127.0.0.1", () => {
          port = server.address().port;
          resolve({ port, url: `http://127.0.0.1:${port}/#t=${token}` });
        });
      });
    },
    close() {
      if (current && !current.done) current.child.kill("SIGTERM");
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
