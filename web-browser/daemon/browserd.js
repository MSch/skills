#!/usr/bin/env node

import net from "node:net";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { connect as connectChrome } from "../lib/chrome-cdp.js";
import { identifyGroupLeader } from "../lib/process-group.js";
import { collectFrames } from "../lib/page-scripts.js";

const DEBUG = process.env.DEBUG === "1";
const log = DEBUG ? (...args) => console.error("[browserd]", ...args) : () => {};

const CHROME_HOST = process.env.AGENT_WEB_CHROME_HOST || "127.0.0.1";
const CHROME_PORT = Number(process.env.AGENT_WEB_CHROME_CDP_PORT || 19339);
const IDLE_TIMEOUT_MS = Number(process.env.AGENT_WEB_IDLE_TIMEOUT_MS || 600000);
const HOME = process.env.HOME || homedir();
const CACHE_ROOT = join(HOME, ".cache", "agent-web");
const PROFILE_DIR = process.env.AGENT_WEB_PROFILE_DIR || join(CACHE_ROOT, "profile");

let chromeProc = null;
let chrome = null;
let chromeConnecting = null;
let startupTabsClosed = false;
let idleTimer = null;

const groups = new Map();
const targetOwners = new Map();
const attachedSessions = new Map();

function clearBrowserState() {
  chrome = null;
  chromeConnecting = null;
  startupTabsClosed = false;
  targetOwners.clear();
  attachedSessions.clear();
  for (const group of groups.values()) {
    group.targets.clear();
    group.activeTargetId = null;
  }
}

