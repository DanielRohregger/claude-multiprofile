// Preloaded with `node --import` in commands the web UI runs.
// See bridge-loader.js for what it does.

import { register } from "node:module";

register("./bridge-loader.js", import.meta.url);
