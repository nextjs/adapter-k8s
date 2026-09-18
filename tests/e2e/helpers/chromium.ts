import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { execCapture } from "../../../src/cli/exec.js";

/** Private profile and loopback CDP sessions; never attaches to the user's browser. */
export async function chromium() {
  const profile = mkdtempSync(path.join(tmpdir(), "adapter-continuity-chrome-"));
  const controller = new AbortController();
  let exited = false;
  let diagnostics = "";
  const lifetime = execCapture(
    process.env.CHROMIUM_PATH ?? "/usr/bin/chromium",
    [
      "--headless",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--no-first-run",
      "--no-default-browser-check",
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    { timeoutMs: 300_000, signal: controller.signal },
  ).then(
    (r) => {
      exited = true;
      diagnostics = r.stderr;
    },
    (error) => {
      exited = true;
      diagnostics = String(error);
    },
  );
  const sessions: Promise<Awaited<ReturnType<typeof session>>>[] = [];
  const portFile = path.join(profile, "DevToolsActivePort");
  try {
    const deadline = Date.now() + 20_000;
    while (!existsSync(portFile)) {
      if (exited || Date.now() > deadline)
        throw new Error(`Chromium did not start: ${diagnostics}`);
      await delay(50);
    }
  } catch (error) {
    controller.abort();
    await lifetime;
    rmSync(profile, { recursive: true, force: true });
    throw error;
  }
  const port = Number(readFileSync(portFile, "utf8").split("\n")[0]);
  async function session(url: string) {
    const target = (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, {
      method: "PUT",
      signal: AbortSignal.timeout(5000),
    }).then((r) => r.json())) as { webSocketDebuggerUrl: string };
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error("CDP connection timed out"));
      }, 5000);
      socket.addEventListener(
        "open",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      socket.addEventListener(
        "error",
        () => {
          clearTimeout(timer);
          reject(new Error("CDP connection failed"));
        },
        { once: true },
      );
    });
    let sequence = 0;
    const pending = new Map<
      number,
      {
        resolve: (v: any) => void;
        reject: (e: Error) => void;
        timer: ReturnType<typeof setTimeout>;
      }
    >();
    const failures: { type: string; url?: string; status?: number; message?: string }[] = [];
    const requests: { type: string; url: string; method: string; deploymentId?: string }[] = [];
    socket.addEventListener("close", () => {
      for (const request of pending.values()) {
        clearTimeout(request.timer);
        request.reject(new Error("Browser session closed"));
      }
      pending.clear();
    });
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id) {
        const request = pending.get(message.id);
        if (!request) return;
        clearTimeout(request.timer);
        pending.delete(message.id);
        if (message.error) request.reject(new Error(JSON.stringify(message.error)));
        else request.resolve(message.result);
      } else if (message.method === "Network.requestWillBeSent" && requests.length < 500) {
        const { type, request } = message.params;
        requests.push({
          type,
          url: request.url,
          method: request.method,
          deploymentId: request.headers["x-deployment-id"],
        });
      } else if (failures.length < 100) {
        if (message.method === "Runtime.exceptionThrown") {
          const detail = message.params.exceptionDetails;
          failures.push({
            type: "exception",
            message: detail.exception?.description ?? detail.text,
          });
        } else if (
          message.method === "Network.responseReceived" &&
          message.params.response.status >= 400
        ) {
          const { type, response } = message.params;
          failures.push({ type, url: response.url, status: response.status });
        }
      }
    });
    const send = (method: string, params: object = {}): Promise<any> =>
      new Promise((resolve, reject) => {
        if (socket.readyState !== WebSocket.OPEN)
          return reject(new Error("Browser session closed"));
        const id = ++sequence;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`CDP timed out: ${method}`));
        }, 20_000);
        pending.set(id, { resolve, reject, timer });
        socket.send(JSON.stringify({ id, method, params }));
      });
    const evaluate = async (expression: string) => {
      const r = await send("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
      return r.result.value;
    };
    const waitFor = async (expression: string) => {
      const end = Date.now() + 20_000;
      while (Date.now() < end) {
        try {
          if (await evaluate(expression)) return;
        } catch {
          /* A hard navigation replaces the execution context. */
        }
        await delay(100);
      }
      throw new Error(`Browser condition failed: ${expression}\n${JSON.stringify(failures)}`);
    };
    await send("Page.enable");
    await send("Runtime.enable");
    await send("Network.enable");
    // Existing JS stays alive; late assets must come from the actual serving origin.
    await send("Network.setCacheDisabled", { cacheDisabled: true });
    await send("Page.navigate", { url });
    return { evaluate, waitFor, send, failures, requests, close: () => socket.close() };
  }
  return {
    async page(url: string) {
      const p = session(url);
      sessions.push(p);
      return p;
    },
    async close() {
      const pages = await Promise.allSettled(sessions);
      const first = pages.find((p) => p.status === "fulfilled");
      if (first?.status === "fulfilled") {
        try {
          await first.value.send("Browser.close");
        } catch {
          /* Already closed. */
        }
      }
      for (const page of pages) if (page.status === "fulfilled") page.value.close();
      await Promise.race([lifetime, delay(2000)]);
      controller.abort();
      await lifetime;
      rmSync(profile, { recursive: true, force: true });
    },
  };
}
