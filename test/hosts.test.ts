import { describe, it, expect } from "vitest";
import { buildRecord, redact, toConn } from "../src/hosts";

const idf = () => "h1";

describe("buildRecord", () => {
  it("creates a password host with defaults", () => {
    const r = buildRecord({ hostname: "h", username: "u", password: "p" }, null, idf);
    expect(r.id).toBe("h1");
    expect(r.auth_kind).toBe("password");
    expect(r.password).toBe("p");
    expect(r.port).toBe(22);
    expect(r.label).toBe("h"); // defaults to hostname
  });

  it("creates a key host with passphrase, port, tags, label", () => {
    const r = buildRecord(
      { hostname: "h", username: "u", private_key: "KEY", passphrase: "pp", port: 2222, label: "L", tags: ["a", "b"] },
      null,
      idf,
    );
    expect(r.auth_kind).toBe("key");
    expect(r.private_key).toBe("KEY");
    expect(r.passphrase).toBe("pp");
    expect(r.port).toBe(2222);
    expect(r.label).toBe("L");
    expect(r.tags).toEqual(["a", "b"]);
  });

  it("creates a vault-key (key_ref) host", () => {
    const r = buildRecord({ hostname: "h", username: "u", key_id: "k-123" }, null, idf);
    expect(r.auth_kind).toBe("key_ref");
    expect(r.key_id).toBe("k-123");
    expect(r.password).toBeUndefined();
    expect(r.private_key).toBeUndefined();
    expect(r.passphrase).toBeUndefined();
  });

  it("requires a credential for a new host", () => {
    expect(() => buildRecord({ hostname: "h", username: "u" }, null, idf)).toThrow(
      /password, a private_key, or a key_id/,
    );
  });

  it("requires hostname and username", () => {
    expect(() => buildRecord({ username: "u", password: "p" }, null, idf)).toThrow(/hostname/);
    expect(() => buildRecord({ hostname: "h", password: "p" }, null, idf)).toThrow(/username/);
  });

  it("rejects an out-of-range port", () => {
    expect(() => buildRecord({ hostname: "h", username: "u", password: "p", port: 99999 }, null, idf)).toThrow(/port/);
  });

  it("keeps the existing secret + id on update when none is provided", () => {
    const existing = buildRecord({ hostname: "h", username: "u", private_key: "KEY" }, null, idf);
    const upd = buildRecord({ label: "New" }, existing, () => "SHOULD_NOT_BE_USED");
    expect(upd.id).toBe(existing.id);
    expect(upd.auth_kind).toBe("key");
    expect(upd.private_key).toBe("KEY");
    expect(upd.label).toBe("New");
  });

  it("switching to a key clears the old password", () => {
    const existing = buildRecord({ hostname: "h", username: "u", password: "p" }, null, idf);
    const upd = buildRecord({ private_key: "KEY" }, existing, idf);
    expect(upd.auth_kind).toBe("key");
    expect(upd.private_key).toBe("KEY");
    expect(upd.password).toBeUndefined();
  });

  it("switching an inline-key host to a vault key drops the key material", () => {
    const existing = buildRecord({ hostname: "h", username: "u", private_key: "KEY", passphrase: "pp" }, null, idf);
    const upd = buildRecord({ key_id: "k-123" }, existing, idf);
    expect(upd.id).toBe(existing.id);
    expect(upd.auth_kind).toBe("key_ref");
    expect(upd.key_id).toBe("k-123");
    expect(upd.private_key).toBeUndefined();
    expect(upd.passphrase).toBeUndefined();
  });

  it("switching a vault-key host back to a password clears the key_id", () => {
    const existing = buildRecord({ hostname: "h", username: "u", key_id: "k-123" }, null, idf);
    const upd = buildRecord({ password: "p" }, existing, idf);
    expect(upd.auth_kind).toBe("password");
    expect(upd.password).toBe("p");
    expect(upd.key_id).toBeUndefined();
  });

  it("keeps the key_id on an unrelated update", () => {
    const existing = buildRecord({ hostname: "h", username: "u", key_id: "k-123" }, null, idf);
    const upd = buildRecord({ label: "New" }, existing, () => "SHOULD_NOT_BE_USED");
    expect(upd.auth_kind).toBe("key_ref");
    expect(upd.key_id).toBe("k-123");
    expect(upd.label).toBe("New");
  });

  it("an inline password still wins over a key_id in the same input", () => {
    const r = buildRecord({ hostname: "h", username: "u", password: "p", key_id: "k-123" }, null, idf);
    expect(r.auth_kind).toBe("password");
    expect(r.key_id).toBeUndefined();
  });
});
describe("redact", () => {
  it("never exposes secrets", () => {
    const r = buildRecord({ hostname: "h", username: "u", password: "s3cret", label: "L" }, null, idf);
    const pub: any = redact(r);
    expect(pub.password).toBeUndefined();
    expect(pub.private_key).toBeUndefined();
    expect(pub.has_secret).toBe(true);
    expect(pub.key_id).toBeNull();
    expect(JSON.stringify(pub)).not.toContain("s3cret");
  });

  it("never exposes an inline key or its passphrase", () => {
    const r = buildRecord({ hostname: "h", username: "u", private_key: "PRIVKEY", passphrase: "pp-s3cret" }, null, idf);
    const pub: any = redact(r);
    expect(pub.has_secret).toBe(true);
    const json = JSON.stringify(pub);
    expect(json).not.toContain("PRIVKEY");
    expect(json).not.toContain("pp-s3cret");
  });

  it("exposes the key_id and resolved name for a vault-key host", () => {
    const r = buildRecord({ hostname: "h", username: "u", key_id: "k-123" }, null, idf);
    const pub: any = redact(r, { "k-123": "deploy key" });
    expect(pub.auth_kind).toBe("key_ref");
    expect(pub.key_id).toBe("k-123");
    expect(pub.key_name).toBe("deploy key");
    expect(pub.has_secret).toBe(true);
  });

  it("falls back to a null key_name when the vault name is unknown", () => {
    const r = buildRecord({ hostname: "h", username: "u", key_id: "k-gone" }, null, idf);
    const pub: any = redact(r);
    expect(pub.key_id).toBe("k-gone");
    expect(pub.key_name).toBeNull();
  });
});

describe("toConn", () => {
  it("builds password auth with pin + timeout", () => {
    const r = buildRecord({ hostname: "h", username: "u", password: "p", port: 2200, known_host: "SHA256:x" }, null, idf);
    const c = toConn(r, 15);
    expect(c).toMatchObject({ host: "h", port: 2200, username: "u", known_host: "SHA256:x", connect_timeout_secs: 15 });
    expect(c.auth).toEqual({ password: "p" });
  });

  it("builds key auth", () => {
    const r = buildRecord({ hostname: "h", username: "u", private_key: "KEY", passphrase: "pp" }, null, idf);
    const c = toConn(r);
    expect(c.auth).toEqual({ private_key: "KEY", passphrase: "pp" });
  });

  it("emits only the key_id for a vault-key host", () => {
    const r = buildRecord({ hostname: "h", username: "u", key_id: "k-123", port: 2200 }, null, idf);
    const c = toConn(r, 15);
    expect(c).toMatchObject({ host: "h", port: 2200, username: "u", connect_timeout_secs: 15 });
    expect(c.auth).toEqual({ key_id: "k-123" });
  });
});
