/**
 * reflect tool pins exact metadata, schema, and output text.
 *
 * WHY THIS SUITE EXISTS. The Rust rewrite needs the test suite as a parity
 * oracle. reflect is a discoverable tool that synthesizes answers from
 * long-term memory. Its contracts: tool metadata (name, label, approval,
 * strict, loadMode), the createIf backend gate, and exact output text for
 * empty and non-empty recall results.
 */
import { describe, expect, it } from "bun:test";
import { MemoryReflectTool } from "@veyyon/coding-agent/tools/memory-reflect";

function mockSession(opts: { backend?: string; state?: unknown } = {}) {
	return {
		settings: {
			get: (key: string) => (key === "memory.backend" ? (opts.backend ?? "mnemopi") : undefined),
		} as never,
		getMnemopiSessionState: () => opts.state ?? undefined,
		getHindsightSessionState: () => undefined,
	} as never;
}

describe("reflect tool metadata", () => {
	it("has name 'reflect'", () => {
		const tool = new MemoryReflectTool(mockSession());
		expect(tool.name).toBe("reflect");
	});

	it("has label 'Reflect'", () => {
		const tool = new MemoryReflectTool(mockSession());
		expect(tool.label).toBe("Reflect");
	});

	it("has approval 'read'", () => {
		const tool = new MemoryReflectTool(mockSession());
		expect(tool.approval).toBe("read");
	});

	it("has strict true", () => {
		const tool = new MemoryReflectTool(mockSession());
		expect(tool.strict).toBe(true);
	});

	it("has loadMode 'discoverable'", () => {
		const tool = new MemoryReflectTool(mockSession());
		expect(tool.loadMode).toBe("discoverable");
	});

	it("summary mentions long-term memory", () => {
		const tool = new MemoryReflectTool(mockSession());
		expect(tool.summary).toContain("long-term memory");
	});
});

describe("reflect createIf", () => {
	it("returns null when backend is not hindsight or mnemopi", () => {
		expect(MemoryReflectTool.createIf(mockSession({ backend: "local" }))).toBeNull();
	});

	it("returns a tool when backend is mnemopi", () => {
		const tool = MemoryReflectTool.createIf(mockSession({ backend: "mnemopi" }));
		expect(tool).toBeInstanceOf(MemoryReflectTool);
	});

	it("returns a tool when backend is hindsight", () => {
		const tool = MemoryReflectTool.createIf(mockSession({ backend: "hindsight" }));
		expect(tool).toBeInstanceOf(MemoryReflectTool);
	});
});

describe("reflect execute (mnemopi)", () => {
	it("throws when Mnemopi state is not initialised", async () => {
		const tool = new MemoryReflectTool(mockSession({ backend: "mnemopi", state: undefined }));
		expect(tool.execute("id", { query: "test" })).rejects.toThrow(
			"Mnemopi backend is not initialised",
		);
	});

	it("returns 'No relevant information found' when recall is empty", async () => {
		const state = {
			recallResultsScoped: async () => [],
			formatContextScoped: () => "",
			config: { bank: "bank-1" },
		};
		const tool = new MemoryReflectTool(mockSession({ backend: "mnemopi", state }));
		const result = await tool.execute("id", { query: "test" });
		expect((result.content[0] as { text: string }).text).toBe(
			"No relevant information found to reflect on.",
		);
	});

	it("returns 'Based on recalled memories:' prefix when recall has results", async () => {
		const state = {
			recallResultsScoped: async () => [{ id: "m1", content: "fact" }],
			formatContextScoped: () => "fact",
			config: { bank: "bank-1" },
		};
		const tool = new MemoryReflectTool(mockSession({ backend: "mnemopi", state }));
		const result = await tool.execute("id", { query: "test" });
		expect((result.content[0] as { text: string }).text).toBe(
			"Based on recalled memories:\n\nfact",
		);
	});

	it("combines query and context when context is provided", async () => {
		let capturedQuery = "";
		const state = {
			recallResultsScoped: async (q: string) => {
				capturedQuery = q;
				return [];
			},
			formatContextScoped: () => "",
			config: { bank: "bank-1" },
		};
		const tool = new MemoryReflectTool(mockSession({ backend: "mnemopi", state }));
		await tool.execute("id", { query: "question", context: "extra info" });
		expect(capturedQuery).toBe("question\n\nAdditional context:\nextra info");
	});
});
