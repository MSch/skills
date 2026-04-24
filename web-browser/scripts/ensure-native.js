#!/usr/bin/env node

import { mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = join(root, "native", "pidfd_watcher.c");
const output = join(root, "build", "Release", "pidfd_watcher.node");
const nodeRoot = dirname(dirname(process.execPath));
const includeDir = join(nodeRoot, "include", "node");
const headers = [
  join(includeDir, "node_api.h"),
  join(includeDir, "js_native_api.h"),
  join(includeDir, "uv.h"),
];

function mtimeMs(path) {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

function needsBuild() {
  const outputMtime = mtimeMs(output);
  if (outputMtime === null) return true;

  for (const input of [source, ...headers]) {
    const inputMtime = mtimeMs(input);
    if (inputMtime === null || inputMtime > outputMtime) return true;
  }

  return false;
}

if (needsBuild()) {
  mkdirSync(dirname(output), { recursive: true });
  const result = spawnSync(
    "cc",
    [
      "-shared",
      "-fPIC",
      "-O2",
      "-Wall",
      "-Wextra",
      `-I${includeDir}`,
      "-DNAPI_VERSION=10",
      "-DNODE_GYP_MODULE_NAME=pidfd_watcher",
      source,
      "-o",
      output,
    ],
    { stdio: "inherit" },
  );

  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
