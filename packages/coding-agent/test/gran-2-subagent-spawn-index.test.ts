/**
 * GRAN-2: a session records a structured `subagent_spawn` index entry for every
 * subagent it spawns — a navigable parent->child index recoverable from the
 * on-disk session file.
 *
 * Why this suite exists:
 *   Before this entry, a parent referenced its subagents only implicitly: the
 *   sibling-directory convention (`<parent>/<id>.jsonl`) plus `history://<id>`
 *   strings buried in tool-result prose. A study/backtest tool had to scrape text
 *   or scan a directory to enumerate a run's subagents, their tasks, and outcomes.
 *   That is not "study every aspect of a session, including subagents". The
 *   `subagent_spawn` entry makes the subagent tree first-class: one entry per
 *   spawn, pointing at the child's durable transcript, carrying task, isolation,
 *   status, exit code, timing, and usage.
 *
 * The contract these tests lock in:
 *   - `appendSubagentSpawn` persists a `subagent_spawn` entry that round-trips
 *     through a fresh reload with EXACT field values (agentId, agentName, task,
 *     sessionFile, isolation, status, exitCode, durationMs, usage).
 *   - `sessionFile` points at the child's real transcript path.
 *   - Multiple spawns produce multiple entries — a complete enumerable index,
 *     one per child, each pointing at a distinct transcript.
 *
 * If any of these regress, a session's subagents become un-enumerable from the
 * record and the suite fails.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import path from "node:path";
import type { Usage } from "@veyyon/ai";
import { getBundledModel } from "@veyyon/catalog/models";
import type { SubagentSpawnEntry, SubagentSpawnRecord } from "@veyyon/coding-agent/session/session-entries";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { TempDir } from "@veyyon/utils";

const tempDirs: TempDir[] = [];

function makeTempDir(prefix: string): string {
	const dir = TempDir.createSync(prefix);
	tempDirs.push(dir);
	return dir.path();
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => dir.remove()));
});

/** A real assistant turn — persistence gates on an assistant message existing. */
function assistantMessage(text: string) {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected built-in anthropic model to exist");
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as const,
		timestamp: Date.now(),
	};
}

function usage(input: number, output: number, costTotal: number): Usage {
	return {
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + output,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: costTotal },
	} as Usage;
}

function spawnEntries(entries: readonly { type: string }[]): SubagentSpawnEntry[] {
	return entries.filter((e): e is SubagentSpawnEntry => e.type === "subagent_spawn");
}

describe("GRAN-2: parent records a navigable subagent_spawn index", () => {
	it("round-trips a subagent_spawn entry with exact field values through a fresh reload", async () => {
		const cwd = makeTempDir("gran2-cwd-");
		const sessionDir = path.join(cwd, "sessions");
		const manager = SessionManager.create(cwd, sessionDir);
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted session file path");

		// A real turn so the session materializes, then the spawn index entry.
		manager.appendMessage(assistantMessage("spawning a subagent"));
		const childTranscript = path.join(sessionFile.slice(0, -6), "abc123.jsonl");
		const record: SubagentSpawnRecord = {
			agentId: "abc123",
			agentName: "reviewer",
			task: "audit the parser for edge cases",
			sessionFile: childTranscript,
			isolation: "worktree",
			status: "completed",
			exitCode: 0,
			durationMs: 4231,
			usage: usage(1200, 340, 0.0071),
			error: undefined,
		};
		manager.appendSubagentSpawn(record);
		manager.flushSync();
		await manager.close();

		// Reopen from disk in a fresh manager — the entry must be fully recoverable.
		const reopened = await SessionManager.open(sessionFile, sessionDir);
		const spawns = spawnEntries(reopened.getEntries());
		expect(spawns).toHaveLength(1);
		const entry = spawns[0]!;
		expect(entry.agentId).toBe("abc123");
		expect(entry.agentName).toBe("reviewer");
		expect(entry.task).toBe("audit the parser for edge cases");
		expect(entry.sessionFile).toBe(childTranscript);
		expect(entry.isolation).toBe("worktree");
		expect(entry.status).toBe("completed");
		expect(entry.exitCode).toBe(0);
		expect(entry.durationMs).toBe(4231);
		expect(entry.usage?.totalTokens).toBe(1540);
		expect(entry.usage?.cost.total).toBeCloseTo(0.0071, 6);
		await reopened.close();

		// The entry is also present verbatim in the raw JSONL on disk.
		const raw = fs
			.readFileSync(sessionFile, "utf8")
			.trimEnd()
			.split("\n")
			.map(line => JSON.parse(line) as { type?: string; agentId?: string; sessionFile?: string });
		const rawSpawn = raw.find(e => e.type === "subagent_spawn");
		expect(rawSpawn?.agentId).toBe("abc123");
		expect(rawSpawn?.sessionFile).toBe(childTranscript);
	});

	it("enumerates every subagent when a session spawns several, each pointing at a distinct transcript", async () => {
		const cwd = makeTempDir("gran2-multi-cwd-");
		const sessionDir = path.join(cwd, "sessions");
		const manager = SessionManager.create(cwd, sessionDir);
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted session file path");
		manager.appendMessage(assistantMessage("spawning a fan-out"));

		const artifactsDir = sessionFile.slice(0, -6);
		const ids = ["worker-0", "worker-1", "worker-2"];
		const statuses = ["completed", "failed", "cancelled"] as const;
		ids.forEach((id, i) => {
			manager.appendSubagentSpawn({
				agentId: id,
				agentName: "task",
				task: `slice ${i}`,
				sessionFile: path.join(artifactsDir, `${id}.jsonl`),
				isolation: "none",
				status: statuses[i]!,
				exitCode: i === 1 ? 3 : 0,
				durationMs: 1000 + i,
				usage: usage(100 * (i + 1), 10 * (i + 1), 0.001 * (i + 1)),
				error: i === 1 ? "boom" : undefined,
			});
		});
		manager.flushSync();
		await manager.close();

		const reopened = await SessionManager.open(sessionFile, sessionDir);
		const spawns = spawnEntries(reopened.getEntries());
		expect(spawns.map(s => s.agentId)).toEqual(ids);
		// Each entry points at its own distinct child transcript.
		const files = new Set(spawns.map(s => s.sessionFile));
		expect(files.size).toBe(3);
		for (const id of ids) {
			expect(files.has(path.join(artifactsDir, `${id}.jsonl`))).toBe(true);
		}
		// Outcomes are preserved per child, including the failed one's exit code + error.
		const failed = spawns.find(s => s.agentId === "worker-1")!;
		expect(failed.status).toBe("failed");
		expect(failed.exitCode).toBe(3);
		expect(failed.error).toBe("boom");
		await reopened.close();
	});
});
