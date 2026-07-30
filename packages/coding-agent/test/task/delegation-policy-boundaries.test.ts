import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentLifecycleManager } from "@veyyon/coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@veyyon/coding-agent/registry/agent-registry";
import { TaskTool } from "@veyyon/coding-agent/task";
import { homogeneousTriageRefusal, isHomogeneousTriageFanout } from "@veyyon/coding-agent/task/delegation-policy";
import * as discoveryModule from "@veyyon/coding-agent/task/discovery";
import * as executorModule from "@veyyon/coding-agent/task/executor";
import type { AgentDefinition } from "@veyyon/coding-agent/task/types";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import { makeToolSession } from "../helpers/tool-session";

describe("homogeneous triage fan-out", () => {
	/** Several records from one status source are one retrieval/classification operation, not N agents. */
	it("rejects multiple triage-labelled items as one batchable lookup", () => {
		const items = [
			{ name: "All2mdTriage", task: "Classify PR 10." },
			{ name: "AgentBookTriage", task: "Classify PR 11." },
			{ name: "OpenSpaceTriage", task: "Classify PR 12." },
		];
		expect(isHomogeneousTriageFanout(items)).toBe(true);
		expect(homogeneousTriageRefusal(items.length)).toContain("one API or search call");
	});

	/** Independent reviews are not collapsed merely because they use the same specialist role. */
	it("allows multiple substantial reviews when they are not labelled as triage rows", () => {
		expect(
			isHomogeneousTriageFanout([
				{ name: "ParserReview", task: "Review the parser subsystem." },
				{ name: "StorageReview", task: "Review the storage subsystem." },
			]),
		).toBe(false);
	});
});

describe("task tool homogeneous triage enforcement", () => {
	const agents: AgentDefinition[] = [
		{ name: "task", description: "Executing worker", systemPrompt: "", source: "bundled" },
		{
			name: "reviewer",
			description: "Read-only reviewer",
			systemPrompt: "",
			source: "bundled",
			tools: ["read", "grep", "bash"],
		},
	];
	let tempRoot: string;

	beforeEach(async () => {
		tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-delegation-policy-"));
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents, projectAgentsDir: null });
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
		await fs.rm(tempRoot, { recursive: true, force: true });
	});

	function session(enabled: Record<string, { enabled: boolean }> = {}): ToolSession {
		return makeToolSession({
			cwd: tempRoot,
			hasUI: false,
			settings: Settings.isolated({
				"async.enabled": false,
				"subagent.agents": enabled,
				"subagent.batch": true,
				"subagent.isolation.mode": "none",
			}),
			getSessionFile: () => path.join(tempRoot, "parent.jsonl"),
			getSessionSpawns: () => "*",
		});
	}

	/** Even a correctly typed reviewer cannot turn one batched PR-status query into one agent per row. */
	it("refuses homogeneous triage fan-out before any reviewer starts", async () => {
		const run = vi.spyOn(executorModule, "runSubprocess");
		const tool = await TaskTool.create(session({ reviewer: { enabled: true } }));
		const result = await tool.execute("tc", {
			context: "Fetch the current status for each PR.",
			tasks: [
				{ name: "AlphaTriage", agent: "reviewer", task: "Triage PR 10." },
				{ name: "BetaTriage", agent: "reviewer", task: "Triage PR 11." },
			],
		});
		expect(result.isError).toBe(true);
		expect(result.details?.warning?.kind).toBe("homogeneous-triage");
		expect(result.content[0]).toEqual({ type: "text", text: expect.stringContaining("one API or search call") });
		expect(run).not.toHaveBeenCalled();
	});
});
