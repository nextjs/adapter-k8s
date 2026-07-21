import { describe, expect, it } from "vitest";
import {
  renderValkeyEnv,
  renderValkeySecret,
  VALKEY_AUTH_KEY,
  VALKEY_CA_KEY,
  VALKEY_URL_KEY,
} from "../../../src/emit/templates/valkey-secret.js";

describe("renderValkeySecret", () => {
  it("renders url only by default", () => {
    const yaml = renderValkeySecret({ releaseName: "my-app", url: "redis://10.0.0.1:6379" });
    expect(yaml).toContain(`${VALKEY_URL_KEY}: "redis://10.0.0.1:6379"`);
    expect(yaml).not.toContain(VALKEY_AUTH_KEY);
    expect(yaml).not.toContain(VALKEY_CA_KEY);
  });

  it("includes the AUTH string when provided", () => {
    const yaml = renderValkeySecret({
      releaseName: "my-app",
      url: "rediss://10.0.0.1:6379",
      password: "s3cr3t",
    });
    expect(yaml).toContain(`${VALKEY_AUTH_KEY}: "s3cr3t"`);
  });

  it("includes the server CA when provided (managed AUTH + in-transit encryption)", () => {
    const yaml = renderValkeySecret({
      releaseName: "my-app",
      url: "rediss://10.0.0.1:6379",
      password: "s3cr3t",
      ca: "-----BEGIN CERTIFICATE-----\nABC\n-----END CERTIFICATE-----\n",
    });
    // JSON-quoted so the multi-line PEM survives as a single YAML scalar.
    expect(yaml).toContain(
      `${VALKEY_CA_KEY}: "-----BEGIN CERTIFICATE-----\\nABC\\n-----END CERTIFICATE-----\\n"`,
    );
  });
});

describe("renderValkeyEnv", () => {
  it("injects VALKEY_URL / VALKEY_AUTH / VALKEY_CA_CERT as optional secret refs", () => {
    const env = renderValkeyEnv("my-app", "  ");
    for (const name of ["VALKEY_URL", "VALKEY_AUTH", "VALKEY_CA_CERT"]) {
      expect(env).toContain(`- name: ${name}`);
    }
    expect(env).toContain(`name: my-app-valkey`);
    expect(env).toContain(`key: ${VALKEY_CA_KEY}`);
    // Every ref is optional so a cache-less deploy never blocks pod startup.
    expect(env.match(/optional: true/g)).toHaveLength(3);
  });
});
