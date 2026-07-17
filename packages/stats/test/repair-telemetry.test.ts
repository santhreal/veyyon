import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	closeDb,
	getToolStats,
	getToolStatsByModel,
	initDb,
	insertToolCalls,
	updateToolResults,
} from "@veyyon/omp-stats/db";
import { parseSessionFile } from "@veyyon/omp-stats/parser";
import type { ToolCallStats } from "@veyyon/omp-stats/types";
import { installStatsTestIsolation } from "./helpers/temp-agent";

installStatsTestIsolation("@pi-stats-repair-");

function call(toolCallId: string, toolName: string, model: string): ToolCallStats {
	return {
		sessionFile: "/tmp/repair-session.jsonl",
		entryId: `entry-${toolCallId}`,
		toolCallId,
		folder: "/tmp/project",
		toolName,
		model,
		provider: "test-provider",
		timestamp: Date.now(),
		agentType: "main",
		callsInTurn: 1,
		argsChars: 10,
	};
}

describe("repair telemetry aggregation (U4-02)", () => {
	it("records repair_status per (model, tool) and aggregates repaired/unrepairable counts", async () => {
		await initDb();

		insertToolCalls([
			call("tc-1", "edit", "model-a"),
			call("tc-2", "edit", "model-a"),
			call("tc-3", "edit", "model-b"),
			call("tc-4", "bash", "model-a"),
		]);
		updateToolResults([
			{
				sessionFile: "/tmp/repair-session.jsonl",
				toolCallId: "tc-1",
				resultChars: 5,
				isError: false,
				repairStatus: "repaired",
			},
			{
				sessionFile: "/tmp/repair-session.jsonl",
				toolCallId: "tc-2",
				resultChars: 5,
				isError: true,
				repairStatus: "unrepairable",
			},
			{
				sessionFile: "/tmp/repair-session.jsonl",
				toolCallId: "tc-3",
				resultChars: 5,
				isError: false,
				repairStatus: "repaired",
			},
			{ sessionFile: "/tmp/repair-session.jsonl", toolCallId: "tc-4", resultChars: 5, isError: false },
		]);

		const edit = getToolStats().find(tool => tool.tool === "edit");
		expect(edit?.calls).toBe(3);
		expect(edit?.repaired).toBe(2);
		expect(edit?.unrepairable).toBe(1);

		const bash = getToolStats().find(tool => tool.tool === "bash");
		expect(bash?.repaired).toBe(0);
		expect(bash?.unrepairable).toBe(0);

		const editModelA = getToolStatsByModel().find(row => row.tool === "edit" && row.model === "model-a");
		expect(editModelA?.calls).toBe(2);
		expect(editModelA?.repaired).toBe(1);
		expect(editModelA?.unrepairable).toBe(1);

		const editModelB = getToolStatsByModel().find(row => row.tool === "edit" && row.model === "model-b");
		expect(editModelB?.repaired).toBe(1);
		expect(editModelB?.unrepairable).toBe(0);

		closeDb();
	});

	it("parser lifts repairStatus off persisted toolResult messages and ignores junk values", async () => {
		const dir = await fs.mkdtemp("/tmp/repair-parse-");
		const sessionPath = path.join(dir, "session.jsonl");
		const entries = [
			{
				type: "message",
				id: "e1",
				parentId: null,
				timestamp: new Date().toISOString(),
				message: {
					role: "assistant",
					model: "model-a",
					provider: "test-provider",
					timestamp: Date.now(),
					usage: {
						input: 1,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 2,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "toolUse",
					content: [{ type: "toolCall", id: "tc-r", name: "edit", arguments: { x: 1 } }],
				},
			},
			{
				type: "message",
				id: "e2",
				parentId: "e1",
				timestamp: new Date().toISOString(),
				message: {
					role: "toolResult",
					toolCallId: "tc-r",
					toolName: "edit",
					content: [{ type: "text", text: "ok" }],
					isError: false,
					repairStatus: "repaired",
					timestamp: Date.now(),
				},
			},
			{
				type: "message",
				id: "e3",
				parentId: "e2",
				timestamp: new Date().toISOString(),
				message: {
					role: "toolResult",
					toolCallId: "tc-junk",
					toolName: "edit",
					content: [{ type: "text", text: "ok" }],
					isError: false,
					repairStatus: "totally-bogus",
					timestamp: Date.now(),
				},
			},
		];
		await fs.writeFile(sessionPath, `${entries.map(entry => JSON.stringify(entry)).join("\n")}\n`);

		const parsed = await parseSessionFile(sessionPath);
		const lifted = parsed.toolResults.find(link => link.toolCallId === "tc-r");
		const junk = parsed.toolResults.find(link => link.toolCallId === "tc-junk");
		expect(lifted?.repairStatus).toBe("repaired");
		expect(junk?.repairStatus).toBeUndefined();

		await fs.rm(dir, { recursive: true, force: true });
	});
});
