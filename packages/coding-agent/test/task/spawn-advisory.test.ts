import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentLifecycleManager } from "@veyyon/coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@veyyon/coding-agent/registry/agent-registry";
import { buildSpecializationAdvisory, TaskTool } from "@veyyon/coding-agent/task";
import * as discoveryModule from "@veyyon/coding-agent/task/discovery";
import * as executorModule from "@veyyon/coding-agent/task/executor";
import type { AgentDefinition, SingleResult } from "@veyyon/coding-agent/task/types";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import { useIsolatedAgentDir } from "../helpers/isolated-agent-dir";
import { makeToolSession } from "../helpers/tool-session";

// The gating cases below drive a REAL spawn through `TaskTool.execute` with a session that has
// no session file, and a fileless parent routes its subagent transcripts to the ACTIVE PROFILE's
// durable sessions dir (`getSessionsDir()`). Without this the spawn tries to mkdir inside the
// developer's real `~/.veyyon/profiles/<profile>/agent/sessions` and the real-data tripwire
// refuses it, which surfaced as the advisory text being a tripwire error instead of the nudge.
useIsolatedAgentDir();

// Contract: the task tool appends an advisory (never a rejection) steering the
// spawner toward more specific agent types when one call resolves ≥2 items to
// a generic `deep`/`sonic` worker and the spawner still holds spawn capacity
// (DepthCapacity). It is gated on depth so a leaf at max recursion is never
// nagged, and a lone generic spawn is never flagged.

describe("buildSpecializationAdvisory", () => {
	it("nudges when one call spawns two generic workers with depth capacity", () => {
		const advice = buildSpecializationAdvisory(["deep", "deep"], true, ["deep", "scout"]);
		expect(advice).toBeDefined();
		expect(advice).toContain("`scout`");
	});

	it("stays silent at max depth even for a generic fan-out", () => {
		expect(buildSpecializationAdvisory(["deep", "deep"], false, ["deep", "scout"])).toBeUndefined();
	});

	it("stays silent for a single generic spawn", () => {
		expect(buildSpecializationAdvisory(["deep"], true, ["deep", "scout"])).toBeUndefined();
	});

	it("stays silent when the fan-out already uses specific agent types", () => {
		expect(buildSpecializationAdvisory(["reviewer", "scout"], true, ["deep", "scout", "reviewer"])).toBeUndefined();
	});

	it("stays silent for a mixed call with only one generic worker", () => {
		expect(buildSpecializationAdvisory(["deep", "scout"], true, ["deep", "scout"])).toBeUndefined();
	});

	it("counts sonic as generic alongside deep", () => {
		const advice = buildSpecializationAdvisory(["sonic", "deep"], true, ["deep", "scout", "sonic"]);
		expect(advice).toBeDefined();
		expect(advice).toContain("2 generic");
	});
});

// Contract: the advisory rides the task-tool result for an interactive spawner,
// but a session that opts out (`suppressSpawnAdvisory` — internal/programmatic
// callers like the commit agent's file-analysis fan-out) gets a clean result so
// the nudge never contaminates code-consumed evidence.
describe("task tool advisory gating via suppressSpawnAdvisory", () => {
	const agent: AgentDefinition = {
		name: "deep",
		description: "General-purpose task agent",
		systemPrompt: "You are a task agent.",
		source: "bundled",
	};
	const scout: AgentDefinition = {
		name: "scout",
		description: "Read-only investigation agent",
		systemPrompt: "Inspect and report.",
		source: "bundled",
	};

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});

	function session(suppress: boolean): ToolSession {
		return makeToolSession({
			cwd: "/tmp",
			hasUI: false,
			suppressSpawnAdvisory: suppress,
			settings: Settings.isolated({
				"async.enabled": false,
				"subagent.isolation.mode": "none",
				"subagent.batch": true,
				// The advisory names a SPECIFIC alternative drawn from the enabled catalog, and only
				// the general-purpose delegate ships enabled (`subagentEnabledByDefault`). Without
				// this row `scout` is not in the catalog, the nudge has nothing to suggest, and the
				// case silently measures enablement policy instead of the advisory it is about.
				"subagent.agents": { scout: { enabled: true } },
			}),
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
		});
	}

	async function spawnText(suppress: boolean): Promise<string> {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [agent, scout], projectAgentsDir: null });
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(
			async (options): Promise<SingleResult> => ({
				index: options.index ?? 0,
				id: options.id ?? "X",
				agent: "deep",
				agentSource: "bundled",
				task: "t",
				assignment: "do the thing",
				exitCode: 0,
				output: "done",
				stderr: "",
				truncated: false,
				durationMs: 1,
				tokens: 0,
				requests: 1,
			}),
		);
		const tool = await TaskTool.create(session(suppress));
		// Both items omit `agent`, so each resolves to the generic spawn-policy
		// default ("deep") — the ≥2-generics condition the advisory gates on.
		const result = await tool.execute("tc", {
			context: "shared fan-out background",
			tasks: [
				{ name: "First", task: "do the thing" },
				{ name: "Second", task: "do the other thing" },
			],
		});
		return result.content.find(part => part.type === "text")?.text ?? "";
	}

	it("appends the specialization advisory when a batch resolves two generic workers", async () => {
		expect(await spawnText(false)).toContain("`scout`");
	});

	it("omits the advisory entirely when the session suppresses it", async () => {
		expect(await spawnText(true)).not.toContain("`scout`");
	});
});
