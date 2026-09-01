import { describe, expect, it } from "bun:test";
import {
	asTodoStatus,
	isTerminalTodoStatus,
	isTodoListDone,
	packEnvelope,
	RECOMMENDED_SUFFIX,
	stripRecommendedSuffix,
	TODO_DONE_SUMMARY,
	TODO_STATUS_IS_TERMINAL,
	TODO_STATUSES,
	unpackEnvelope,
	withRecommendedSuffix,
} from "../src/index";
import {
	isRelayFatalCloseCode,
	RELAY_FATAL_CLOSE_REASONS,
	RELAY_MAX_PENDING_SENDS,
	relayFatalCloseReason,
} from "../src/relay";
import { stripTaskResultEnvelope } from "../src/task-result";

describe("withRecommendedSuffix", () => {
	it("adds suffix when not present", () => {
		expect(withRecommendedSuffix("Option")).toBe("Option (Recommended)");
	});
	it("does not double-add suffix", () => {
		expect(withRecommendedSuffix("Option (Recommended)")).toBe("Option (Recommended)");
	});
	it("handles empty string", () => {
		expect(withRecommendedSuffix("")).toBe(RECOMMENDED_SUFFIX);
	});
});

describe("stripRecommendedSuffix", () => {
	it("strips suffix when present", () => {
		expect(stripRecommendedSuffix("Option (Recommended)")).toBe("Option");
	});
	it("returns unchanged when suffix not present", () => {
		expect(stripRecommendedSuffix("Option")).toBe("Option");
	});
	it("handles empty string", () => {
		expect(stripRecommendedSuffix("")).toBe("");
	});
	it("round-trips with withRecommendedSuffix", () => {
		const label = "My Option";
		expect(stripRecommendedSuffix(withRecommendedSuffix(label))).toBe(label);
	});
});

describe("TODO_STATUS_IS_TERMINAL", () => {
	it("pending is not terminal", () => {
		expect(TODO_STATUS_IS_TERMINAL.pending).toBe(false);
	});
	it("in_progress is not terminal", () => {
		expect(TODO_STATUS_IS_TERMINAL.in_progress).toBe(false);
	});
	it("completed is terminal", () => {
		expect(TODO_STATUS_IS_TERMINAL.completed).toBe(true);
	});
	it("abandoned is terminal", () => {
		expect(TODO_STATUS_IS_TERMINAL.abandoned).toBe(true);
	});
});

describe("TODO_STATUSES", () => {
	it("has 4 statuses", () => {
		expect(TODO_STATUSES).toHaveLength(4);
	});
	it("contains pending", () => {
		expect(TODO_STATUSES).toContain("pending");
	});
	it("contains completed", () => {
		expect(TODO_STATUSES).toContain("completed");
	});
});

describe("isTerminalTodoStatus", () => {
	it("returns false for pending", () => {
		expect(isTerminalTodoStatus("pending")).toBe(false);
	});
	it("returns false for in_progress", () => {
		expect(isTerminalTodoStatus("in_progress")).toBe(false);
	});
	it("returns true for completed", () => {
		expect(isTerminalTodoStatus("completed")).toBe(true);
	});
	it("returns true for abandoned", () => {
		expect(isTerminalTodoStatus("abandoned")).toBe(true);
	});
});

describe("asTodoStatus", () => {
	it("returns valid status as-is", () => {
		expect(asTodoStatus("pending")).toBe("pending");
	});
	it("returns in_progress as-is", () => {
		expect(asTodoStatus("in_progress")).toBe("in_progress");
	});
	it("returns completed as-is", () => {
		expect(asTodoStatus("completed")).toBe("completed");
	});
	it("returns abandoned as-is", () => {
		expect(asTodoStatus("abandoned")).toBe("abandoned");
	});
	it("returns pending for unknown string", () => {
		expect(asTodoStatus("unknown")).toBe("pending");
	});
	it("returns pending for non-string", () => {
		expect(asTodoStatus(42)).toBe("pending");
	});
	it("returns pending for undefined", () => {
		expect(asTodoStatus(undefined)).toBe("pending");
	});
	it("returns pending for null", () => {
		expect(asTodoStatus(null)).toBe("pending");
	});
});

describe("isTodoListDone", () => {
	it("returns true when all tasks are completed", () => {
		expect(isTodoListDone([{ tasks: [{ status: "completed" }, { status: "completed" }] }])).toBe(true);
	});
	it("returns false when any task is pending", () => {
		expect(isTodoListDone([{ tasks: [{ status: "completed" }, { status: "pending" }] }])).toBe(false);
	});
	it("returns false when any task is in_progress", () => {
		expect(isTodoListDone([{ tasks: [{ status: "in_progress" }] }])).toBe(false);
	});
	it("returns true when all tasks are abandoned", () => {
		expect(isTodoListDone([{ tasks: [{ status: "abandoned" }] }])).toBe(true);
	});
	it("returns true with mixed terminal statuses", () => {
		expect(isTodoListDone([{ tasks: [{ status: "completed" }, { status: "abandoned" }] }])).toBe(true);
	});
	it("returns false for empty phases", () => {
		expect(isTodoListDone([])).toBe(false);
	});
	it("returns false for phase with no tasks", () => {
		expect(isTodoListDone([{}])).toBe(false);
	});
	it("returns false for phase with empty tasks array", () => {
		expect(isTodoListDone([{ tasks: [] }])).toBe(false);
	});
	it("handles multiple phases", () => {
		expect(isTodoListDone([{ tasks: [{ status: "completed" }] }, { tasks: [{ status: "completed" }] }])).toBe(true);
	});
	it("returns false when second phase has pending task", () => {
		expect(isTodoListDone([{ tasks: [{ status: "completed" }] }, { tasks: [{ status: "pending" }] }])).toBe(false);
	});
});

