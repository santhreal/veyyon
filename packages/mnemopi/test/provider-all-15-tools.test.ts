import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleToolCall, TOOLS } from "@veyyon/mnemopi/mcp-tools";

let dataDir: string;

beforeEach(() => {
	dataDir = mkdtempSync(join(tmpdir(), "mnemopi-provider-tools-"));
	process.env.MNEMOPI_DATA_DIR = dataDir;
	process.env.MNEMOPI_NO_EMBEDDINGS = "1";
	delete process.env.MNEMOPI_MCP_BANK;
});

afterEach(() => {
	rmSync(dataDir, { recursive: true, force: true });
	delete process.env.MNEMOPI_DATA_DIR;
	delete process.env.MNEMOPI_NO_EMBEDDINGS;
	delete process.env.MNEMOPI_MCP_BANK;
});

function toolNames(): Set<string> {
	return new Set(TOOLS.map(tool => tool.name));
}

describe("all provider-compatible MCP tools", () => {
	it("registers all 23 real tool names", () => {
		const names = toolNames();
		expect(names.size).toBe(23);
		for (const name of [
			"mnemopi_remember",
			"mnemopi_recall",
			"mnemopi_sleep",
			"mnemopi_stats",
			"mnemopi_invalidate",
			"mnemopi_validate",
			"mnemopi_get",
			"mnemopi_triple_add",
			"mnemopi_triple_query",
			"mnemopi_scratchpad_write",
			"mnemopi_scratchpad_read",
			"mnemopi_scratchpad_clear",
			"mnemopi_export",
			"mnemopi_update",
			"mnemopi_forget",
			"mnemopi_import",
			"mnemopi_diagnose",
			"mnemopi_shared_remember",
			"mnemopi_shared_recall",
			"mnemopi_shared_forget",
			"mnemopi_shared_stats",
			"mnemopi_graph_query",
			"mnemopi_graph_link",
		]) {
			expect(names.has(name)).toBe(true);
		}
	});

	it("rejects unknown tools", async () => {
		await expect(handleToolCall("mnemopi_nonexistent", {})).rejects.toThrow("Unknown tool");
	});
});

