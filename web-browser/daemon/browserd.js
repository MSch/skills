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
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { connect as connectChrome } from "../lib/chrome-cdp.js";
import { identifyGroupLeader } from "../lib/process-group.js";
import { pidfdUnavailableReason, watchPidExit } from "../lib/pidfd-watch.js";
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
let pidfdWarningLogged = false;

function clearBrowserState() {
  chrome = null;
  chromeConnecting = null;
  startupTabsClosed = false;
  targetOwners.clear();
  attachedSessions.clear();
  for (const group of groups.values()) {
    group.targets.clear();
    group.activeTargetId = null;
    group.refs.clear();
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

function readJson(path) {
  const text = readText(path);
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value));
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

function prepareChromeProfile() {
  const defaultProfileDir = join(PROFILE_DIR, "Default");
  ensureDir(defaultProfileDir);

  const preferencesPath = join(defaultProfileDir, "Preferences");
  const preferences = readJson(preferencesPath);
  preferences.translate = { ...(preferences.translate || {}), enabled: false };
  preferences.profile = {
    ...(preferences.profile || {}),
    exit_type: "Normal",
    exited_cleanly: true,
  };
  writeJson(preferencesPath, preferences);
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
  prepareChromeProfile();
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
      refs: new Map(),
      leaderPid: null,
      watcher: null,
    });
  }
  return groups.get(groupId);
}

async function closeGroupTargets(groupId, reason) {
  const group = groups.get(groupId);
  if (!group) return;

  if (group.watcher) {
    try {
      group.watcher.close();
    } catch {
      // ignore
    }
    group.watcher = null;
  }

  const targetIds = Array.from(group.targets);
  for (const targetId of targetIds) targetOwners.delete(targetId);
  group.targets.clear();
  group.activeTargetId = null;
  group.refs.clear();
  groups.delete(groupId);

  if (targetIds.length === 0 || !chrome?.isOpen()) return targetIds.length;
  log(`closing ${targetIds.length} target(s) for ${groupId}: ${reason}`);

  await Promise.allSettled(
    targetIds.map(async (targetId) => {
      try {
        await chrome.send("Target.closeTarget", { targetId }, null, 10000);
      } catch (e) {
        log("failed to close target", targetId, e.message);
      }
    }),
  );
  return targetIds.length;
}

