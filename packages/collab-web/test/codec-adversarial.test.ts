import { describe, expect, it } from "bun:test";
import { generateRoomKey, importRoomKey, open, seal } from "../src/lib/codec";

/**
 * Collab codec: wrong key / truncated ciphertext must fail closed; round-trip
 * preserves frame type and payload fields.
 */

describe("collab codec adversarial", () => {
	it("generateRoomKey returns 32 distinct-ish random bytes", () => {
		const a = generateRoomKey();
		const b = generateRoomKey();
		expect(a.byteLength).toBe(32);
		expect(b.byteLength).toBe(32);
		// Extremely unlikely two independent keys match.
		expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
	});

	it("importRoomKey rejects wrong lengths with a clear message", () => {
		// Validation is synchronous before the WebCrypto importPromise.
		expect(() => importRoomKey(new Uint8Array(16))).toThrow(/32 bytes/);
		expect(() => importRoomKey(new Uint8Array(0))).toThrow(/32 bytes/);
	});

	it("seal/open round-trips a guest hello-shaped frame", async () => {
		const raw = generateRoomKey();
		const key = await importRoomKey(raw);
		const frame = { t: "hello", proto: 3, write: true } as const;
		const sealed = await seal(key, frame as never);
		expect(sealed.byteLength).toBeGreaterThan(12);
		const opened = await open(key, sealed);
		expect(opened).toEqual(frame);
	});

	it("open fails closed with a different room key", async () => {
		const keyA = await importRoomKey(generateRoomKey());
		const keyB = await importRoomKey(generateRoomKey());
		const sealed = await seal(keyA, { t: "hello", proto: 3 } as never);
		await expect(open(keyB, sealed)).rejects.toThrow();
	});

	it("open fails on truncated ciphertext", async () => {
		const key = await importRoomKey(generateRoomKey());
		const sealed = await seal(key, { t: "hello", proto: 3 } as never);
		const truncated = sealed.slice(0, 8);
		await expect(open(key, truncated)).rejects.toThrow();
	});
});
