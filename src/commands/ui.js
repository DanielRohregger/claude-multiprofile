// `claude-multiprofile ui [--port <n>] [--no-open]`
//
// Starts the local web UI (src/ui/server.js) and opens it in the browser.
// It runs until you press Ctrl+C.

import { execFile } from "node:child_process";
import * as nodeModule from "node:module";
import { createUiServer } from "../ui/server.js";
import { header, info, ok, err, command, dim } from "../util.js";

export function parseUiArgs(args) {
  const opts = { port: 0, open: true };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--no-open") opts.open = false;
    else if (a === "--port" || a.startsWith("--port=")) {
      const v = a.includes("=") ? a.split("=")[1] : args[++i];
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error(`Invalid port: ${v}`);
      opts.port = n;
    } else throw new Error(`Unknown option for ui: ${a}`);
  }
  return opts;
}

function openBrowser(url) {
  const opener =
    process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  execFile(opener[0], opener[1], () => {});
}

export async function ui(args = []) {
  // The UI asks questions through a module hook, which needs Node 18.19+.
  if (typeof nodeModule.register !== "function") {
    err(`The UI needs Node 18.19 or newer (this is ${process.version}). The other commands still work.`);
    process.exit(1);
  }

  const opts = parseUiArgs(args);
  const app = createUiServer();
  const { url } = await app.listen(opts.port);

  header("claude-multiprofile UI");
  ok(`Running at ${command(url)}`);
  info("Only this computer can reach it, and only with the link above.");
  console.log(dim("  Press Ctrl+C to stop.\n"));
  if (opts.open) openBrowser(url);

  await new Promise((resolve) => {
    const stop = () => {
      console.log("\nStopping the UI.");
      app.close().then(resolve);
      setTimeout(resolve, 2000).unref();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}
