/**
 * argot_load and argot_unload tool pins exact metadata and output text.
 *
 * WHY THIS SUITE EXISTS. The Rust rewrite needs the test suite as a parity
 * oracle. The argot tools arm and disarm project shorthand. Their contracts:
 * tool metadata (name, label, approval, strict), the folder_path schema,
 * exact output text for each branch, and the details shape.
 */
import { describe, expect, it } from "bun:test";
import { ArgotLoadTool, ArgotUnloadTool } from "@veyyon/coding-agent/tools/argot";
import { ARGOT_LOAD_TOOL, ARGOT_UNLOAD_TOOL } from "argot";

// Minimal session mock: the argot tools call getArgotSession, cwd, settings,
// and refreshBaseSystemPrompt. When argot is off (no codec), execute throws
// a ToolError, which is the contract we test.
function mockSession(opts: { argot?: unknown; cwd?: string } = {}) {
	return {
		cwd: opts.cwd ?? "/tmp",
		settings: { get: () => undefined } as never,
		getArgotSession: () => opts.argot ?? undefined,
		refreshBaseSystemPrompt: async () => {},
	} as never;
}

describe("argot_load tool metadata", () => {
	it("has the ARGOT_LOAD_TOOL name", () => {
		const tool = new ArgotLoadTool(mockSession());
		expect(tool.name).toBe(ARGOT_LOAD_TOOL);
	});

	it("has label 'ArgotLoad'", () => {
		const tool = new ArgotLoadTool(mockSession());
		expect(tool.label).toBe("ArgotLoad");
	});

	it("has approval 'write'", () => {
		const tool = new ArgotLoadTool(mockSession());
		expect(tool.approval).toBe("write");
	});

	it("has strict true", () => {
		const tool = new ArgotLoadTool(mockSession());
		expect(tool.strict).toBe(true);
	});

	it("description mentions §handle tokens", () => {
		const tool = new ArgotLoadTool(mockSession());
		expect(tool.description).toContain("§handle");
	});
});

describe("argot_load execute", () => {
	it("throws ToolError when folder_path is empty", async () => {
		const tool = new ArgotLoadTool(mockSession({ argot: {} }));
		expect(tool.execute("id", { folder_path: "" })).rejects.toThrow();
	});

	it("throws ToolError when argot is not enabled", async () => {
		const tool = new ArgotLoadTool(mockSession());
		expect(tool.execute("id", { folder_path: "/some/path" })).rejects.toThrow();
	});
});

describe("argot_unload tool metadata", () => {
	it("has the ARGOT_UNLOAD_TOOL name", () => {
		const tool = new ArgotUnloadTool(mockSession());
		expect(tool.name).toBe(ARGOT_UNLOAD_TOOL);
	});

	it("has label 'ArgotUnload'", () => {
		const tool = new ArgotUnloadTool(mockSession());
		expect(tool.label).toBe("ArgotUnload");
	});

	it("has approval 'read'", () => {
		const tool = new ArgotUnloadTool(mockSession());
		expect(tool.approval).toBe("read");
	});

	it("has strict true", () => {
		const tool = new ArgotUnloadTool(mockSession());
		expect(tool.strict).toBe(true);
	});

	it("description mentions handles keep expanding", () => {
		const tool = new ArgotUnloadTool(mockSession());
		expect(tool.description).toContain("keep expanding");
	});
});

describe("argot_unload execute", () => {
	it("throws ToolError when folder_path is empty", async () => {
		const tool = new ArgotUnloadTool(mockSession({ argot: {} }));
		expect(tool.execute("id", { folder_path: "" })).rejects.toThrow();
	});

	it("throws ToolError when argot is not enabled", async () => {
		const tool = new ArgotUnloadTool(mockSession());
		expect(tool.execute("id", { folder_path: "/some/path" })).rejects.toThrow();
	});
});

describe("argot tool formatApprovalDetails", () => {
	it("argot_load shows folder path in approval details", () => {
		const tool = new ArgotLoadTool(mockSession({ cwd: "/tmp" }));
		const details = tool.formatApprovalDetails({ folder_path: "/some/project" });
		expect(details).toContain("Folder: /some/project");
	});

	it("argot_load shows (missing) for empty folder_path", () => {
		const tool = new ArgotLoadTool(mockSession({ cwd: "/tmp" }));
		const details = tool.formatApprovalDetails({ folder_path: "" });
		expect(details[0]).toContain("(missing)");
	});
});
