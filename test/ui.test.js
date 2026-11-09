// Tests for the web UI: argument parsing, the command allowlist, the prompt
// bridge (run in a real child process, the way the server runs commands),
// and the server's access checks.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import * as nodeModule from "node:module";

// Point the registry at an empty sandbox before any module reads it.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "cmp-ui-test-"));
process.env.HOME = sandbox;
process.env.XDG_CONFIG_HOME = path.join(sandbox, ".config");

const { parseUiArgs } = await import("../src/commands/ui.js");
const { checkCommand, createUiServer } = await import("../src/ui/server.js");
const { normalizeChoices } = await import("../src/ui/bridge-prompts.js");

test.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));

test("parseUiArgs: defaults, --port forms, --no-open", () => {
  assert.deepEqual(parseUiArgs([]), { port: 0, open: true });
  assert.deepEqual(parseUiArgs(["--port", "4545", "--no-open"]), { port: 4545, open: false });
  assert.deepEqual(parseUiArgs(["--port=8080"]), { port: 8080, open: true });
  assert.throws(() => parseUiArgs(["--port", "99999"]), /Invalid port/);
  assert.throws(() => parseUiArgs(["--port", "abc"]), /Invalid port/);
  assert.throws(() => parseUiArgs(["--bogus"]), /Unknown option/);
});

test("checkCommand: allows known commands and options only", () => {
  for (const [cmd, args] of [
    ["add", []],
    ["list", []],
    ["status", []],
    ["doctor", []],
    ["doctor", ["--fix"]],
    ["doctor", ["--undo"]],
    ["upgrade", ["--no-fix"]],
    ["extensions", []],
    ["rename", []],
    ["remove", []],
  ]) {
    assert.equal(checkCommand(cmd, args), null, `${cmd} ${args.join(" ")}`);
  }
  assert.match(checkCommand("ui", []), /Unknown command/);
  assert.match(checkCommand("doctor", ["--evil"]), /Unsupported/);
  assert.match(checkCommand("add", ["x"]), /no arguments/);
  assert.match(checkCommand("list", [1]), /strings/);
  assert.match(checkCommand("list", "nope"), /strings/);
  // Profile arguments must name an existing profile; the sandbox has none.
  assert.match(checkCommand("remove", ["work"]), /Unknown profile/);
  assert.match(checkCommand("remove", ["../etc"]), /Unknown profile/);
  assert.match(checkCommand("self-update", ["work", "on"]), /Unknown profile/);
});

test("normalizeChoices: drops separators, indexes by position, keeps metadata", () => {
  const out = normalizeChoices([
    { type: "separator", separator: "--" },
    { name: "A", value: { x: 1 }, description: "first" },
    "plain",
    { name: "C", value: "c", disabled: "not now", checked: true },
  ]);
  assert.deepEqual(
    out.map(({ index, name, description, disabled, checked }) => ({ index, name, description, disabled, checked })),
    [
      { index: 0, name: "A", description: "first", disabled: false, checked: false },
      { index: 1, name: "plain", description: null, disabled: false, checked: false },
      { index: 2, name: "C", description: null, disabled: "not now", checked: true },
    ],
  );
  assert.deepEqual(out[0].value, { x: 1 });
});

const HOOK = new URL("../src/ui/bridge-hook.js", import.meta.url).href;
const hasRegister = typeof nodeModule.register === "function";

// Runs a script under the bridge hook with an IPC channel, answering each
// prompt with `answer(prompt)`. Resolves with the prompts seen and stdout.
function runBridged(code, answer) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", HOOK, "--input-type=module", "-e", code], {
      cwd: path.dirname(new URL(import.meta.url).pathname),
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    const prompts = [];
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("message", (msg) => {
      prompts.push(msg);
      const reply = answer(msg);
      child.send(reply === "__cancel__" ? { type: "cancel" } : { type: "answer", id: msg.id, value: reply });
    });
    child.on("error", reject);
    child.on("exit", (exitCode) => resolve({ prompts, stdout, stderr, exitCode }));
  });
}

test("bridge: prompts go over IPC, validation re-asks, choices map by index", { skip: !hasRegister }, async () => {
  const code = `
    import { input, select, checkbox, confirm } from "@inquirer/prompts";
    const name = await input({ message: "Name", validate: (v) => v === "ok" || "Say ok" });
    const pick = await select({ message: "Pick", choices: [{ name: "A", value: { x: 1 } }, { name: "B", value: { x: 2 } }] });
    const many = await checkbox({ message: "Many", choices: [{ name: "P", value: "p" }, { name: "Q", value: "q" }] });
    const yes = await confirm({ message: "Sure?", default: false });
    console.log(JSON.stringify({ name, pick, many, yes }));
  `;
  const answers = { Name: ["nope", "ok"], Pick: [1], Many: [[0, 1]], "Sure?": [true] };
  const { prompts, stdout, stderr, exitCode } = await runBridged(code, (p) => answers[p.message].shift());

  assert.equal(exitCode, 0, stderr);
  assert.deepEqual(JSON.parse(stdout), { name: "ok", pick: { x: 2 }, many: ["p", "q"], yes: true });
  assert.deepEqual(prompts.map((p) => [p.kind, p.message, p.error ?? null]), [
    ["input", "Name", null],
    ["input", "Name", "Say ok"],
    ["select", "Pick", null],
    ["checkbox", "Many", null],
    ["confirm", "Sure?", null],
  ]);
  // Choice values never leave the command's process.
  assert.ok(prompts[2].choices.every((c) => !("value" in c)));
});

test("bridge: cancel rejects with ExitPromptError", { skip: !hasRegister }, async () => {
  const code = `
    import { input } from "@inquirer/prompts";
    try { await input({ message: "Name" }); } catch (e) { console.log(e.name); }
  `;
  const { stdout, exitCode } = await runBridged(code, () => "__cancel__");
  assert.equal(exitCode, 0);
  assert.equal(stdout.trim(), "ExitPromptError");
});

function request(port, { path: p, method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: p, method, headers }, (res) => {
      let data = "";
      res.on("data", (d) => (data += d));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

test("server: token, Host and content-type checks", async () => {
  const ui = createUiServer({
    spawnCommand: () => {
      throw new Error("no commands in this test");
    },
  });
  const { port } = await ui.listen(0);
  try {
    const auth = { "x-cmp-token": ui.token };
    assert.equal((await request(port, { path: "/api/overview" })).status, 401);
    assert.equal((await request(port, { path: "/api/overview", headers: { "x-cmp-token": "bad" } })).status, 401);
    assert.equal(
      (await request(port, { path: "/api/overview", headers: { ...auth, Host: `evil.example:${port}` } })).status,
      403,
    );

    const ov = await request(port, { path: "/api/overview", headers: auth });
    assert.equal(ov.status, 200);
    assert.deepEqual(JSON.parse(ov.body).profiles, []);

    const post = (body, type = "application/json") =>
      request(port, { path: "/api/jobs", method: "POST", headers: { ...auth, "Content-Type": type }, body });
    assert.equal((await post("command=list", "application/x-www-form-urlencoded")).status, 415);
    assert.equal((await post(JSON.stringify({ command: "doctor", args: ["--evil"] }))).status, 400);

    const page = await request(port, { path: "/" });
    assert.equal(page.status, 200);
    assert.match(page.headers["content-security-policy"], /default-src 'none'/);
  } finally {
    await ui.close();
  }
});
