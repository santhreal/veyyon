/**
 * memory_edit tool pins exact metadata, schema, and output text.
 *
 * WHY THIS SUITE EXISTS. The Rust rewrite needs the test suite as a parity
 * oracle. memory_edit is a discoverable tool for updating Mnemopi memories.
 * Its contracts: tool metadata (name, label, approval, strict, loadMode),
 * the operation enum, update validation, and exact output text for each
 * status branch.
 */
import { describe, expect, it } from "bun:test";
import { MemoryEditTool } from "@veyyon/coding-agent/tools/memory-edit";
import { MNEMOPI_MEMORY_EDIT_OPERATIONS } from "@veyyon/coding-agent/mnemopi/verbs";

function mockSession(opts: { backend?: string; state?: unknown } = {}) {
	return {
		settings: {
			get: (key: string) => (key === "memory.backend" ? (opts.backend ?? "mnemopi") : undefined),
		} as never,
		getMnemopiSessionState: () => opts.state ?? undefined,
	} as never;
}

describe("memory_edit tool metadata", () => {
	it("has name 'memory_edit'", () => {
		const tool = new MemoryEditTool(mockSession());
		expect(tool.name).toBe("memory_edit");
	});

	it("has label 'Memory Edit'", () => {
		const tool = new MemoryEditTool(mockSession());
		expect(tool.label).toBe("Memory Edit");
	});

	it("has approval 'read'", () => {
		const tool = new MemoryEditTool(mockSession());
		expect(tool.approval).toBe("read");
	});

	it("has strict true", () => {
		const tool = new MemoryEditTool(mockSession());
		expect(tool.strict).toBe(true);
	});

	it("has loadMode 'discoverable'", () => {
		const tool = new MemoryEditTool(mockSession());
		expect(tool.loadMode).toBe("discoverable");
	});

	it("summary mentions Mnemopi memories", () => {
		const tool = new MemoryEditTool(mockSession());
		expect(tool.summary).toContain("Mnemopi");
	});
});

describe("memory_edit createIf", () => {
	it("returns null when backend is not mnemopi", () => {
		expect(MemoryEditTool.createIf(mockSession({ backend: "local" }))).toBeNull();
	});

	it("returns a tool when backend is mnemopi", () => {
		const tool = MemoryEditTool.createIf(mockSession({ backend: "mnemopi" }));
		expect(tool).toBeInstanceOf(MemoryEditTool);
	});
});

describe("memory_edit schema", () => {
	it("op enum matches MNEMOPI_MEMORY_EDIT_OPERATIONS", () => {
		expect(MNEMOPI_MEMORY_EDIT_OPERATIONS).toEqual(["update", "forget", "invalidate"]);
	});
});

describe("memory_edit execute", () => {
	it("throws when Mnemopi state is not initialised", async () => {
		const tool = new MemoryEditTool(mockSession({ state: undefined }));
		expect(tool.execute("id", { op: "forget", id: "mem-1" })).rejects.toThrow(
			"Mnemopi backend is not initialised",
		);
	});

	it("throws when update has no content or importance", async () => {
		const tool = new MemoryEditTool(mockSession({ state: {} }));
		expect(tool.execute("id", { op: "update", id: "mem-1" })).rejects.toThrow(
			"memory_edit update requires content or importance",
		);
	});

	it("returns not_found text when status is not_found", async () => {
		const state = {
			editScopedMemory: () => ({ status: "not_found", bank: "bank-1", store: "store-1" }),
		};
		const tool = new MemoryEditTool(mockSession({ state }));
		const result = await tool.execute("id", { op: "forget", id: "mem-1" });
		expect((result.content[0] as { text: string }).text).toBe(
			"Memory mem-1 was not found in bank bank-1 (store-1).",
		);
	});

	it("returns not_editable text when status is not_editable", async () => {
		const state = {
			editScopedMemory: () => ({ status: "not_editable", bank: "bank-1", store: null }),
		};
		const tool = new MemoryEditTool(mockSession({ state }));
		const result = await tool.execute("id", { op: "forget", id: "mem-1" });
		expect((result.content[0] as { text: string }).text).toBe(
			"Memory mem-1 is a read-only fact in bank bank-1; it cannot be edited. Read it with memory://mem-1.",
		);
	});

	it("returns success text when status is forgotten", async () => {
		const state = {
			editScopedMemory: () => ({ status: "forgotten", bank: null, store: null }),
		};
		const tool = new MemoryEditTool(mockSession({ state }));
		const result = await tool.execute("id", { op: "forget", id: "mem-1" });
		expect((result.content[0] as { text: string }).text).toBe("Memory mem-1 forgotten.");
	});
});
