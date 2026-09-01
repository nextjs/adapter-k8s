import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

export type InstrumentationStatus = "ok" | "absent" | "registrar-missing" | "failed";

/** Initialize the Node globals Next installs before importing application modules. */
export async function ensureNextNodeEnvironment(
  cwd = process.cwd(),
  component = "pool-server",
): Promise<void> {
  const req = createRequire(path.join(cwd, "package.json"));
  const candidates = [
    "next/setup-node-env",
    "next/dist/build/adapter/setup-node-env.external",
    "next/dist/server/node-environment",
  ];

  for (const candidate of candidates) {
    try {
      req(candidate);
      return;
    } catch {
      // Try the next candidate. Next has moved this entrypoint across supported releases.
    }
  }

  console.warn(
    `[${component}] Could not load Next.js node environment shims from app dependencies — ` +
      `AsyncLocalStorage may not work`,
  );
}

/**
 * Run the app's `instrumentation.js` register hook through Next's own memoized registrar.
 *
 * This ordering is part of the runtime contract, not just startup polish. `next start` reaches
 * `ensureInstrumentationRegistered()` from `NextNodeServer.prepareImpl()` and awaits an async
 * `register()` before its queued requests are handled. A probe with a 1.5 second hook confirmed
 * that the port can bind first, but the first response is held until registration completes.
 * Missing instrumentation is a silent no-op; a rejected registration is memoized and every
 * subsequent Next-owned request returns 500 while the process remains alive.
 *
 * Generated RouteModule entrypoints also call this exact registrar lazily. Resolving it from the
 * application preserves Next's module-level promise, so a pool startup registration and a later
 * route prepare cannot double-start an OTel SDK. Loading the hook ourselves would lose that
 * guarantee as well as Next's post-registration cache-component tracer setup. If a supported Next
 * release ever moves the registrar, leave registration to its lazy route path in pools rather
 * than guessing a second loader; standalone adapter runtimes report the missing registrar but
 * remain available because observability setup must not become a dataplane outage.
 *
 * The result is reported to each runtime's readiness gate. A throwing hook leaves `/healthz`
 * available for diagnosis but `/readyz` false, preventing blue/green cutover to a process whose
 * application routes would all fail. The hook is awaited before serving so an async provider
 * cannot miss early requests or middleware spans.
 */
export async function registerInstrumentationHook(
  cwd: string,
  distDir: string,
  component = "pool-server",
): Promise<InstrumentationStatus> {
  if (!existsSync(path.join(cwd, distDir, "server", "instrumentation.js"))) return "absent";

  const moduleId = "next/dist/server/lib/router-utils/instrumentation-globals.external";
  let ensureInstrumentationRegistered:
    | ((projectDir: string, distDir: string) => Promise<void>)
    | undefined;
  try {
    const appRequire = createRequire(path.join(cwd, "package.json"));
    ({ ensureInstrumentationRegistered } = appRequire(moduleId) as {
      ensureInstrumentationRegistered?: (projectDir: string, distDir: string) => Promise<void>;
    });
  } catch (error) {
    console.error(
      `[${component}] could not load ${moduleId} from the app — instrumentation register() ` +
        `cannot run before startup:`,
      error,
    );
    return "registrar-missing";
  }
  if (typeof ensureInstrumentationRegistered !== "function") {
    console.error(
      `[${component}] ${moduleId} does not export ensureInstrumentationRegistered — ` +
        `instrumentation register() cannot run before startup`,
    );
    return "registrar-missing";
  }

  try {
    await ensureInstrumentationRegistered(cwd, distDir);
    console.log(`[${component}] instrumentation register() completed`);
    return "ok";
  } catch (error) {
    console.error(
      `[${component}] instrumentation register() FAILED — readiness will remain false so this ` +
        `runtime cannot receive application traffic:`,
      error,
    );
    return "failed";
  }
}