describe("TODO_DONE_SUMMARY", () => {
	it("is a non-empty string", () => {
		expect(TODO_DONE_SUMMARY.length).toBeGreaterThan(0);
	});
});

describe("packEnvelope / unpackEnvelope", () => {
	it("packs and unpacks envelope", () => {
		const payload = new Uint8Array([1, 2, 3, 4, 5]);
		const packed = packEnvelope(42, payload);
		const unpacked = unpackEnvelope(packed);
		expect(unpacked).not.toBeNull();
		expect(unpacked!.peerId).toBe(42);
		expect(Array.from(unpacked!.payload)).toEqual([1, 2, 3, 4, 5]);
	});
	it("unpackEnvelope returns null for too-short data", () => {
		expect(unpackEnvelope(new Uint8Array([1, 2]))).toBeNull();
	});
	it("packs with peer id 0", () => {
		const payload = new Uint8Array([0xff]);
		const packed = packEnvelope(0, payload);
		const unpacked = unpackEnvelope(packed);
		expect(unpacked!.peerId).toBe(0);
	});
	it("packs with large peer id", () => {
		const payload = new Uint8Array([1]);
		const packed = packEnvelope(0xffffffff, payload);
		const unpacked = unpackEnvelope(packed);
		expect(unpacked!.peerId).toBe(0xffffffff);
	});
	it("handles empty payload", () => {
		const payload = new Uint8Array(0);
		const packed = packEnvelope(7, payload);
		const unpacked = unpackEnvelope(packed);
		expect(unpacked!.peerId).toBe(7);
		expect(unpacked!.payload.byteLength).toBe(0);
	});
});

describe("relay constants", () => {
	it("RELAY_FATAL_CLOSE_REASONS has 4001", () => {
		expect(RELAY_FATAL_CLOSE_REASONS[4001]).toBe("room closed");
	});
	it("RELAY_FATAL_CLOSE_REASONS has 4004", () => {
		expect(RELAY_FATAL_CLOSE_REASONS[4004]).toBe("no such room");
	});
	it("RELAY_FATAL_CLOSE_REASONS has 4009", () => {
		expect(RELAY_FATAL_CLOSE_REASONS[4009]).toContain("host");
	});
	it("RELAY_FATAL_CLOSE_REASONS has 4029", () => {
		expect(RELAY_FATAL_CLOSE_REASONS[4029]).toContain("full");
	});
	it("RELAY_MAX_PENDING_SENDS is 256", () => {
		expect(RELAY_MAX_PENDING_SENDS).toBe(256);
	});
});

describe("isRelayFatalCloseCode", () => {
	it("returns true for 4001", () => {
		expect(isRelayFatalCloseCode(4001)).toBe(true);
	});
	it("returns true for 4004", () => {
		expect(isRelayFatalCloseCode(4004)).toBe(true);
	});
	it("returns true for 4009", () => {
		expect(isRelayFatalCloseCode(4009)).toBe(true);
	});
	it("returns true for 4029", () => {
		expect(isRelayFatalCloseCode(4029)).toBe(true);
	});
	it("returns false for 1000", () => {
		expect(isRelayFatalCloseCode(1000)).toBe(false);
	});
	it("returns false for 0", () => {
		expect(isRelayFatalCloseCode(0)).toBe(false);
	});
});

describe("relayFatalCloseReason", () => {
	it("returns reason for fatal code", () => {
		expect(relayFatalCloseReason(4001)).toBe("room closed");
	});
	it("returns undefined for non-fatal code", () => {
		expect(relayFatalCloseReason(1000)).toBeUndefined();
	});
});

describe("stripTaskResultEnvelope", () => {
	it("strips output envelope", () => {
		const text = "<task-result><output>\nhello world\n</output></task-result>";
		expect(stripTaskResultEnvelope(text)).toBe("hello world");
	});
	it("strips preview envelope", () => {
		const text = "<task-result><preview>\npreview text\n</preview></task-result>";
		expect(stripTaskResultEnvelope(text)).toBe("preview text");
	});
	it("returns text unchanged when no envelope", () => {
		expect(stripTaskResultEnvelope("hello")).toBe("hello");
	});
	it("returns text unchanged when not starting with task-result", () => {
		expect(stripTaskResultEnvelope("<output>hello</output>")).toBe("<output>hello</output>");
	});
	it("handles output with attributes", () => {
		const text = '<task-result><output lang="en">\nhello\n</output></task-result>';
		expect(stripTaskResultEnvelope(text)).toBe("hello");
	});
	it("returns original text when body is empty", () => {
		const text = "<task-result><output>\n\n</output></task-result>";
		expect(stripTaskResultEnvelope(text)).toBe(text);
	});
	it("handles multiline content", () => {
		const text = "<task-result><output>\nline1\nline2\nline3\n</output></task-result>";
		expect(stripTaskResultEnvelope(text)).toBe("line1\nline2\nline3");
	});
});
