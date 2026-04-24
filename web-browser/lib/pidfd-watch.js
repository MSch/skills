import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const addonPath = join(root, "build", "Release", "pidfd_watcher.node");

let addon = null;
let addonError = null;

function loadAddon() {
  if (addon || addonError) return addon;
  if (!existsSync(addonPath)) {
    addonError = new Error(`pidfd addon is not built at ${addonPath}`);
    return null;
  }
  try {
    addon = require(addonPath);
  } catch (e) {
    addonError = e;
  }
  return addon;
}

export function pidfdUnavailableReason() {
  loadAddon();
  return addonError?.message || null;
}

export function watchPidExit(pid, callback) {
  const loaded = loadAddon();
  if (!loaded) return null;
  return loaded.watchPid(pid, (status, message) => {
    callback(status === 0 ? null : new Error(message || `pidfd watcher failed: ${status}`));
  });
}
