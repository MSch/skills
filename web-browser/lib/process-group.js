import { readFileSync, realpathSync } from "node:fs";
import { basename } from "node:path";

const AGENT_NAMES = new Set(["claude", "codex", "pi"]);
const SHELL_NAMES = new Set(["bash", "zsh", "sh"]);

function readText(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

export function readProcessInfo(pid) {
  const stat = readText(`/proc/${pid}/stat`);
  if (!stat) return null;

  const closeParen = stat.lastIndexOf(")");
  const fields = stat.slice(closeParen + 2).split(" ");
  const ppid = Number(fields[1]);
  const comm = readText(`/proc/${pid}/comm`)?.trim() || null;
  const cmdline = (readText(`/proc/${pid}/cmdline`) || "")
    .split("\0")
    .filter(Boolean);

  let exe = null;
  try {
    exe = realpathSync(`/proc/${pid}/exe`);
  } catch {
    // Processes can exit during the walk or hide their executable.
  }

  return {
    pid: Number(pid),
    ppid,
    comm,
    exe,
    exeBase: exe ? basename(exe) : null,
    argv: cmdline,
  };
}

function classify(info) {
  const names = [info.exeBase, info.comm].filter(Boolean);
  if (names.some((name) => AGENT_NAMES.has(name))) return "agent";
  if (names.some((name) => SHELL_NAMES.has(name))) return "shell";
  return null;
}

export function identifyGroupLeader(startPid) {
  let pid = Number(startPid);
  let fallbackShell = null;
  const chain = [];

  while (Number.isInteger(pid) && pid > 1) {
    const info = readProcessInfo(pid);
    if (!info) break;

    const kind = classify(info);
    chain.push({ ...info, kind });

    if (kind === "agent") {
      return {
        id: `${kind}:${info.exeBase || info.comm}:${info.pid}`,
        kind,
        leader: info,
        chain,
      };
    }

    if (kind === "shell" && !fallbackShell) {
      fallbackShell = info;
    }

    pid = info.ppid;
  }

  if (fallbackShell) {
    return {
      id: `shell:${fallbackShell.exeBase || fallbackShell.comm}:${fallbackShell.pid}`,
      kind: "shell",
      leader: fallbackShell,
      chain,
    };
  }

  return {
    id: `process:${startPid}`,
    kind: "process",
    leader: chain[0] || { pid: Number(startPid) },
    chain,
  };
}
