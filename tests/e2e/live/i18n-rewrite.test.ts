import { describe, expect, it } from "vitest";

const BASE = process.env.E2E_I18N_REWRITE_BASE_URL?.replace(/\/$/, "");

describe.skipIf(!BASE)("deployed Pages i18n index-rewrite fixture", () => {
  it.each([
    ["/", "en"],
    ["/nl-NL", "nl-NL"],
  ])("applies the root rewrite for %s", async (pathname, locale) => {
    const response = await fetch(`${BASE}${pathname}`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain(
      JSON.stringify({ locale, slug: ["company", "about-us"] }).replaceAll('"', "&quot;"),
    );
  });
});
