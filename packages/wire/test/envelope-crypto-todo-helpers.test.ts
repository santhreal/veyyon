import { describe, expect, it } from "bun:test";
import {
	asTodoStatus,
	ENVELOPE_HEADER_LENGTH,
	generateRoomKey,
	generateWriteToken,
	importRoomKey,
	isTerminalTodoStatus,
	isTodoListDone,
	openFrame,
	packEnvelope,
	RECOMMENDED_SUFFIX,
	ROOM_ID_BYTES,
	ROOM_KEY_BYTES,
	rewriteEnvelopePeer,
	SEAL_IV_BYTES,
	sealFrame,
	stripRecommendedSuffix,
	unpackEnvelope,
	WRITE_TOKEN_BYTES,
	withRecommendedSuffix,
} from "../src/index";

describe("ENVELOPE constants", () => {
	it("ENVELOPE_HEADER_LENGTH is 4", () => {
		expect(ENVELOPE_HEADER_LENGTH).toBe(4);
	});
	it("ROOM_ID_BYTES is 16", () => {
		expect(ROOM_ID_BYTES).toBe(16);
	});
	it("ROOM_KEY_BYTES is 32", () => {
		expect(ROOM_KEY_BYTES).toBe(32);
	});
	it("WRITE_TOKEN_BYTES is 16", () => {
		expect(WRITE_TOKEN_BYTES).toBe(16);
	});
	it("SEAL_IV_BYTES is 12", () => {
		expect(SEAL_IV_BYTES).toBe(12);
	});
});

describe("packEnvelope / unpackEnvelope", () => {
	it("packs and unpacks correctly", () => {
		const payload = new Uint8Array([1, 2, 3, 4, 5]);
		const packed = packEnvelope(42, payload);
		expect(packed.byteLength).toBe(ENVELOPE_HEADER_LENGTH + payload.byteLength);
		const unpacked = unpackEnvelope(packed);
		expect(unpacked).not.toBeNull();
		expect(unpacked!.peerId).toBe(42);
		expect(Array.from(unpacked!.payload)).toEqual([1, 2, 3, 4, 5]);
	});
	it("handles zero peerId", () => {
		const payload = new Uint8Array([0xff]);
		const packed = packEnvelope(0, payload);
		const unpacked = unpackEnvelope(packed);
		expect(unpacked!.peerId).toBe(0);
	});
	it("handles max peerId", () => {
		const payload = new Uint8Array([1]);
		const packed = packEnvelope(0xffffffff, payload);
		const unpacked = unpackEnvelope(packed);
		expect(unpacked!.peerId).toBe(0xffffffff);
	});
	it("handles empty payload", () => {
		const payload = new Uint8Array([]);
		const packed = packEnvelope(7, payload);
		expect(packed.byteLength).toBe(ENVELOPE_HEADER_LENGTH);
		const unpacked = unpackEnvelope(packed);
		expect(unpacked!.payload.byteLength).toBe(0);
	});
	it("returns null for data shorter than header", () => {
		expect(unpackEnvelope(new Uint8Array([1, 2, 3]))).toBeNull();
	});
	it("returns null for empty data", () => {
		expect(unpackEnvelope(new Uint8Array([]))).toBeNull();
	});
	it("returns exactly header-length data with empty payload", () => {
		const data = new Uint8Array([0, 0, 0, 5]);
		const unpacked = unpackEnvelope(data);
		expect(unpacked).not.toBeNull();
		expect(unpacked!.peerId).toBe(5);
		expect(unpacked!.payload.byteLength).toBe(0);
	});
});

describe("rewriteEnvelopePeer", () => {
	it("rewrites peerId in place", () => {
		const payload = new Uint8Array([1, 2, 3]);
		const packed = packEnvelope(10, payload);
		rewriteEnvelopePeer(packed, 99);
		const unpacked = unpackEnvelope(packed);
		expect(unpacked!.peerId).toBe(99);
	});
	it("preserves payload after rewrite", () => {
		const payload = new Uint8Array([0xaa, 0xbb]);
		const packed = packEnvelope(1, payload);
		rewriteEnvelopePeer(packed, 2);
		const unpacked = unpackEnvelope(packed);
		expect(Array.from(unpacked!.payload)).toEqual([0xaa, 0xbb]);
	});
});

describe("generateRoomKey / generateWriteToken", () => {
	it("generateRoomKey returns 32 bytes", () => {
		expect(generateRoomKey().byteLength).toBe(32);
	});
	it("generateWriteToken returns 16 bytes", () => {
		expect(generateWriteToken().byteLength).toBe(16);
	});
	it("generateRoomKey produces different values", () => {
		const a = generateRoomKey();
		const b = generateRoomKey();
		expect(Array.from(a)).not.toEqual(Array.from(b));
	});
});

describe("importRoomKey", () => {
	it("imports a valid 32-byte key", async () => {
		const key = await importRoomKey(generateRoomKey());
		expect(key).toBeDefined();
		expect(key.type).toBe("secret");
	});
	it("throws for wrong byte length", async () => {
		expect(importRoomKey(new Uint8Array(16))).rejects.toThrow("Room key must be 32 bytes");
	});
	it("throws for empty key", async () => {
		expect(importRoomKey(new Uint8Array(0))).rejects.toThrow("Room key must be 32 bytes");
	});
});

