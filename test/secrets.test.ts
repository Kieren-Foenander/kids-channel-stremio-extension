import { describe, expect, it } from "vitest";
import { issueStreamToken, verifyStreamToken } from "../src/secrets";

const configurationSecret = "test-only-configuration-secret-at-least-32-characters";

describe("stream resolution tokens", () => {
  it("binds the torrent and file identity to one Household and expiry", async () => {
    const now = Date.parse("2026-07-30T00:00:00.000Z");
    const expiresAt = now + 60_000;
    const token = await issueStreamToken("household-one", "torrent-123", 7, expiresAt, configurationSecret);

    expect(await verifyStreamToken(token, "household-one", configurationSecret, now)).toEqual({
      expiresAt,
      torrentId: "torrent-123",
      fileId: 7,
    });
    expect(await verifyStreamToken(token, "household-two", configurationSecret, now)).toBeNull();
    const [payload, signature] = token.split(".");
    const forged = `${payload}.${signature.startsWith("A") ? "B" : "A"}${signature.slice(1)}`;
    expect(await verifyStreamToken(forged, "household-one", configurationSecret, now)).toBeNull();
    expect(await verifyStreamToken(token, "household-one", configurationSecret, expiresAt)).toBeNull();
  });

  it("rejects malformed and oversized values without throwing", async () => {
    for (const token of ["", "payload", "payload.signature.extra", "not+base64.signature", "x".repeat(2049)]) {
      expect(await verifyStreamToken(token, "household-one", configurationSecret)).toBeNull();
    }
  });
});