function watchGroupLeader(group, caller) {
  const leaderPid = caller.leader?.pid;
  if (!leaderPid || group.leaderPid === leaderPid) return;

  if (group.watcher) {
    try {
      group.watcher.close();
    } catch {
      // ignore
    }
    group.watcher = null;
  }

  let watcher;
  try {
    watcher = watchPidExit(leaderPid, (error) => {
      if (error) {
        log(`pidfd watcher for ${group.id} failed: ${error.message}`);
        return;
      }
      void closeGroupTargets(group.id, `leader pid ${leaderPid} exited`);
    });
  } catch (e) {
    log(`process-exit tab cleanup disabled for ${group.id}: ${e.message}`);
    return;
  }

  if (!watcher) {
    if (!pidfdWarningLogged) {
      pidfdWarningLogged = true;
      log(`process-exit tab cleanup disabled: ${pidfdUnavailableReason()}`);
    }
    return;
  }

  group.leaderPid = leaderPid;
  group.watcher = watcher;
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

function axValue(value) {
  if (!value || typeof value !== "object") return null;
  return value.value ?? null;
}

function formatAxName(node) {
  return axValue(node.name) || axValue(node.value) || "";
}

function interestingAxNode(node) {
  if (!node || node.ignored || !node.backendDOMNodeId) return false;
  const role = axValue(node.role);
  const name = formatAxName(node);
  return Boolean(role && role !== "generic" && role !== "none" && (name || role !== "StaticText"));
}

function buildSnapshot(axNodes, group) {
  const byId = new Map(axNodes.map((node) => [node.nodeId, node]));
  const childIds = new Set();
  for (const node of axNodes) {
    for (const childId of node.childIds || []) childIds.add(childId);
  }

  const roots = axNodes.filter((node) => !childIds.has(node.nodeId));
  const refs = new Map();
  const lines = [];
  let nextRef = 1;

  function visit(node, depth) {
    if (!node) return;

    let nextDepth = depth;
    if (!node.ignored && interestingAxNode(node)) {
      const ref = `@e${nextRef++}`;
      const role = axValue(node.role) || "unknown";
      const name = formatAxName(node);
      refs.set(ref, {
        ref,
        backendDOMNodeId: node.backendDOMNodeId,
        role,
        name,
      });
      const label = name ? ` "${name.replace(/\s+/g, " ").trim()}"` : "";
      lines.push(`${"  ".repeat(depth)}${ref} ${role}${label}`);
      nextDepth = depth + 1;
    }

    for (const childId of node.childIds || []) {
      visit(byId.get(childId), nextDepth);
    }
  }

  for (const root of roots) visit(root, 0);
  group.refs = refs;
  return lines.join("\n");
}

function refInfo(group, locator) {
  if (!locator?.startsWith("@")) return null;
  const ref = locator.startsWith("@e") ? locator : `@${locator}`;
  const info = group.refs.get(ref);
  if (!info) {
    throw new Error(`Unknown ref ${locator}; run snapshot first`);
  }
  return info;
}

async function objectIdForLocator(cdp, sessionId, group, locator) {
  const info = refInfo(group, locator);
  if (info) {
    const { object } = await cdp.send(
      "DOM.resolveNode",
      { backendNodeId: info.backendDOMNodeId },
      sessionId,
      10000,
    );
    return object.objectId;
  }

  const result = await cdp.send(
    "Runtime.evaluate",
    {
      expression: `document.querySelector(${JSON.stringify(locator)})`,
      objectGroup: "agent-web",
    },
    sessionId,
    10000,
  );
  if (!result.result?.objectId) throw new Error(`No element matches selector: ${locator}`);
  return result.result.objectId;
}

async function backendNodeIdForLocator(cdp, sessionId, group, locator) {
  const info = refInfo(group, locator);
  if (info) return info.backendDOMNodeId;

  const { root } = await cdp.send("DOM.getDocument", {}, sessionId, 10000);
  const { nodeId } = await cdp.send(
    "DOM.querySelector",
    { nodeId: root.nodeId, selector: locator },
    sessionId,
    10000,
  );
  if (!nodeId) throw new Error(`No element matches selector: ${locator}`);
  const { node } = await cdp.send("DOM.describeNode", { nodeId }, sessionId, 10000);
  return node.backendNodeId;
}

async function clickLocator(cdp, sessionId, group, locator) {
  const backendNodeId = await backendNodeIdForLocator(cdp, sessionId, group, locator);
  const { model } = await cdp.send("DOM.getBoxModel", { backendNodeId }, sessionId, 10000);
  if (!model?.content?.length) throw new Error(`Element has no clickable box: ${locator}`);
  const xs = [model.content[0], model.content[2], model.content[4], model.content[6]];
  const ys = [model.content[1], model.content[3], model.content[5], model.content[7]];
  const x = (Math.min(...xs) + Math.max(...xs)) / 2;
  const y = (Math.min(...ys) + Math.max(...ys)) / 2;

  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }, sessionId, 10000);
  await cdp.send(
    "Input.dispatchMouseEvent",
    { type: "mousePressed", x, y, button: "left", clickCount: 1 },
    sessionId,
    10000,
  );
  await cdp.send(
    "Input.dispatchMouseEvent",
    { type: "mouseReleased", x, y, button: "left", clickCount: 1 },
    sessionId,
    10000,
  );
}

async function fillLocator(cdp, sessionId, group, locator, value) {
  const objectId = await objectIdForLocator(cdp, sessionId, group, locator);
  const result = await cdp.send(
    "Runtime.callFunctionOn",
    {
      objectId,
      arguments: [{ value }],
      functionDeclaration: `function(value) {
        const el = this;
        el.focus();
        if ("value" in el) {
          el.value = value;
        } else {
          el.textContent = value;
        }
        el.dispatchEvent(new InputEvent("input", { bubbles: true, data: value, inputType: "insertText" }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      }`,
    },
    sessionId,
    10000,
  );
  if (result.exceptionDetails) {
    throw new Error(
      result.exceptionDetails.exception?.description || result.exceptionDetails.text,
    );
  }
}

