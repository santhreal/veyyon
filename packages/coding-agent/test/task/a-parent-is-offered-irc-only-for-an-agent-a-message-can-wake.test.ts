/**
 * WHY THIS SUITE EXISTS.
 *
 * An agent that ran in an isolated copy of the tree falls asleep when its run ends, and the copy is
 * removed. A wake rebuilds an agent in the workspace it ran in and fails closed when that workspace is
 * gone, so nothing can wake an isolated agent. The parent was still told to message it: a background
 * run's delivery read "<id> is now idle — message it via `irc` to follow up", and a stopped run's
 * summary read "message it via `irc` to pick the work back up". The message then failed with "cannot
 * be woken".
 *
 * THE CLASS THIS CLOSES. Every text a parent reads after a spawn settles (the inline summary and the
 * background delivery, for a run that finished and for one that was stopped) offers `irc` only while
 * the workspace a wake rebuilds in still exists. The suite drives the real task tool, executor,
 * isolation backend, job manager and registry with only the model session stubbed, and checks the
 * workspace on disk rather than the flag that chose the text.
 *
 * WHAT IT DOES NOT CATCH. The wake itself: the stubbed session writes no session contract, so no
 * revive is attempted here; the reviver's fail-closed check of the recorded cwd is covered by
 * `persisted-revive-cwd.test.ts`. A shared workspace removed by other means (a moved directory) is
 * not swept.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { AsyncJobManager } from "@veyyon/coding-agent/async/job-manager";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentLifecycleManager } from "@veyyon/coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@veyyon/coding-agent/registry/agent-registry";
import * as sdkModule from "@veyyon/coding-agent/sdk";
import { TaskTool } from "@veyyon/coding-agent/task";
import * as discoveryModule from "@veyyon/coding-agent/task/discovery";
import type { AgentDefinition, TaskParams } from "@veyyon/coding-agent/task/types";
import { $ } from "bun";
import { createMockSession, createSessionResult, yieldSuccessEvent } from "../helpers/agent-session";
import { useIsolatedAgentDir, useIsolatedWorktreesDir } from "../helpers/isolated-agent-dir";
import { makeToolSession } from "../helpers/tool-session";
import { useTrackedTempDirFactory } from "../helpers/tracked-temp-dir";

useIsolatedAgentDir();
useIsolatedWorktreesDir();
const makeTempDir = useTrackedTempDirFactory();

const worker: AgentDefinition = { name: "deep", description: "worker", systemPrompt: "work", source: "bundled" };

const DELIVERIES = ["inline", "background"] as const;
const ENDINGS = ["finished", "stopped"] as const;
const WORKSPACES = ["shared", "isolated"] as const;

type Delivery = (typeof DELIVERIES)[number];
type Ending = (typeof ENDINGS)[number];
type Workspace = (typeof WORKSPACES)[number];

const OFFERS_IRC = "via `irc`";

async function seedRepo(): Promise<string> {
	const root = makeTempDir("veyyon-iso-follow-up-");
	for (const args of [
		["init", "-q", "-b", "main"],
		["config", "user.email", "test@example.com"],
		["config", "user.name", "Test"],
	]) {
		await $`git ${args}`.cwd(root).quiet();
	}
	await fs.writeFile(path.join(root, "foo.txt"), "base\n");
	await $`git add foo.txt`.cwd(root).quiet();
	await $`git commit -q -m base`.cwd(root).quiet();
	return root;
}

/**
 * The child: records the cwd it was spawned in, then yields, or hangs until the run is stopped.
 * Resolves `started` once its turn is under way, which is when a stop can land. It registers itself
 * as the real session construction does, since that construction is what the stub replaces.
 */
