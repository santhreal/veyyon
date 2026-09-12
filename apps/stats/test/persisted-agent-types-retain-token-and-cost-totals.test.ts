/**
 * WHY:
 * Renaming the discriminator from 'subagent' to 'spawn' left existing SQLite rows
 * with `agent_type = 'subagent'` unchanged when their `agent_type_v1` migration
 * sentinel was already marked 'complete'.
 *
 * When `buildAgentTokenShare` was changed to expect only 'spawn', all historical
 * 'subagent' rows were silently dropped from the UI breakdown and token/cost totals,
 * causing grand total tokens to undercount and spawned-agent segments to disappear.
 *
 * This test suite closes the class of regressions where:
 * 1. Historical persisted `AgentType` discriminator values in pre-existing databases
 *    with completed sentinels are dropped or misclassified upon startup.
 * 2. Fresh session file ingests diverge in discriminator vocabulary from historical
 *    persisted rows ('spawn' vs 'subagent').
 * 3. Client view models (`buildAgentTokenShare`) drop known discriminator values
 *    from token and cost totals when aggregating.
 *
 * GAP:
 * This test covers database persistence, schema migration sentinel handling, session
 * file parser classification, aggregation queries, and client view-model construction.
 * It does not test browser rendering of the React component DOM or canvas bar.
 */

import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { syncAllSessions } from "@veyyon/stats/aggregator";
import { buildAgentTokenShare } from "@veyyon/stats/client/data/view-models";
import { closeDb, getStatsByAgentType, initDb } from "@veyyon/stats/db";
import { classifyAgentType, parseSessionFile } from "@veyyon/stats/parser";
import type { AgentTypeStats } from "@veyyon/stats/types";
import { getConfigRootDir, getSessionsDir, getStatsDbPath } from "@veyyon/utils";
import { installStatsTestIsolation } from "./helpers/temp-agent";

installStatsTestIsolation("@pi-stats-legacy-agent-type-");

