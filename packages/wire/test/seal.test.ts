/**
 * The sealed-frame format: `[12B IV][AES-256-GCM ciphertext+tag]`.
 *
 * WHY THIS SUITE EXISTS. The host seals every collab frame and the browser guest opens it, and
 * until this moved into `@veyyon/wire` each side carried its own copy of the whole thing: the
 * algorithm, the IV length, the order of the two parts, and the JSON encoding of the payload. That
 * is the same shape of bug as the peer envelope beside it, with a worse failure: a GCM tag mismatch
 * cannot tell a wrong key from a wrong layout, so a one-side change to the IV length presents as
 * every frame failing to authenticate with nothing to say why, and the natural reading is that the
 * relay or the link is broken.
 *
 * So the assertions here are about the FORMAT rather than about a round trip. A round trip passes
 * under any self-consistent layout, which is exactly the property that stopped being guaranteed
 * when there were two implementations: what has to hold is that the IV is the first twelve bytes,
 * that the rest is the ciphertext, and that bytes sealed by one caller open for another.
 */

import { describe, expect, it } from "bun:test";
import { moduleSpecifiersIn } from "@veyyon/utils/module-reach";
import {
	generateRoomKey,
	generateWriteToken,
	importRoomKey,
	openFrame,
	ROOM_KEY_BYTES,
	SEAL_IV_BYTES,
	sealFrame,
	WRITE_TOKEN_BYTES,
} from "../src/index";

/** A frame shaped like the guest's simplest real one. */
const FRAME = { t: "hello", proto: 1, name: "guest" } as const;

async function freshKey(): Promise<CryptoKey> {
	return importRoomKey(generateRoomKey());
}

describe("the sealed layout", () => {
	/** Twelve bytes, the AES-GCM standard, and the number both sides have to agree on. */
	it("prefixes exactly SEAL_IV_BYTES of IV", () => {
		expect(SEAL_IV_BYTES).toBe(12);
	});

	/**
	 * The total length pins the layout arithmetic: IV, plus the JSON plaintext, plus GCM's 16-byte
	 * tag and nothing else. A framing byte or a length prefix sneaking in would show up here.
	 */
	it("is the IV, the plaintext length, and a 16-byte tag", async () => {
		const key = await freshKey();
		const json = JSON.stringify(FRAME);

		const sealed = await sealFrame(key, FRAME);

		expect(sealed.byteLength).toBe(SEAL_IV_BYTES + new TextEncoder().encode(json).byteLength + 16);
	});

	/**
	 * The IV must be the leading bytes, not trailing, and must be usable as-is: this decrypts the
	 * ciphertext by hand, reading the IV from the front, without going through `openFrame`. If the
	 * order were reversed, `openFrame` would still round trip with itself and this would fail.
	 */
	it("puts the IV first, where a hand-written reader finds it", async () => {
		const raw = generateRoomKey();
		const key = await importRoomKey(raw);
		const sealed = await sealFrame(key, FRAME);

		const iv = new Uint8Array(sealed.subarray(0, SEAL_IV_BYTES));
		const ciphertext = new Uint8Array(sealed.subarray(SEAL_IV_BYTES));
		const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);

		expect(JSON.parse(new TextDecoder().decode(plaintext))).toEqual(FRAME);
	});

	/**
	 * A fresh IV per frame. Reusing an IV under one key is the classic AES-GCM break: two frames
	 * sealed with the same IV leak the XOR of their plaintexts and, worse, allow tag forgery.
	 */
	it("uses a different IV for every frame", async () => {
		const key = await freshKey();

		const ivs = new Set<string>();
		for (let i = 0; i < 64; i++) {
			const sealed = await sealFrame(key, FRAME);
			ivs.add(Array.from(sealed.subarray(0, SEAL_IV_BYTES)).join(","));
		}

		expect(ivs.size).toBe(64);
	});

	/** The payload is JSON, so it must not appear in the clear anywhere in the sealed bytes. */
	it("leaves no plaintext in the sealed frame", async () => {
		const key = await freshKey();

		const sealed = await sealFrame(key, { t: "prompt", text: "SENTINEL_PLAINTEXT" });

		expect(new TextDecoder().decode(sealed)).not.toContain("SENTINEL_PLAINTEXT");
	});
});

