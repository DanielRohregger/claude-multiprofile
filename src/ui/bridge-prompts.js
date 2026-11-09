// Stand-in for `@inquirer/prompts` when a command runs under the web UI.
//
// Each prompt is sent to the UI server over the IPC channel, shown in the
// browser as a form, and the answer comes back the same way. The command's
// own `validate` callbacks still run here, in the command's process, so an
// invalid answer is sent back to the browser with the same message the
// terminal would show.
//
// Cancelling in the browser rejects with an ExitPromptError, which the CLI
// already treats as a clean Ctrl+C.

let nextId = 1;
const pending = new Map();

function exitPromptError() {
  const e = new Error("User force closed the prompt");
  e.name = "ExitPromptError";
  return e;
}

if (process.send) {
  process.on("message", (msg) => {
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "answer" && pending.has(msg.id)) {
      const { resolve } = pending.get(msg.id);
      pending.delete(msg.id);
      resolve(msg.value);
    } else if (msg.type === "cancel") {
      for (const { reject } of pending.values()) reject(exitPromptError());
      pending.clear();
    }
  });
  // The IPC channel keeps the process alive while it is referenced. Holding
  // it only while a prompt is pending lets the command exit once it is done.
  process.channel?.unref?.();
}

function ask(prompt) {
  if (!process.send) {
    return Promise.reject(new Error("The prompt bridge needs an IPC channel to the claude-multiprofile UI."));
  }
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    process.channel?.ref?.();
    process.send({ type: "prompt", id, ...prompt });
  }).finally(() => {
    if (pending.size === 0) process.channel?.unref?.();
  });
}

export function normalizeChoices(choices = []) {
  return choices
    .filter((c) => c && c.type !== "separator")
    .map((c, index) => {
      if (typeof c !== "object") c = { value: c };
      return {
        index,
        name: c.name ?? String(c.value),
        description: c.description ?? null,
        disabled: c.disabled ? (typeof c.disabled === "string" ? c.disabled : true) : false,
        checked: Boolean(c.checked),
        value: c.value,
      };
    });
}

async function runValidate(validate, value) {
  if (typeof validate !== "function") return null;
  const result = await validate(value);
  if (result === true || result === undefined) return null;
  return typeof result === "string" ? result : "That answer is not valid.";
}

// Ask until the answer converts and validates. Conversion errors and the
// command's own validation messages are both shown on the re-asked prompt.
async function loop(prompt, toValue, validate) {
  let error = null;
  for (;;) {
    const raw = await ask({ ...prompt, error });
    let value;
    try {
      value = toValue(raw);
    } catch (e) {
      error = e.message;
      continue;
    }
    error = await runValidate(validate, value);
    if (!error) return value;
  }
}

// Choices travel to the browser by index, never by value: values can be
// objects, and the browser only needs to say which one was picked.
function publicChoices(choices) {
  return choices.map(({ value: _value, ...rest }) => rest);
}

export async function select(config) {
  const choices = normalizeChoices(config.choices);
  const def =
    choices.find((c) => c.value === config.default && !c.disabled) ?? choices.find((c) => !c.disabled);
  return loop(
    { kind: "select", message: config.message, choices: publicChoices(choices), default: def ? def.index : null },
    (index) => {
      const c = choices.find((x) => x.index === index);
      if (!c || c.disabled) throw new Error("Pick one of the available options.");
      return c.value;
    },
    config.validate
  );
}

export async function checkbox(config) {
  const choices = normalizeChoices(config.choices);
  return loop(
    { kind: "checkbox", message: config.message, choices: publicChoices(choices) },
    (indexes) => {
      if (!Array.isArray(indexes)) throw new Error("Expected a list of choices.");
      const picked = choices.filter((c) => indexes.includes(c.index) && !c.disabled).map((c) => c.value);
      if (config.required && picked.length === 0) throw new Error("Pick at least one.");
      return picked;
    },
    config.validate
  );
}

export async function input(config) {
  const def = config.default ?? "";
  return loop(
    { kind: "input", message: config.message, default: String(def) },
    (raw) => {
      const v = typeof raw === "string" ? raw : "";
      if (v === "" && def !== "") return String(def);
      if (config.required && v.trim() === "") throw new Error("You must provide a value.");
      return v;
    },
    config.validate
  );
}

export async function confirm(config) {
  return loop(
    { kind: "confirm", message: config.message, default: config.default !== false },
    (raw) => Boolean(raw)
  );
}

export async function password(config) {
  return loop(
    { kind: "input", secret: true, message: config.message, default: "" },
    (raw) => String(raw ?? ""),
    config.validate
  );
}

export async function number(config) {
  return loop(
    { kind: "input", message: config.message, default: config.default != null ? String(config.default) : "" },
    (raw) => {
      const n = Number(raw === "" && config.default != null ? config.default : raw);
      if (raw === "" && config.default == null) throw new Error("Enter a number.");
      if (!Number.isFinite(n)) throw new Error("Enter a number.");
      return n;
    },
    config.validate
  );
}

// Not used by the CLI today; mapped onto the closest supported prompt so a
// future command that uses them still works in the UI.
export const rawlist = select;
export const expand = select;
export const editor = input;
export async function search(config) {
  const choices = config.source ? await config.source("", { signal: new AbortController().signal }) : [];
  return select({ ...config, choices });
}

export class Separator {
  constructor(separator = "") {
    this.type = "separator";
    this.separator = separator;
  }
}