describe("persisted agent types retain token and cost totals", () => {
	it("retains all tokens and costs from pre-existing completed-sentinel database with legacy 'subagent' rows", async () => {
		await fs.mkdir(getConfigRootDir(), { recursive: true });
		await fs.mkdir(getSessionsDir(), { recursive: true });

		const dbPath = getStatsDbPath();

		// 1. Seed pre-existing database with completed sentinels and historical 'subagent' rows
		const seedDb = new Database(dbPath);
		seedDb.run("PRAGMA busy_timeout = 5000");
		seedDb.run("PRAGMA journal_mode = WAL");

		seedDb.run(`
			CREATE TABLE messages (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				session_file TEXT NOT NULL,
				entry_id TEXT NOT NULL,
				folder TEXT NOT NULL,
				model TEXT NOT NULL,
				provider TEXT NOT NULL,
				api TEXT NOT NULL,
				timestamp INTEGER NOT NULL,
				duration INTEGER,
				ttft INTEGER,
				stop_reason TEXT NOT NULL,
				error_message TEXT,
				input_tokens INTEGER NOT NULL,
				output_tokens INTEGER NOT NULL,
				cache_read_tokens INTEGER NOT NULL,
				cache_write_tokens INTEGER NOT NULL,
				total_tokens INTEGER NOT NULL,
				premium_requests REAL NOT NULL,
				cost_input REAL NOT NULL,
				cost_output REAL NOT NULL,
				cost_cache_read REAL NOT NULL,
				cost_cache_write REAL NOT NULL,
				cost_total REAL NOT NULL,
				agent_type TEXT NOT NULL DEFAULT 'main',
				UNIQUE(session_file, entry_id)
			);

			CREATE TABLE file_offsets (
				session_file TEXT PRIMARY KEY,
				offset INTEGER NOT NULL,
				last_modified INTEGER NOT NULL
			);

			CREATE TABLE meta (
				key TEXT PRIMARY KEY,
				value TEXT NOT NULL
			);
		`);

		// Seed all relevant sentinels as 'complete' (simulating a database that was migrated on an older version)
		const sentinels = [
			{ key: "agent_type_v1", value: "complete" },
			{ key: "user_messages_v8", value: "complete" },
			{ key: "user_message_links_v1", value: "complete" },
			{ key: "premium_requests_priority_v1", value: "complete" },
			{ key: "tool_calls_v1", value: "complete" },
			{ key: "fork_dedupe_v1", value: "complete" },
		];

		const insertMeta = seedDb.prepare("INSERT INTO meta (key, value) VALUES (?, ?)");
		for (const s of sentinels) {
			insertMeta.run(s.key, s.value);
		}

		const projectDir = path.join(getSessionsDir(), "--work--project");
		const sessionDir = path.join(projectDir, "1700000000000_abc");
		const mainFile = path.join(projectDir, "1700000000000_abc.jsonl");
		const subFile = path.join(sessionDir, "TaskWorker.jsonl");
		const advisorFile = path.join(sessionDir, "__advisor.jsonl");

		const insertMsg = seedDb.prepare(`
			INSERT INTO messages (
				session_file, entry_id, folder, model, provider, api, timestamp,
				duration, ttft, stop_reason, error_message,
				input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_tokens, premium_requests,
				cost_input, cost_output, cost_cache_read, cost_cache_write, cost_total, agent_type
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`);

		// Seed 3550 tokens total: 1800 main, 1400 subagent, 350 advisor
		// Seed $0.10 cost total: $0.05 main, $0.04 subagent, $0.01 advisor
		insertMsg.run(
			mainFile,
			"e1",
			"/work/project",
			"claude-sonnet-4.5",
			"anthropic",
			"anthropic-messages",
			Date.now(),
			1000,
			100,
			"stop",
			null,
			1000,
			500,
			200,
			100,
			1800,
			0,
			0.02,
			0.03,
			0,
			0,
			0.05,
			"main",
		);

		insertMsg.run(
			subFile,
			"e2",
			"/work/project",
			"claude-sonnet-4.5",
			"anthropic",
			"anthropic-messages",
			Date.now(),
			1000,
			100,
			"stop",
			null,
			800,
			400,
			150,
			50,
			1400,
			0,
			0.015,
			0.025,
			0,
			0,
			0.04,
			"subagent",
		);

		insertMsg.run(
			advisorFile,
			"e3",
			"/work/project",
			"claude-sonnet-4.5",
			"anthropic",
			"anthropic-messages",
			Date.now(),
			1000,
			100,
			"stop",
			null,
			200,
			100,
			50,
			0,
			350,
			0,
			0.004,
			0.006,
			0,
			0,
			0.01,
			"advisor",
		);

		seedDb.close();

		// 2. Production startup initialization
		const prodDb = await initDb();

		// Verify rows in database remain intact
		const rows = prodDb
			.prepare("SELECT agent_type, total_tokens, cost_total FROM messages ORDER BY id ASC")
			.all() as {
			agent_type: string;
			total_tokens: number;
			cost_total: number;
		}[];
		expect(rows).toEqual([
			{ agent_type: "main", total_tokens: 1800, cost_total: 0.05 },
			{ agent_type: "subagent", total_tokens: 1400, cost_total: 0.04 },
			{ agent_type: "advisor", total_tokens: 350, cost_total: 0.01 },
		]);

		// 3. Query stats through production getStatsByAgentType API
		const statsByAgentType = getStatsByAgentType();
		const byTypeMap = new Map<string, AgentTypeStats>(statsByAgentType.map(s => [s.agentType, s]));

		expect(byTypeMap.get("main")).toMatchObject({
			agentType: "main",
			totalRequests: 1,
			totalInputTokens: 1000,
			totalOutputTokens: 500,
			totalCacheReadTokens: 200,
			totalCacheWriteTokens: 100,
			totalCost: 0.05,
		});

		expect(byTypeMap.get("subagent")).toMatchObject({
			agentType: "subagent",
			totalRequests: 1,
			totalInputTokens: 800,
			totalOutputTokens: 400,
			totalCacheReadTokens: 150,
			totalCacheWriteTokens: 50,
			totalCost: 0.04,
		});

		expect(byTypeMap.get("advisor")).toMatchObject({
			agentType: "advisor",
			totalRequests: 1,
			totalInputTokens: 200,
			totalOutputTokens: 100,
			totalCacheReadTokens: 50,
			totalCacheWriteTokens: 0,
			totalCost: 0.01,
		});

		// 4. Build client view model from aggregated stats
		const tokenShareView = buildAgentTokenShare(statsByAgentType);

		// Acceptance criteria: 3550 total tokens including spawned-agent 1400 tokens and 0.04 cost
		expect(tokenShareView.totalTokens).toBe(3550);
		expect(tokenShareView.totalCost).toBeCloseTo(0.1, 4);

		const segmentTypes = tokenShareView.segments.map(s => s.agentType);
		expect(segmentTypes).toEqual(["main", "subagent", "advisor"]);

		const subagentSegment = tokenShareView.segments.find(s => s.agentType === "subagent");
		expect(subagentSegment).toBeDefined();
		expect(subagentSegment?.tokens).toBe(1400);
		expect(subagentSegment?.requests).toBe(1);
		expect(subagentSegment?.cost).toBe(0.04);
		expect(subagentSegment?.share).toBeCloseTo(1400 / 3550, 6);

		const mainSegment = tokenShareView.segments.find(s => s.agentType === "main");
		expect(mainSegment?.tokens).toBe(1800);
		expect(mainSegment?.share).toBeCloseTo(1800 / 3550, 6);

		const advisorSegment = tokenShareView.segments.find(s => s.agentType === "advisor");
		expect(advisorSegment?.tokens).toBe(350);
		expect(advisorSegment?.share).toBeCloseTo(350 / 3550, 6);

		closeDb();
	});

	it("classifies fresh session files and ingested rows with the same stable 'subagent' discriminator", async () => {
		await fs.mkdir(getConfigRootDir(), { recursive: true });
		await fs.mkdir(getSessionsDir(), { recursive: true });

		const projectFolder = "--work--fresh";
		const projectDir = path.join(getSessionsDir(), projectFolder);
		const sessionDir = path.join(projectDir, "1700000000001_xyz");
		await fs.mkdir(sessionDir, { recursive: true });

		const mainSessionPath = path.join(projectDir, "1700000000001_xyz.jsonl");
		const subSessionPath = path.join(sessionDir, "SubTask.jsonl");
		const nestedSubSessionPath = path.join(sessionDir, "SubTask", "ChildTask.jsonl");
		const advisorSessionPath = path.join(sessionDir, "__advisor.jsonl");

		// Test parser classification directly
		expect(classifyAgentType(mainSessionPath)).toBe("main");
		expect(classifyAgentType(subSessionPath)).toBe("subagent");
		expect(classifyAgentType(nestedSubSessionPath)).toBe("subagent");
		expect(classifyAgentType(advisorSessionPath)).toBe("advisor");

		// Write a valid session file for a spawned subagent
		const assistantTurn = {
			type: "message",
			id: "entry_sub_1",
			parentId: null,
			timestamp: new Date().toISOString(),
			message: {
				role: "assistant",
				model: "claude-sonnet-4.5",
				provider: "anthropic",
				api: "anthropic-messages",
				timestamp: Date.now(),
				duration: 800,
				ttft: 80,
				stopReason: "stop",
				errorMessage: null,
				usage: {
					input: 300,
					output: 150,
					cacheRead: 50,
					cacheWrite: 0,
					totalTokens: 500,
					cost: { input: 0.003, output: 0.006, cacheRead: 0.0005, cacheWrite: 0, total: 0.0095 },
				},
			},
		};

		await fs.writeFile(subSessionPath, `${JSON.stringify(assistantTurn)}\n`);

		// Parse file and verify extracted message stats carry agentType = 'subagent'
		const parseResult = await parseSessionFile(subSessionPath);
		expect(parseResult.stats).toHaveLength(1);
		expect(parseResult.stats[0]?.agentType).toBe("subagent");

		// Run syncAllSessions and verify database insertion and aggregation
		await syncAllSessions();

		const stats = getStatsByAgentType();
		const subStats = stats.find(s => s.agentType === "subagent");
		expect(subStats).toBeDefined();
		expect(subStats?.totalRequests).toBe(1);
		expect(subStats?.totalInputTokens).toBe(300);
		expect(subStats?.totalOutputTokens).toBe(150);
		expect(subStats?.totalCacheReadTokens).toBe(50);

		const view = buildAgentTokenShare(stats);
		expect(view.totalTokens).toBe(500);
		expect(view.segments).toHaveLength(1);
		expect(view.segments[0]?.agentType).toBe("subagent");
		expect(view.segments[0]?.tokens).toBe(500);

		closeDb();
	});
});
