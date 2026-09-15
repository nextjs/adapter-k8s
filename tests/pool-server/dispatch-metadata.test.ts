import { describe, expect, it } from "vitest";
import { parseDispatchExternalRewrite } from "../../src/pool-server/dispatch-metadata.js";

describe("authenticated external rewrite metadata", () => {
  it("accepts only absolute HTTP(S) targets", () => {
    expect(parseDispatchExternalRewrite("https://example.com/api?q=1")).toMatchObject({
      ok: true,
      value: new URL("https://example.com/api?q=1"),
    });
    for (const invalid of ["/relative", "file:///etc/passwd", "https://user:pass@example.com/"]) {
      expect(parseDispatchExternalRewrite(invalid)).toEqual({ ok: false });
    }
  });
});
