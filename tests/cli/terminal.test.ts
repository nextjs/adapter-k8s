// tests/cli/terminal.test.ts
import { describe, it, expect } from "vitest";
import { sanitizeForTerminal } from "../../src/cli/terminal.js";

describe("sanitizeForTerminal (L14)", () => {
  it("strips ESC and CSI sequences", () => {
    expect(sanitizeForTerminal("ok\x1b[31mred\x1b[0m")).toBe("ok[31mred[0m");
    expect(sanitizeForTerminal("\x1b[2Jcleared")).toBe("[2Jcleared");
    expect(sanitizeForTerminal("a\x1bb")).toBe("ab");
  });

  it("strips C0 control characters", () => {
    expect(sanitizeForTerminal("a\x00b\x07c\x1fd")).toBe("abcd");
    expect(sanitizeForTerminal("\r\n")).toBe("\n"); // CR stripped, LF kept
  });

  it("strips C1 control characters and DEL", () => {
    expect(sanitizeForTerminal("a\x7Fb")).toBe("ab");
    expect(sanitizeForTerminal("a\u009B[0mb")).toBe("a[0mb"); // U+009B is CSI itself
    expect(sanitizeForTerminal("a\u0080\u009Fb")).toBe("ab");
  });

  it("keeps newlines and tabs", () => {
    expect(sanitizeForTerminal("line1\nline2\tindented")).toBe("line1\nline2\tindented");
  });

  it("leaves normal text untouched", () => {
    expect(sanitizeForTerminal("Error: something failed (exit 1)")).toBe(
      "Error: something failed (exit 1)",
    );
  });
});
