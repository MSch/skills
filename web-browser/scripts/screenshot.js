#!/usr/bin/env node

import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "./cdp.js";

const DEBUG = process.env.DEBUG === "1";
const log = DEBUG ? (...args) => console.error("[debug]", ...args) : () => {};

function printUsage() {
  console.log("Usage: screenshot.js [--full-page]");
  console.log("\nExamples:");
  console.log("  screenshot.js");
  console.log("  screenshot.js --full-page");
}

const args = process.argv.slice(2);
let fullPage = false;

for (let i = 0; i < args.length; i++) {
  const arg = args[i];

  if (arg === "--full-page") {
    fullPage = true;
    continue;
  }

  if (arg === "--help") {
    printUsage();
    process.exit(0);
  }

  console.error(`✗ Unknown argument: ${arg}`);
  printUsage();
  process.exit(1);
}

// Global timeout
const globalTimeout = setTimeout(() => {
  console.error("✗ Global timeout exceeded (30s)");
  process.exit(1);
}, 30000);

let cdp = null;

try {
  log("connecting...");
  cdp = await connect(5000);

  log("getting pages...");
  const pages = await cdp.getPages();
  const page = pages.at(-1);

  if (!page) {
    console.error("✗ No active tab found");
    process.exit(1);
  }

  log("attaching to page...");
  const sessionId = await cdp.attachToPage(page.targetId);

  let params = { format: "png" };

  if (fullPage) {
    log("reading layout metrics...");
    const metrics = await cdp.send("Page.getLayoutMetrics", {}, sessionId, 10000);
    const contentSize = metrics.cssContentSize || metrics.contentSize;

    if (!contentSize) {
      throw new Error("Could not determine page size for full-page screenshot");
    }

    params = {
      ...params,
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

  log("taking screenshot...");
  const { data } = await cdp.send(
    "Page.captureScreenshot",
    params,
    sessionId,
    fullPage ? 20000 : 10000,
  );

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `screenshot-${timestamp}.png`;
  const filepath = join(tmpdir(), filename);

  writeFileSync(filepath, Buffer.from(data, "base64"));
  console.log(filepath);

  log("closing...");
  cdp.close();
  log("done");
} catch (e) {
  console.error("✗", e.message);
  process.exit(1);
} finally {
  clearTimeout(globalTimeout);
  if (cdp) {
    try {
      cdp.close();
    } catch {
      // ignore
    }
  }
  setTimeout(() => process.exit(0), 100);
}
