// Module resolution hook for commands run from the web UI.
//
// Registered by bridge-hook.js in the child process the UI spawns. It swaps
// `@inquirer/prompts` for bridge-prompts.js, so every question a command asks
// in the terminal is asked in the browser instead. Nothing else is touched:
// the commands themselves run unchanged.

const BRIDGE_URL = new URL("./bridge-prompts.js", import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "@inquirer/prompts") {
    return { url: BRIDGE_URL, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
