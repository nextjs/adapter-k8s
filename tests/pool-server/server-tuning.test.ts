// Regression tests from the sibling-adapter survey (plans/lessons-from-sibling-adapters.md,
// Tier 1 #6 and Tier 5 #27): pool-server socket tuning and the Server Action internal origin.
//
// Keep-alive: Node's default keepAliveTimeout is 5s. Envoy (and the GXLB) reuse upstream
// connections with a longer idle timeout, so the pool closing a socket Envoy just picked
// produces intermittent 502s under load and `socket hang up` flakes in e2e runs. The pool
// must hold sockets open LONGER than the proxy's idle timeout (adapter-bun uses 75s), and
// headersTimeout must exceed keepAliveTimeout or Node still reaps the socket between
// requests (headersTimeout fires while a kept-alive socket waits for the next request line).
//
// __NEXT_PRIVATE_ORIGIN: Next's forwarded Server Action redirect fetches against this
// origin. In a multi-replica pool an unset origin lets that internal fetch resolve through
// service DNS to a DIFFERENT pod; it must be pod-local.
import { afterEach, describe, expect, it } from "vitest";
import { createPoolServer } from "../../src/pool-server/server.js";

type Pool = ReturnType<typeof createPoolServer>;
const started: Pool[] = [];

async function startServer(): Promise<{ pool: Pool; port: number }> {
  const pool = createPoolServer({ onRequest: (_req, res) => void res.end("ok"), port: 0 });
  const { port } = await pool.start();
  started.push(pool);
  return { pool, port };
}

afterEach(async () => {
  for (const pool of started.splice(0)) {
    await pool.stop({ graceMs: 50 });
  }
  delete process.env.ADAPTER_K8S_KEEP_ALIVE_TIMEOUT_MS;
  delete process.env.__NEXT_PRIVATE_ORIGIN;
});

describe("keep-alive tuning (survey Tier 1 #6)", () => {
  it("holds keep-alive sockets for 75s, past any sane proxy idle timeout", async () => {
    const { pool } = await startServer();
    expect(pool.server.keepAliveTimeout).toBe(75_000);
  });

  it("keeps headersTimeout strictly above keepAliveTimeout so Node cannot reap a kept-alive socket early", async () => {
    const { pool } = await startServer();
    expect(pool.server.headersTimeout).toBeGreaterThan(pool.server.keepAliveTimeout);
  });

  it("honors ADAPTER_K8S_KEEP_ALIVE_TIMEOUT_MS, keeping the headersTimeout relation", async () => {
    process.env.ADAPTER_K8S_KEEP_ALIVE_TIMEOUT_MS = "120000";
    const { pool } = await startServer();
    expect(pool.server.keepAliveTimeout).toBe(120_000);
    expect(pool.server.headersTimeout).toBeGreaterThan(120_000);
  });
});

describe("__NEXT_PRIVATE_ORIGIN (survey Tier 5 #27)", () => {
  it("is set pod-local (loopback + bound port) once the server is listening", async () => {
    delete process.env.__NEXT_PRIVATE_ORIGIN;
    const { port } = await startServer();
    expect(process.env.__NEXT_PRIVATE_ORIGIN).toBe(`http://127.0.0.1:${port}`);
  });

  it("never overrides an operator-provided origin", async () => {
    process.env.__NEXT_PRIVATE_ORIGIN = "https://public.example.com";
    await startServer();
    expect(process.env.__NEXT_PRIVATE_ORIGIN).toBe("https://public.example.com");
  });
});
