import net from "node:net";
import { join } from "node:path";

export function defaultSocketPath() {
  if (process.env.AGENT_WEB_SOCKET) return process.env.AGENT_WEB_SOCKET;
  const runtimeDir = process.env.XDG_RUNTIME_DIR;
  if (!runtimeDir) {
    throw new Error("XDG_RUNTIME_DIR is not set; cannot locate agent-web socket");
  }
  return join(runtimeDir, "agent-web", "browser.sock");
}

export function callDaemon(method, params = {}, options = {}) {
  const socketPath = options.socketPath || defaultSocketPath();
  const timeout = options.timeout ?? 45000;
  const request = {
    id: 1,
    method,
    params,
    callerPid: process.pid,
  };

  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath });
    const chunks = [];
    const timeoutId = setTimeout(() => {
      socket.destroy();
      reject(new Error(`daemon RPC timeout: ${method}`));
    }, timeout);

    socket.on("connect", () => {
      socket.end(`${JSON.stringify(request)}\n`);
    });

    socket.on("data", (chunk) => {
      chunks.push(chunk);
    });

    socket.on("end", () => {
      clearTimeout(timeoutId);
      let response;
      try {
        response = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch (e) {
        reject(new Error(`invalid daemon response: ${e.message}`));
        return;
      }

      if (!response.ok) {
        reject(new Error(response.error || `daemon RPC failed: ${method}`));
        return;
      }
      resolve(response.result);
    });

    socket.on("error", (e) => {
      clearTimeout(timeoutId);
      if (e.code === "ENOENT" || e.code === "ECONNREFUSED") {
        reject(
          new Error(
            `agent-web browser daemon is not available at ${socketPath}; enable and start systemd/agent-web-browser.socket`,
          ),
        );
        return;
      }
      reject(e);
    });
  });
}