describe("opening what the other side sealed", () => {
	/** The whole point: bytes from one caller open for another under the same key. */
	it("round trips a frame", async () => {
		const key = await freshKey();

		const sealed = await sealFrame(key, FRAME);

		expect(await openFrame<typeof FRAME>(key, sealed)).toEqual(FRAME);
	});

	/** Nested structure and unicode survive, since the payload goes through JSON and UTF-8. */
	it("round trips nested structure and non-ASCII text", async () => {
		const key = await freshKey();
		const frame = { t: "snapshot-chunk", entries: [{ role: "user", text: "héllo 🚀 \x00 end" }], final: true };

		expect(await openFrame<typeof frame>(key, await sealFrame(key, frame))).toEqual(frame);
	});

	/** A frame sealed with one room key must not open with another. */
	it("refuses a frame sealed under a different key", async () => {
		const sealed = await sealFrame(await freshKey(), FRAME);
		const other = await freshKey();

		await expect(openFrame(other, sealed)).rejects.toThrow();
	});

	/**
	 * GCM authenticates: a single flipped bit anywhere, IV or ciphertext, must fail rather than
	 * produce a decoded frame. This is what stops the relay from editing traffic it cannot read.
	 */
	it("refuses a frame with any byte altered", async () => {
		const key = await freshKey();
		const sealed = await sealFrame(key, FRAME);

		for (const index of [0, SEAL_IV_BYTES - 1, SEAL_IV_BYTES, sealed.byteLength - 1]) {
			const tampered = new Uint8Array(sealed);
			tampered[index] ^= 0x01;

			await expect(openFrame(key, tampered)).rejects.toThrow();
		}
	});

	/** Truncation to the IV or shorter carries no ciphertext, and says so instead of throwing from WebCrypto. */
	it("rejects input no longer than the IV with a clear message", async () => {
		const key = await freshKey();

		for (const length of [0, 1, SEAL_IV_BYTES]) {
			await expect(openFrame(key, new Uint8Array(length))).rejects.toThrow("Sealed frame too short");
		}
	});

	/**
	 * A sealed frame arriving as a view into a larger read buffer, which is what a socket hands over.
	 * The IV and ciphertext are copied out rather than viewed, so the neighbouring bytes in that
	 * buffer are not fed to WebCrypto along with them.
	 */
	it("opens a frame that arrived at an offset in a larger buffer", async () => {
		const key = await freshKey();
		const sealed = await sealFrame(key, FRAME);
		const backing = new Uint8Array(sealed.byteLength + 20);
		backing.fill(0xab);
		backing.set(sealed, 7);

		expect(await openFrame<typeof FRAME>(key, backing.subarray(7, 7 + sealed.byteLength))).toEqual(FRAME);
	});
});

