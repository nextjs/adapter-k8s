import http from "node:http";
import { once } from "node:events";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium } from "../helpers/chromium.js";
import { continuityBuilds } from "../helpers/continuity-builds.js";

// Explicitly provision both builds first. This test only changes its own loopback proxy;
// it never deploys, scales, or edits a cluster. The same builds can run under next start.
const suppliedA = process.env.E2E_CONTINUITY_A;
const suppliedB = process.env.E2E_CONTINUITY_B;
const build = process.env.E2E_CONTINUITY_BUILD === "1";
const retention = process.env.E2E_CONTINUITY_RETENTION === "1";
let prepared: Awaited<ReturnType<typeof continuityBuilds>>;
type Browser = Awaited<ReturnType<typeof chromium>>;
type Page = Awaited<ReturnType<Browser["page"]>>;

describe.skipIf(!build && (!suppliedA || !suppliedB))("browser continuity across builds", () => {
  beforeAll(async () => {
    if (build) prepared = await continuityBuilds();
  }, 20 * 60_000);
  afterAll(async () => {
    await prepared?.cleanup();
  });
  for (const runtime of build ? (retention ? ["pool"] : ["pool", "next"]) : ["supplied"])
    describe(runtime, () => {
      let A: string;
      let B: string;
      let upstream: string;
      let browser: Browser;
      let proxy: http.Server;
      let base: string;
      beforeAll(async () => {
        A = build ? prepared.origins[runtime]!.A : suppliedA!;
        B = build ? prepared.origins[runtime]!.B : suppliedB!;
        upstream = A;
        proxy = http.createServer((req, res) => {
          const target = new URL(req.url!, upstream);
          const request = http.request(
            target,
            { method: req.method, headers: req.headers },
            (response) => {
              res.writeHead(response.statusCode!, response.headers);
              response.pipe(res);
            },
          );
          request.on("error", (error) => {
            if (res.headersSent) return res.destroy(error);
            res.writeHead(502);
            res.end(error.message);
          });
          request.setTimeout(25_000, () => request.destroy(new Error("Origin timed out")));
          res.on("close", () => request.destroy());
          req.pipe(request);
        });
        proxy.listen(0, "127.0.0.1");
        await once(proxy, "listening");
        const address = proxy.address() as import("node:net").AddressInfo;
        base = `http://127.0.0.1:${address.port}`;
        browser = await chromium();
      });
      afterAll(async () => {
        await browser?.close();
        proxy?.closeAllConnections();
        if (proxy) await new Promise<void>((resolve) => proxy.close(() => resolve()));
      });

      async function acrossBuilds(
        interact: (page: Page, from: string, to: string) => Promise<void>,
      ) {
        upstream = A!;
        const errors: unknown[] = [];
        for (const [from, to, origin] of [
          ["A", "B", B!],
          ["B", "A", A!],
        ]) {
          const page = await browser.page(`${base}/continuity`);
          await page.waitFor(
            'document.querySelector("[data-testid=continuity]")?.dataset.hydrated === "true"',
          );
          expect(
            await page.evaluate(
              'document.querySelector("[data-testid=continuity-version]")?.textContent',
            ),
          ).toBe(from);
          upstream = origin;
          try {
            await interact(page, from, to);
          } catch (error) {
            console.log(
              JSON.stringify({
                requests: page.requests.filter((r) => r.type === "Fetch"),
                document: await page.evaluate("document.body.innerText.slice(0, 400)"),
              }),
            );
            errors.push(error);
          } finally {
            console.log(
              JSON.stringify({ transition: `${from}->${to}`, browserFailures: page.failures }),
            );
          }
        }
        if (errors.length) throw new AggregateError(errors, errors.map(String).join("\n"));
      }

      it("navigates in an already-open tab after promotion and rollback", async () => {
        await acrossBuilds(async (page, _from, to) => {
          const expected = to;
          await page.evaluate(
            'document.querySelector("[data-testid=continuity-navigate]").click()',
          );
          await page.waitFor(
            `document.querySelector("[data-testid=continuity-destination]")?.textContent === ${JSON.stringify(expected)}`,
          );
          expect(
            await page.evaluate(
              'document.querySelector("[data-testid=continuity-destination]").textContent',
            ),
          ).toBe(expected);
        });
      }, 60_000);

      it("loads a previously unrequested chunk, or recovers to a usable current page", async () => {
        await acrossBuilds(async (page, from, to) => {
          expect(
            await page.evaluate('document.querySelector("[data-testid=continuity-lazy-version]")'),
          ).toBeNull();
          const previousScripts = new Set(
            page.requests
              .filter((request) => request.type === "Script")
              .map((request) => request.url),
          );
          const beforeClick = page.requests.length;
          await page.evaluate('document.querySelector("[data-testid=continuity-load]").click()');
          // Next may recover from a missing old chunk with a hard navigation. Accept that
          // documented state-loss boundary, but require a hydrated page and a usable retry.
          await page.waitFor(
            `document.querySelector("[data-testid=continuity-lazy-version]")?.textContent === ${JSON.stringify(from)} || (document.querySelector("[data-testid=continuity-version]")?.textContent === ${JSON.stringify(to)} && document.querySelector("[data-testid=continuity]")?.dataset.hydrated === "true")`,
          );
          const current = await page.evaluate(
            'document.querySelector("[data-testid=continuity-version]").textContent',
          );
          await page.evaluate('document.querySelector("[data-testid=continuity-load]").click()');
          await page.waitFor(
            `document.querySelector("[data-testid=continuity-lazy-version]")?.textContent === ${JSON.stringify(current)}`,
          );
          expect(
            await page.evaluate(
              'document.querySelector("[data-testid=continuity-lazy-version]").textContent',
            ),
          ).toBe(current);
          expect(
            page.requests
              .slice(beforeClick)
              .some((request) => request.type === "Script" && !previousScripts.has(request.url)),
          ).toBe(true);
        });
      }, 60_000);
      it("handles an old Server Action without silently replaying a mutation", async () => {
        await acrossBuilds(async (page, from, to) => {
          const expected = retention ? from : to;
          await page.send("Network.clearBrowserCookies");
          await page.evaluate('document.querySelector("[data-testid=continuity-submit]").click()');
          await page.waitFor(
            `document.querySelector("[data-testid=continuity-result]")?.textContent === ${JSON.stringify(expected + ":1:draft")} || (document.querySelector("[data-testid=continuity-version]")?.textContent === ${JSON.stringify(to)} && document.querySelector("[data-testid=continuity]")?.dataset.hydrated === "true")`,
          );
          if (
            (await page.evaluate(
              'document.querySelector("[data-testid=continuity-result]")?.textContent',
            )) === ""
          ) {
            await page.evaluate(
              'document.querySelector("[data-testid=continuity-submit]").click()',
            );
          }
          await page.waitFor(
            `document.querySelector("[data-testid=continuity-result]")?.textContent === ${JSON.stringify(expected + ":1:draft")}`,
          );
          expect(
            await page.evaluate(
              'document.querySelector("[data-testid=continuity-result]").textContent',
            ),
          ).toBe(expected + ":1:draft");
        });
      }, 60_000);

      it("executes a current-build Server Action exactly once", async () => {
        for (const [marker, origin] of [
          ["A", A],
          ["B", B],
        ]) {
          upstream = origin;
          const page = await browser.page(`${base}/continuity`);
          await page.waitFor(
            'document.querySelector("[data-testid=continuity]")?.dataset.hydrated === "true"',
          );
          await page.send("Network.clearBrowserCookies");
          await page.evaluate('document.querySelector("[data-testid=continuity-submit]").click()');
          await page.waitFor(
            `document.querySelector("[data-testid=continuity-result]")?.textContent === ${JSON.stringify(marker + ":1:draft")}`,
          );
          expect(
            await page.evaluate(
              'document.querySelector("[data-testid=continuity-result]").textContent',
            ),
          ).toBe(marker + ":1:draft");
        }
      }, 60_000);
    });
});