function ensureDir(path) {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

function readText(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function readUnifiedCgroup(pid) {
  const data = readText(`/proc/${pid}/cgroup`);
  if (!data) return null;
  for (const line of data.trim().split("\n")) {
    const [hierarchy, controllers, path] = line.split(":");
    if (hierarchy === "0" && controllers === "") return path || null;
  }
  return data.trim().split("\n")[0]?.split(":").at(-1) || null;
}

function ipv4ToProcHex(host) {
  const parts = host.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return null;
  return parts
    .reverse()
    .map((part) => part.toString(16).padStart(2, "0").toUpperCase())
    .join("");
}

function socketInodesForTcpListener(host, port) {
  const inodes = new Set();
  const expectedPort = Number(port).toString(16).toUpperCase().padStart(4, "0");
  const expectedIpv4 = ipv4ToProcHex(host);

  for (const table of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    const data = readText(table);
    if (!data) continue;

    for (const line of data.trim().split("\n").slice(1)) {
      const fields = line.trim().split(/\s+/);
      const [localAddress, localPort] = fields[1].split(":");
      const state = fields[3];
      const inode = fields[9];

      if (state !== "0A" || localPort !== expectedPort) continue;
      if (expectedIpv4 && table.endsWith("/tcp") && localAddress !== expectedIpv4) continue;
      if (inode) inodes.add(inode);
    }
  }

  return inodes;
}

function findSocketOwnerPid(inodes) {
  if (inodes.size === 0) return null;

  for (const entry of readdirSync("/proc", { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;

    const fdDir = `/proc/${entry.name}/fd`;
    let fds;
    try {
      fds = readdirSync(fdDir);
    } catch {
      continue;
    }

    for (const fd of fds) {
      let target;
      try {
        target = readlinkSync(`${fdDir}/${fd}`);
      } catch {
        continue;
      }
      const match = /^socket:\[(\d+)\]$/.exec(target);
      if (match && inodes.has(match[1])) return Number(entry.name);
    }
  }

  return null;
}

async function assertExistingChromeEndpointOwned() {
  if (!(await isChromeUp())) return false;

  const listenerPid = findSocketOwnerPid(socketInodesForTcpListener(CHROME_HOST, CHROME_PORT));
  if (!listenerPid) {
    throw new Error(
      `Chrome CDP endpoint ${CHROME_HOST}:${CHROME_PORT} is up, but its listener process could not be identified`,
    );
  }

  const daemonCgroup = readUnifiedCgroup(process.pid);
  const listenerCgroup = readUnifiedCgroup(listenerPid);

  if (!daemonCgroup || !listenerCgroup || daemonCgroup !== listenerCgroup) {
    throw new Error(
      `Refusing to reuse Chrome CDP endpoint ${CHROME_HOST}:${CHROME_PORT}: listener pid ${listenerPid} is outside daemon cgroup`,
    );
  }

  return true;
}

function resolveChromeBinary() {
  if (process.env.BROWSER_BIN && existsSync(process.env.BROWSER_BIN)) {
    return process.env.BROWSER_BIN;
  }
  for (const candidate of [
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function chromeEnv() {
  const env = { ...process.env };
  delete env.DBUS_SESSION_BUS_ADDRESS;
  return env;
}

async function isChromeUp() {
  try {
    const response = await fetch(`http://${CHROME_HOST}:${CHROME_PORT}/json/version`, {
      signal: AbortSignal.timeout(1000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function startChrome() {
  if (await assertExistingChromeEndpointOwned()) return;

  ensureDir(PROFILE_DIR);
  for (const staleFile of [
    "SingletonCookie",
    "SingletonLock",
    "SingletonSocket",
    "DevToolsActivePort",
    "DevToolsActivePort.lock",
  ]) {
    rmSync(join(PROFILE_DIR, staleFile), { force: true });
  }

  const chromeBinary = resolveChromeBinary();
  if (!chromeBinary) {
    throw new Error("Could not find Chrome; set BROWSER_BIN=/path/to/chrome");
  }

  chromeProc = spawn(
    chromeBinary,
    [
      `--remote-debugging-address=${CHROME_HOST}`,
      `--remote-debugging-port=${CHROME_PORT}`,
      `--user-data-dir=${PROFILE_DIR}`,
      "--profile-directory=Default",
      "--disable-search-engine-choice-screen",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-features=ProfilePicker",
      "--enable-automation",
    ],
    { env: chromeEnv(), stdio: "ignore" },
  );
  chromeProc.once("exit", () => {
    chromeProc = null;
    clearBrowserState();
  });

  for (let i = 0; i < 60; i++) {
    if (await isChromeUp()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`Failed to start Chrome on ${CHROME_HOST}:${CHROME_PORT}`);
}

async function ensureChrome() {
  if (chrome) {
    if (chrome.isOpen() && (await assertExistingChromeEndpointOwned())) return chrome;
    try {
      chrome.close();
    } catch {
      // ignore
    }
    clearBrowserState();
  }
  if (!chromeConnecting) {
    chromeConnecting = (async () => {
      await startChrome();
      const cdp = await connectChrome({
        host: CHROME_HOST,
        port: CHROME_PORT,
        timeout: 5000,
      });

      cdp.on("CDP.closed", () => {
        clearBrowserState();
      });
      cdp.on("CDP.error", () => {
        clearBrowserState();
      });

      cdp.on("Target.targetCreated", (params) => {
        const info = params.targetInfo;
        if (info?.type === "page" && info.openerId && targetOwners.has(info.openerId)) {
          const groupId = targetOwners.get(info.openerId);
          targetOwners.set(info.targetId, groupId);
          getGroup(groupId).targets.add(info.targetId);
          getGroup(groupId).activeTargetId = info.targetId;
        }
      });

      cdp.on("Target.targetDestroyed", (params) => {
        const groupId = targetOwners.get(params.targetId);
        if (!groupId) return;
        targetOwners.delete(params.targetId);
        const group = groups.get(groupId);
        if (!group) return;
        group.targets.delete(params.targetId);
        if (group.activeTargetId === params.targetId) {
          group.activeTargetId = Array.from(group.targets).at(-1) || null;
        }
      });

      await cdp.send("Target.setDiscoverTargets", { discover: true });
      chrome = cdp;
      return cdp;
    })().finally(() => {
      chromeConnecting = null;
    });
  }
  return chromeConnecting;
}

function getGroup(groupId) {
  if (!groups.has(groupId)) {
    groups.set(groupId, {
      id: groupId,
      targets: new Set(),
      activeTargetId: null,
    });
  }
  return groups.get(groupId);
}

async function listPages(cdp) {
  const { targetInfos } = await cdp.send("Target.getTargets");
  return targetInfos.filter((target) => target.type === "page");
}

async function closeStartupTabs(cdp) {
  if (startupTabsClosed) return;
  startupTabsClosed = true;

  const pages = await listPages(cdp);
  for (const page of pages) {
    if (!targetOwners.has(page.targetId)) {
      try {
        await cdp.send("Target.closeTarget", { targetId: page.targetId }, null, 5000);
      } catch (e) {
        log("failed to close startup tab", page.targetId, e.message);
      }
    }
  }
}

async function createTab(cdp, group, url = "about:blank") {
  const { targetId } = await cdp.send("Target.createTarget", { url }, null, 15000);
  targetOwners.set(targetId, group.id);
  group.targets.add(targetId);
  group.activeTargetId = targetId;
  return targetId;
}

async function getActiveTarget(cdp, group, { create = true } = {}) {
  if (group.activeTargetId && group.targets.has(group.activeTargetId)) {
    return group.activeTargetId;
  }
  const fallback = Array.from(group.targets).at(-1);
  if (fallback) {
    group.activeTargetId = fallback;
    return fallback;
  }
  if (!create) return null;
  const targetId = await createTab(cdp, group);
  await closeStartupTabs(cdp);
  return targetId;
}

async function withSession(cdp, targetId, callback) {
  const { sessionId } = await cdp.send("Target.attachToTarget", {
    targetId,
    flatten: true,
  });
  attachedSessions.set(sessionId, targetId);
  try {
    return await callback(sessionId);
  } finally {
    attachedSessions.delete(sessionId);
    try {
      await cdp.detachFromSession(sessionId);
    } catch {
      // Target may have gone away.
    }
  }
}

function serializeResult(result) {
  if (Array.isArray(result)) {
    return result
      .map((item) =>
        Object.entries(item)
          .map(([key, value]) => `${key}: ${value}`)
          .join("\n"),
      )
      .join("\n\n");
  }
  if (typeof result === "object" && result !== null) {
    return Object.entries(result)
      .map(([key, value]) => `${key}: ${value}`)
      .join("\n");
  }
  return String(result);
}

function armIdleTimer() {
  if (idleTimer) clearTimeout(idleTimer);
  if (!Number.isFinite(IDLE_TIMEOUT_MS) || IDLE_TIMEOUT_MS <= 0) return;
  idleTimer = setTimeout(() => {
    log(`idle for ${IDLE_TIMEOUT_MS}ms; exiting`);
    server.close(() => process.exit(0));
    if (chromeProc) chromeProc.kill();
    setTimeout(() => process.exit(0), 2000).unref();
  }, IDLE_TIMEOUT_MS);
  idleTimer.unref();
}

async function handleRequest(request) {
  armIdleTimer();
  const caller = identifyGroupLeader(request.callerPid || process.ppid);
  const cdp = await ensureChrome();
  const group = getGroup(caller.id);
  const params = request.params || {};

  if (request.method === "status") {
    const pages = await listPages(cdp);
    const ownedPages = pages.filter((page) => group.targets.has(page.targetId));
    const activePage = ownedPages.find((page) => page.targetId === group.activeTargetId);

    return {
      ok: true,
      session: caller.id,
      tabs: ownedPages.length,
      activeUrl: activePage?.url || null,
    };
  }

  if (request.method === "daemonStatus") {
    return {
      chromePort: CHROME_PORT,
      profileDir: PROFILE_DIR,
      group: caller,
      targets: Array.from(group.targets),
      activeTargetId: group.activeTargetId,
    };
  }

  if (request.method === "newTab") {
    const targetId = await createTab(cdp, group, params.url || "about:blank");
    await closeStartupTabs(cdp);
    return { targetId };
  }

  if (request.method === "nav") {
    const targetId = params.newTab
      ? await createTab(cdp, group)
      : await getActiveTarget(cdp, group);
    await closeStartupTabs(cdp);
    await withSession(cdp, targetId, async (sessionId) => {
      await cdp.navigate(sessionId, params.url, 30000);
    });
    group.activeTargetId = targetId;
    return { targetId, url: params.url, newTab: !!params.newTab };
  }

  if (request.method === "eval") {
    const targetId = await getActiveTarget(cdp, group);
    const value = await withSession(cdp, targetId, async (sessionId) => {
      const expression = `(async () => { return (${params.code}); })()`;
      return cdp.evaluate(sessionId, expression, params.timeout || 30000);
    });
    return { value, formatted: serializeResult(value) };
  }

  if (request.method === "pick") {
    const targetId = await getActiveTarget(cdp, group);
    const value = await withSession(cdp, targetId, async (sessionId) => {
      return cdp.evaluate(sessionId, params.expression, params.timeout || 300000);
    });
    return { value, formatted: serializeResult(value) };
  }

  if (request.method === "screenshot") {
    const targetId = await getActiveTarget(cdp, group);
    const data = await withSession(cdp, targetId, async (sessionId) => {
      let screenshotParams = { format: "png" };
      if (params.fullPage) {
        const metrics = await cdp.send("Page.getLayoutMetrics", {}, sessionId, 10000);
        const contentSize = metrics.cssContentSize || metrics.contentSize;
        if (!contentSize) throw new Error("Could not determine page size");
        screenshotParams = {
          ...screenshotParams,
          fromSurface: true,
          captureBeyondViewport: true,
          clip: {
            x: 0,
            y: 0,
            width: Math.max(1, Math.ceil(contentSize.width)),
            height: Math.max(1, Math.ceil(contentSize.height)),
            scale: 1,
          },
        };
      }
      const result = await cdp.send(
        "Page.captureScreenshot",
        screenshotParams,
        sessionId,
        params.fullPage ? 20000 : 10000,
      );
      return result.data;
    });
    return { data };
  }

  if (request.method === "dismissCookies") {
    const targetId = await getActiveTarget(cdp, group);
    const result = await withSession(cdp, targetId, async (sessionId) => {
      await new Promise((resolve) => setTimeout(resolve, 500));
      let clicked = await cdp.evaluate(sessionId, params.mainExpression, 30000);
      if (clicked.length === 0) {
        const frameTree = await cdp.getFrameTree(sessionId);
        for (const frame of collectFrames(frameTree)) {
          if (frame.url === "about:blank" || frame.url.startsWith("javascript:")) continue;
          if (!/(sp_message|consent|privacy|cmp|sourcepoint|cookie|privacy-mgmt)/.test(frame.url)) {
            continue;
          }
          try {
            const frameResult = await cdp.evaluateInFrame(
              sessionId,
              frame.id,
              params.frameExpression,
              30000,
            );
            if (frameResult.length > 0) {
              clicked = frameResult;
              break;
            }
          } catch (e) {
            log("frame dismiss failed", e.message);
          }
        }
      }
      return clicked;
    });
    return { clicked: result };
  }

  throw new Error(`Unknown method: ${request.method}`);
}

function handleSocket(socket) {
  let data = "";
  socket.setEncoding("utf8");
  socket.on("error", (e) => {
    log("socket error", e.message);
  });
  socket.on("data", (chunk) => {
    data += chunk;
  });
  socket.on("end", async () => {
    let request;
    try {
      request = JSON.parse(data.trim());
      const result = await handleRequest(request);
      if (!socket.writableEnded) {
        socket.end(`${JSON.stringify({ id: request.id, ok: true, result })}\n`);
      }
    } catch (e) {
      if (!socket.writableEnded) {
        socket.end(`${JSON.stringify({ id: request?.id || null, ok: false, error: e.message })}\n`);
      }
    }
  });
}

const server = net.createServer({ allowHalfOpen: true }, handleSocket);

if (process.env.LISTEN_FDS === "1") {
  server.listen({ fd: 3 }, () => {
    log("listening on systemd fd 3");
  });
} else {
  const socketPath = process.env.AGENT_WEB_SOCKET;
  if (!socketPath) throw new Error("AGENT_WEB_SOCKET is required outside socket activation");
  ensureDir(dirname(socketPath));
  rmSync(socketPath, { force: true });
  server.listen(socketPath, () => {
    log("listening on", socketPath);
  });
}

process.on("SIGTERM", () => {
  if (idleTimer) clearTimeout(idleTimer);
  server.close(() => process.exit(0));
  if (chromeProc) chromeProc.kill();
});