describe("key and token generation", () => {
	/** 32 bytes: AES-256. WebCrypto would also accept 16 or 24, so a short key imports silently. */
	it("generates a room key of ROOM_KEY_BYTES", () => {
		expect(generateRoomKey().byteLength).toBe(ROOM_KEY_BYTES);
		expect(ROOM_KEY_BYTES).toBe(32);
	});

	it("generates a write token of WRITE_TOKEN_BYTES", () => {
		expect(generateWriteToken().byteLength).toBe(WRITE_TOKEN_BYTES);
		expect(WRITE_TOKEN_BYTES).toBe(16);
	});

	/** Distinct keys per call: a repeated key would make every room readable from any link. */
	it("generates a different key every time", () => {
		const keys = new Set(Array.from({ length: 32 }, () => generateRoomKey().join(",")));

		expect(keys.size).toBe(32);
	});

	/**
	 * The length check on import. A link mangled in transit can produce a shorter key, and AES-128
	 * would accept 16 of those bytes and then fail to open every frame, which reads as a relay fault
	 * rather than a bad link.
	 *
	 * Asserted as a REJECTION, not a synchronous throw: one caller hands the promise straight to the
	 * socket constructor without awaiting it, so a length error thrown synchronously escaped from
	 * there instead of reaching the connection's error path.
	 */
	it("refuses to import a key of the wrong length", async () => {
		for (const length of [0, 16, 24, 31, 33]) {
			await expect(importRoomKey(new Uint8Array(length))).rejects.toThrow(
				`Room key must be ${ROOM_KEY_BYTES} bytes, got ${length}`,
			);
		}
	});

	/** The same failure must not also arrive synchronously, which is what breaks a `.catch()` caller. */
	it("reports a bad length without throwing synchronously", () => {
		const promise = importRoomKey(new Uint8Array(4));

		expect(promise).toBeInstanceOf(Promise);
		promise.catch(() => undefined);
	});

	/**
	 * A key that arrived as a slice of a larger buffer imports the 32 bytes of the slice and not the
	 * buffer around them. Without the copy, WebCrypto reads the whole backing buffer and the room
	 * key becomes whatever else was in that read.
	 */
	it("imports a key that is a view into a larger buffer", async () => {
		const raw = generateRoomKey();
		const backing = new Uint8Array(ROOM_KEY_BYTES + 16);
		backing.fill(0xcd);
		backing.set(raw, 8);

		const fromView = await importRoomKey(backing.subarray(8, 8 + ROOM_KEY_BYTES));
		const fromRaw = await importRoomKey(raw);

		expect(await openFrame<typeof FRAME>(fromRaw, await sealFrame(fromView, FRAME))).toEqual(FRAME);
	});
});

describe("one owner", () => {
	/**
	 * The lock. Both sides bind the frame type and nothing else: a private IV length, algorithm name
	 * or layout reappearing in either module is the drift this move exists to prevent, and it would
	 * present as every frame failing to authenticate rather than as anything that names the cause.
	 */
	it("neither side implements the layout again", async () => {
		const sources = [
			new URL("../../coding-agent/src/collab/crypto.ts", import.meta.url),
			new URL("../../collab-web/src/lib/codec.ts", import.meta.url),
		];

		for (const url of sources) {
			const source = await Bun.file(url).text();

			expect(source).not.toContain("AES-GCM");
			expect(source).not.toContain("getRandomValues");
			expect(source).not.toContain("crypto.subtle");
			expect(moduleSpecifiersIn(source)).toContain("@veyyon/wire");
		}
	});

	/**
	 * Session sharing writes the same `[12B IV][ciphertext]` envelope to a different destination, and
	 * it was writing it a second time by hand, with its own `IV_LENGTH = 12`. That copy is the one
	 * that mattered: the reader is `share-loader.js` in a browser, so a drift between the two would
	 * surface as an already-published link that no longer opens, with the session already gone from
	 * the machine that sealed it.
	 *
	 * The rule here is narrower than the one above, because share legitimately mints its own key: the
	 * link fragment carries a per-share key that has nothing to do with a room. What it must not do
	 * is seal, so `crypto.subtle.encrypt` and a private IV length are what this forbids.
	 */
	it("session sharing seals through wire rather than rebuilding the envelope", async () => {
		const source = await Bun.file(new URL("../../coding-agent/src/export/share.ts", import.meta.url)).text();

		expect(source).not.toContain("crypto.subtle.encrypt");
		expect(source).not.toContain("IV_LENGTH");
		expect(moduleSpecifiersIn(source)).toContain("@veyyon/wire");
	});

	/**
	 * The browser half of the share envelope, which cannot import anything: `share-loader.js` ships
	 * as a plain asset and hardcodes the IV length twice. It is the one copy that has to stay a copy,
	 * so it is pinned against the constant instead, the same way the repo guards its other
	 * cross-language boundaries. A bare literal here means the reader and the writer can disagree
	 * silently, and only a published link would find out.
	 */
	it("pins the browser loader's hardcoded IV length to the constant it cannot import", async () => {
		const source = await Bun.file(
			new URL("../../coding-agent/src/export/html/share-loader.js", import.meta.url),
		).text();

		const lengths = [...source.matchAll(/sealed\.subarray\((?:0,\s*)?(\d+)\)/g)].map(m => Number(m[1]));

		expect(lengths).toEqual([SEAL_IV_BYTES, SEAL_IV_BYTES]);
	});
});