function child(ending: Ending): { cwd: () => string; started: Promise<void> } {
	let cwd = "";
	const started = Promise.withResolvers<void>();
	vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async opts => {
		cwd = String(opts?.cwd);
		const id = opts?.agentId;
		if (!id) throw new Error("a spawned session is created without an agent id");
		AgentRegistry.global().register({
			id,
			displayName: "sub",
			kind: "sub",
			parentId: opts.parentAgentId,
			session: null,
			status: "running",
		});
		return createSessionResult(
			createMockSession(
				async ({ emit }) => {
					started.resolve();
					if (ending === "finished") emit(yieldSuccessEvent({ done: true }, "y"));
				},
				{ hangUntilAbort: ending === "stopped" },
			),
		);
	});
	return { cwd: () => cwd, started: started.promise };
}

const managers: AsyncJobManager[] = [];

beforeEach(() => {
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [worker], projectAgentsDir: null });
});

afterEach(async () => {
	vi.restoreAllMocks();
	for (const manager of managers.splice(0)) await manager.dispose({ timeoutMs: 1000 });
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
});

/** Run one spawn and return its id and the text the parent reads once it settles. */
async function settle(
	root: string,
	delivery: Delivery,
	ending: Ending,
	workspace: Workspace,
	started: Promise<void>,
): Promise<{ id: string; text: string }> {
	const manager = delivery === "background" ? new AsyncJobManager({ onJobComplete: () => {} }) : undefined;
	if (manager) managers.push(manager);
	const tool = await TaskTool.create(
		makeToolSession({
			cwd: root,
			hasUI: false,
			settings: Settings.isolated({
				"async.enabled": delivery === "background",
				"agent.batch": false,
				"agent.isolation.mode": "rcopy",
			}),
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			getAgentId: () => "Main",
			asyncJobManager: manager,
			modelRegistry: { refresh: async () => {} } as never,
		}),
	);
	const name = `Probe${delivery}${ending}${workspace}`;
	const params = { agent: "deep", name, task: "do it", isolated: workspace === "isolated" } as TaskParams;
	const controller = new AbortController();
	const call = tool.execute(`call-${name}`, params, controller.signal);

	if (!manager) {
		if (ending === "stopped") {
			await started;
			controller.abort();
		}
		const outcome = await call;
		const id = outcome.details?.results[0]?.id;
		if (!id) throw new Error("the spawn produced no result");
		return { id, text: outcome.content.map(part => (part.type === "text" ? part.text : "")).join("\n") };
	}

	const jobId = (await call).details?.async?.jobId;
	const job = jobId ? manager.getJob(jobId) : undefined;
	if (!jobId || !job) throw new Error("the spawn started no job");
	if (ending === "stopped") {
		await started;
		manager.cancel(jobId);
	}
	await job.promise;
	return { id: jobId, text: job.resultText ?? job.errorText ?? "" };
}

describe("a parent is offered irc only for an agent a message can wake", () => {
	for (const delivery of DELIVERIES) {
		for (const ending of ENDINGS) {
			for (const workspace of WORKSPACES) {
				it(`${delivery} delivery, ${ending} run, ${workspace} workspace`, async () => {
					const root = await seedRepo();
					const spawned = child(ending);
					const { id, text } = await settle(root, delivery, ending, workspace, spawned.started);

					// The agent stays registered either way: no run ends with it removed.
					expect(AgentRegistry.global().get(id)).toBeDefined();
					// The workspace a wake rebuilds in: the parent's tree, or the removed copy.
					const wakeable = await fs.stat(spawned.cwd()).then(
						() => true,
						() => false,
					);
					expect(wakeable).toBe(workspace === "shared");

					// An inline run that finished offers no follow-up at all; every other text offers
					// one exactly when a message can wake the agent.
					const offers = delivery === "inline" && ending === "finished" ? false : wakeable;
					expect(text.includes(OFFERS_IRC)).toBe(offers);
					if (delivery === "background") expect(text).toContain(`history://${id}`);
					if (delivery === "background" && workspace === "isolated") {
						expect(text).toContain("messages cannot reach it");
					}
				});
			}
		}
	}
});