describe("sealFrame / openFrame", () => {
	it("round-trips a frame", async () => {
		const key = await importRoomKey(generateRoomKey());
		const frame = { t: "prompt", text: "hello" };
		const sealed = await sealFrame(key, frame);
		expect(sealed.byteLength).toBeGreaterThan(SEAL_IV_BYTES);
		const opened = await openFrame<typeof frame>(key, sealed);
		expect(opened).toEqual(frame);
	});
	it("round-trips a complex frame", async () => {
		const key = await importRoomKey(generateRoomKey());
		const frame = { t: "state", state: { agents: [], context: { used: 100, total: 1000 } } };
		const sealed = await sealFrame(key, frame);
		const opened = await openFrame<typeof frame>(key, sealed);
		expect(opened).toEqual(frame);
	});
	it("produces different ciphertexts for same frame (random IV)", async () => {
		const key = await importRoomKey(generateRoomKey());
		const frame = { t: "abort" };
		const a = await sealFrame(key, frame);
		const b = await sealFrame(key, frame);
		expect(Array.from(a)).not.toEqual(Array.from(b));
	});
});

describe("withRecommendedSuffix / stripRecommendedSuffix", () => {
	it("withRecommendedSuffix adds suffix", () => {
		expect(withRecommendedSuffix("Option A")).toBe(`Option A${RECOMMENDED_SUFFIX}`);
	});
	it("withRecommendedSuffix does not double-add", () => {
		expect(withRecommendedSuffix(`Option A${RECOMMENDED_SUFFIX}`)).toBe(`Option A${RECOMMENDED_SUFFIX}`);
	});
	it("stripRecommendedSuffix removes suffix", () => {
		expect(stripRecommendedSuffix(`Option A${RECOMMENDED_SUFFIX}`)).toBe("Option A");
	});
	it("stripRecommendedSuffix leaves non-suffixed unchanged", () => {
		expect(stripRecommendedSuffix("Option A")).toBe("Option A");
	});
	it("round-trips", () => {
		const label = "My Option";
		expect(stripRecommendedSuffix(withRecommendedSuffix(label))).toBe(label);
	});
	it("RECOMMENDED_SUFFIX is ' (Recommended)'", () => {
		expect(RECOMMENDED_SUFFIX).toBe(" (Recommended)");
	});
});

describe("TODO_STATUS_IS_TERMINAL / isTerminalTodoStatus", () => {
	it("pending is not terminal", () => {
		expect(isTerminalTodoStatus("pending")).toBe(false);
	});
	it("in_progress is not terminal", () => {
		expect(isTerminalTodoStatus("in_progress")).toBe(false);
	});
	it("completed is terminal", () => {
		expect(isTerminalTodoStatus("completed")).toBe(true);
	});
	it("abandoned is terminal", () => {
		expect(isTerminalTodoStatus("abandoned")).toBe(true);
	});
});

describe("asTodoStatus", () => {
	it("returns valid status unchanged", () => {
		expect(asTodoStatus("pending")).toBe("pending");
	});
	it("returns in_progress unchanged", () => {
		expect(asTodoStatus("in_progress")).toBe("in_progress");
	});
	it("returns completed unchanged", () => {
		expect(asTodoStatus("completed")).toBe("completed");
	});
	it("returns abandoned unchanged", () => {
		expect(asTodoStatus("abandoned")).toBe("abandoned");
	});
	it("returns pending for unknown string", () => {
		expect(asTodoStatus("unknown")).toBe("pending");
	});
	it("returns pending for non-string", () => {
		expect(asTodoStatus(123)).toBe("pending");
	});
	it("returns pending for undefined", () => {
		expect(asTodoStatus(undefined)).toBe("pending");
	});
	it("returns pending for null", () => {
		expect(asTodoStatus(null)).toBe("pending");
	});
	it("returns pending for object", () => {
		expect(asTodoStatus({})).toBe("pending");
	});
});

describe("isTodoListDone", () => {
	it("returns false for empty phases", () => {
		expect(isTodoListDone([])).toBe(false);
	});
	it("returns false for phases with no tasks", () => {
		expect(isTodoListDone([{}])).toBe(false);
	});
	it("returns false for phases with empty tasks", () => {
		expect(isTodoListDone([{ tasks: [] }])).toBe(false);
	});
	it("returns true when all tasks are completed", () => {
		expect(isTodoListDone([{ tasks: [{ status: "completed" }] }])).toBe(true);
	});
	it("returns true when all tasks are abandoned", () => {
		expect(isTodoListDone([{ tasks: [{ status: "abandoned" }] }])).toBe(true);
	});
	it("returns false when any task is pending", () => {
		expect(isTodoListDone([{ tasks: [{ status: "completed" }, { status: "pending" }] }])).toBe(false);
	});
	it("returns false when any task is in_progress", () => {
		expect(isTodoListDone([{ tasks: [{ status: "completed" }, { status: "in_progress" }] }])).toBe(false);
	});
	it("handles multiple phases all done", () => {
		expect(isTodoListDone([{ tasks: [{ status: "completed" }] }, { tasks: [{ status: "abandoned" }] }])).toBe(true);
	});
	it("handles multiple phases with one not done", () => {
		expect(isTodoListDone([{ tasks: [{ status: "completed" }] }, { tasks: [{ status: "in_progress" }] }])).toBe(
			false,
		);
	});
	it("handles mix of completed and abandoned", () => {
		expect(isTodoListDone([{ tasks: [{ status: "completed" }, { status: "abandoned" }] }])).toBe(true);
	});
	it("handles phase with undefined tasks", () => {
		expect(isTodoListDone([{ tasks: undefined }, { tasks: [{ status: "completed" }] }])).toBe(true);
	});
});
