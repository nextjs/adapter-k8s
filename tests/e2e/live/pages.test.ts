import { describe, expect, it } from "vitest";

const BASE = process.env.E2E_PAGES_BASE_URL?.replace(/\/$/, "");

describe.skipIf(!BASE)("deployed Pages entrypoint fixture", () => {
  it("keeps the Pages data protocol out of root optional catch-all params", async () => {
    const documentResponse = await fetch(`${BASE}/`);
    expect(documentResponse.status).toBe(200);
    const document = await documentResponse.text();
    const buildId = document.match(/"buildId":"([^"]+)"/)?.[1];
    expect(buildId).toBeTruthy();

    const dataResponse = await fetch(`${BASE}/_next/data/${buildId}/index.json`, {
      headers: { "x-nextjs-data": "1" },
    });
    expect(dataResponse.status).toBe(200);
    const data = (await dataResponse.json()) as { pageProps: { slug: string[] | null } };
    expect(data.pageProps.slug).toBeNull();

    const localizedDataResponse = await fetch(`${BASE}/_next/data/${buildId}/fr.json`, {
      headers: { "x-nextjs-data": "1" },
    });
    expect(localizedDataResponse.status).toBe(200);
    const localizedData = (await localizedDataResponse.json()) as {
      pageProps: { slug: string[] | null };
    };
    expect(localizedData.pageProps.slug).toBeNull();
  });

  it("adds the App Router negotiation fields to a static Pages RSC response", async () => {
    const response = await fetch(`${BASE}/static-vary?_rsc=probe`, {
      headers: { rsc: "1" },
    });
    expect(response.status).toBe(200);
    const vary = new Set(
      (response.headers.get("vary") ?? "").split(",").map((value) => value.trim().toLowerCase()),
    );
    expect(vary).toEqual(
      new Set([
        "rsc",
        "next-router-state-tree",
        "next-router-prefetch",
        "next-router-segment-prefetch",
      ]),
    );
  });

  it("renders a custom 404 through /_error with a real 404 status", async () => {
    const response = await fetch(`${BASE}/definitely-missing`);
    expect(response.status).toBe(404);
    expect(await response.text()).toContain("Pages custom 404 through the error entrypoint");
  });

  it("renders a prerendered custom 500 when a Pages entrypoint throws", async () => {
    const response = await fetch(`${BASE}/boom`);
    expect(response.status).toBe(500);
    expect(await response.text()).toContain("Pages custom prerendered 500");
  });
});