describe("representative provider-compatible handlers", () => {
	it("stores, recalls, reads stats, updates, gets, invalidates, and forgets", async () => {
		const remembered = await handleToolCall("mnemopi_remember", {
			content: "Provider handler stores durable espresso preference",
			importance: 0.7,
			bank: "provider",
		});
		const memoryId = remembered.memory_id as string;
		expect(remembered.status).toBe("stored");
		expect(memoryId).toHaveLength(16);

		const recalled = await handleToolCall("mnemopi_recall", {
			query: "espresso preference",
			limit: 5,
			bank: "provider",
		});
		expect(recalled.status).toBe("ok");
		expect(recalled.count as number).toBeGreaterThanOrEqual(1);

		const updated = await handleToolCall("mnemopi_update", {
			memory_id: memoryId,
			content: "Provider handler stores durable tea preference",
			bank: "provider",
		});
		expect(updated.status).toBe("updated");
		const got = await handleToolCall("mnemopi_get", { memory_id: memoryId, bank: "provider" });
		expect(got.status).toBe("ok");
		expect(JSON.stringify(got.memory)).toContain("tea preference");

		const stats = await handleToolCall("mnemopi_stats", { bank: "provider" });
		expect(stats.status).toBe("ok");
		expect(stats.working).toBeDefined();

		const invalidated = await handleToolCall("mnemopi_invalidate", {
			memory_id: memoryId,
			bank: "provider",
		});
		expect(invalidated.status).toBe("invalidated");
		const forgotten = await handleToolCall("mnemopi_forget", { memory_id: memoryId, bank: "provider" });
		expect(forgotten.status).toBe("deleted");
	});

	it("handles sleep and scratchpad operations", async () => {
		const write = await handleToolCall("mnemopi_scratchpad_write", {
			content: "provider scratch",
			bank: "provider",
		});
		expect(write.status).toBe("written");
		const read = await handleToolCall("mnemopi_scratchpad_read", { bank: "provider" });
		expect(read.entries_count as number).toBe(1);
		const clear = await handleToolCall("mnemopi_scratchpad_clear", { bank: "provider" });
		expect(clear.status).toBe("cleared");
		const sleep = await handleToolCall("mnemopi_sleep", { dry_run: true, bank: "provider" });
		expect(sleep.status).toBe("ok");
		expect(sleep.dry_run).toBe(true);
	});

	it("handles bank-isolated operations", async () => {
		await handleToolCall("mnemopi_remember", {
			content: "only alpha bank contains apricot",
			bank: "alpha",
		});
		const alpha = await handleToolCall("mnemopi_recall", { query: "apricot", bank: "alpha" });
		const beta = await handleToolCall("mnemopi_recall", { query: "apricot", bank: "beta" });
		expect(alpha.count as number).toBeGreaterThanOrEqual(1);
		expect(beta.count).toBe(0);
	});

	it("handles triple and shared-surface tools", async () => {
		const triple = await handleToolCall("mnemopi_triple_add", {
			subject: "user",
			predicate: "prefers",
			object: "oolong",
			bank: "provider",
		});
		expect(triple.status).toBe("stored");
		const triples = await handleToolCall("mnemopi_triple_query", {
			subject: "user",
			predicate: "prefers",
			bank: "provider",
		});
		expect(triples.results_count as number).toBeGreaterThanOrEqual(1);

		const shared = await handleToolCall("mnemopi_shared_remember", {
			content: "User prefers concise answers",
			kind: "preference",
		});
		expect(shared.status).toBe("stored_shared");
		const sharedRecall = await handleToolCall("mnemopi_shared_recall", { query: "concise answers" });
		expect(sharedRecall.count as number).toBeGreaterThanOrEqual(1);
		const sharedStats = await handleToolCall("mnemopi_shared_stats", {});
		expect(sharedStats.provider).toBe("mnemopi_shared");
	});

	it("labels shared surface memories by kind and passes pre-labelled content through", async () => {
		for (const [kind, prefix] of [
			["preference", "Surface preference:"],
			["correction", "Surface correction:"],
			["identity", "Surface identity:"],
			["meta", "Surface meta:"],
		] as const) {
			const res = await handleToolCall("mnemopi_shared_remember", { content: `note ${kind}`, kind });
			expect(res.status).toBe("stored_shared");
			expect(res.kind).toBe(kind);
			expect(res.content_preview).toBe(`${prefix} note ${kind}`);
		}

		// Content already carrying its surface label is stored verbatim, not double-labelled.
		const preLabelled = await handleToolCall("mnemopi_shared_remember", {
			content: "Surface meta: already tagged",
			kind: "meta",
		});
		expect(preLabelled.content_preview).toBe("Surface meta: already tagged");
	});

	it("updates and rejects unknown memories through the validate tool", async () => {
		const stored = await handleToolCall("mnemopi_remember", { content: "Original text", source: "test" });
		const memoryId = stored.memory_id as string;

		const updated = await handleToolCall("mnemopi_validate", {
			memory_id: memoryId,
			action: "update",
			new_content: "Updated text",
			validator: "ada",
		});
		expect(updated.status).toBe("validation_update");
		expect(updated.previous_content).toBe("Original text");
		expect(updated.validator).toBe("ada");
		const got = await handleToolCall("mnemopi_get", { memory_id: memoryId });
		expect((got.memory as { content: string }).content).toBe("Updated text");

		const missing = await handleToolCall("mnemopi_validate", {
			memory_id: "deadbeefdeadbeef",
			action: "update",
			new_content: "x",
		});
		expect(missing.error).toBe("memory_not_found");
	});
});