async function getLocator(cdp, sessionId, group, locator, property) {
  const objectId = await objectIdForLocator(cdp, sessionId, group, locator);
  const result = await cdp.send(
    "Runtime.callFunctionOn",
    {
      objectId,
      arguments: [{ value: property }],
      functionDeclaration: `function(property) {
        if (property === "text") return this.textContent || "";
        if (property === "value") return "value" in this ? this.value : "";
        if (property === "html") return this.outerHTML || "";
        if (property?.startsWith("attr:")) return this.getAttribute(property.slice(5));
        return this[property] ?? this.getAttribute(property) ?? "";
      }`,
      returnByValue: true,
    },
    sessionId,
    10000,
  );
  if (result.exceptionDetails) {
    throw new Error(
      result.exceptionDetails.exception?.description || result.exceptionDetails.text,
    );
  }
  return result.result?.value ?? "";
}

function findRef(group, { role, name }) {
  const normalizedName = name?.toLowerCase();
  for (const info of group.refs.values()) {
    if (role && info.role.toLowerCase() !== role.toLowerCase()) continue;
    if (normalizedName && !info.name.toLowerCase().includes(normalizedName)) continue;
    return info.ref;
  }
  return null;
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
  const params = request.params || {};

  if (request.method === "daemonStatus") {
    return {
      chromePort: CHROME_PORT,
      profileDir: PROFILE_DIR,
      chromeConnected: !!chrome?.isOpen(),
      chromeUp: await isChromeUp(),
      caller,
      clients: Array.from(groups.values()).map((group) => ({
        id: group.id,
        leaderPid: group.leaderPid,
        tabs: group.targets.size,
        activeTargetId: group.activeTargetId,
      })),
    };
  }

  const group = getGroup(caller.id);
  watchGroupLeader(group, caller);
  const cdp = await ensureChrome();

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

  if (request.method === "close") {
    const targetId = await getActiveTarget(cdp, group, { create: false });
    if (!targetId) return { closed: false };
    await cdp.send("Target.closeTarget", { targetId }, null, 10000);
    targetOwners.delete(targetId);
    group.targets.delete(targetId);
    if (group.activeTargetId === targetId) {
      group.activeTargetId = Array.from(group.targets).at(-1) || null;
    }
    return { closed: true };
  }

  if (request.method === "closeSession") {
    const closed = await closeGroupTargets(group.id, "session closed by request");
    return { closed };
  }

  if (request.method === "snapshot") {
    const targetId = await getActiveTarget(cdp, group);
    const text = await withSession(cdp, targetId, async (sessionId) => {
      const { nodes } = await cdp.send("Accessibility.getFullAXTree", {}, sessionId, 20000);
      return buildSnapshot(nodes, group);
    });
    return { text };
  }

  if (request.method === "click") {
    const targetId = await getActiveTarget(cdp, group);
    await withSession(cdp, targetId, async (sessionId) => {
      await clickLocator(cdp, sessionId, group, params.locator);
    });
    return { clicked: true };
  }

  if (request.method === "fill") {
    const targetId = await getActiveTarget(cdp, group);
    await withSession(cdp, targetId, async (sessionId) => {
      await fillLocator(cdp, sessionId, group, params.locator, params.value || "");
    });
    return { filled: true };
  }

  if (request.method === "get") {
    const targetId = await getActiveTarget(cdp, group);
    const value = await withSession(cdp, targetId, async (sessionId) => {
      return getLocator(cdp, sessionId, group, params.locator, params.property || "text");
    });
    return { value };
  }

  if (request.method === "find") {
    if (group.refs.size === 0) {
      const targetId = await getActiveTarget(cdp, group);
      await withSession(cdp, targetId, async (sessionId) => {
        const { nodes } = await cdp.send("Accessibility.getFullAXTree", {}, sessionId, 20000);
        buildSnapshot(nodes, group);
      });
    }
    const ref = findRef(group, params);
    if (!ref) throw new Error("No matching element found");
    if (params.action === "click") {
      const targetId = await getActiveTarget(cdp, group);
      await withSession(cdp, targetId, async (sessionId) => {
        await clickLocator(cdp, sessionId, group, ref);
      });
    }
    return { ref };
  }

  if (request.method === "listTabs") {
    const pages = await listPages(cdp);
    const tabs = pages
      .filter((page) => group.targets.has(page.targetId))
      .map((page, index) => ({
        index: index + 1,
        targetId: page.targetId,
        title: page.title || "",
        url: page.url || "",
        active: page.targetId === group.activeTargetId,
      }));
    return { tabs };
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
