import { describe, expect, it } from "bun:test";
import {
	COLLAB_PROMPT_MESSAGE_TYPE,
	COLLAB_PROTO,
	DEFAULT_RELAY_URL,
	DEFAULT_SHARE_URL,
	ENVELOPE_HEADER_LENGTH,
	INTENT_FIELD,
	ROOM_ID_BYTES,
	ROOM_KEY_BYTES,
	WRITE_TOKEN_BYTES,
} from "../src";

/**
 * Host, guest, and relay clients import these numbers as the collab link
 * grammar. A silent bump of COLLAB_PROTO or key lengths without coordinated
 * clients bricks live sessions — keep the values exact.
 */
describe("collab wire constants", () => {
	it("exports the protocol constants consumed by host, guest, and relay links", () => {
		expect(COLLAB_PROTO).toBe(3);
		expect(COLLAB_PROMPT_MESSAGE_TYPE).toBe("collab-prompt");
		expect(ENVELOPE_HEADER_LENGTH).toBe(4);
		expect(ROOM_ID_BYTES).toBe(16);
		expect(DEFAULT_RELAY_URL).toBe("wss://share.veyyon.dev");
	});

	it("locks crypto and share URL sizes used when minting/parsing collab links", () => {
		expect(ROOM_KEY_BYTES).toBe(32); // AES-256-GCM
		expect(WRITE_TOKEN_BYTES).toBe(16);
		// Full link material is key ∥ token (bytes), not a free-form string.
		expect(ROOM_KEY_BYTES + WRITE_TOKEN_BYTES).toBe(48);
		expect(INTENT_FIELD).toBe("i");
		expect(DEFAULT_SHARE_URL).toBe("https://share.veyyon.dev/s");
		// Relay and share hosts stay under the same apex so link docs stay consistent.
		expect(new URL(DEFAULT_RELAY_URL).hostname).toBe("share.veyyon.dev");
		expect(new URL(DEFAULT_SHARE_URL).hostname).toBe("share.veyyon.dev");
	});

	it("uses wss for the default relay (never plaintext ws)", () => {
		expect(DEFAULT_RELAY_URL.startsWith("wss://")).toBe(true);
		expect(DEFAULT_SHARE_URL.startsWith("https://")).toBe(true);
	});
});

