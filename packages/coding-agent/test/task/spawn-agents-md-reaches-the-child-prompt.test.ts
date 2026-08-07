/**
 * The operator's `AGENTS.md` bytes must survive the REAL spawn site and land in
 * the child's rendered system prompt.
 *
 * THE BUG THIS LOCKS OUT. `task/index.ts` used to build a spawned agent's
 * `contextFiles` by filtering the parent's resolved list, dropping every entry
 * whose basename was `AGENTS.md`. That is every scope an operator actually
 * writes: `~/.veyyon/AGENTS.md`, the active profile's `AGENTS.md`, and the whole
 * project walk. Only a stray `CLAUDE.md` survived. The filter then usually left
 * `[]`, and `buildSystemPrompt` treats ANY array, empty included, as "the caller
 * already resolved this" and skips discovery entirely. So the child was handed no
 * rules AND the project prompt's standing claim that "every AGENTS.md is already
 * inlined", which forbids it from looking for them. Nothing warned. Every
 * subagent in the product ran with none of the instruction files.
 *
 * WHY THIS SUITE AND NOT THE EXISTING ONES.
 *  - `test/context-files-agent-type-parity.test.ts` calls `inheritContextFiles`
 *    directly, so it proves the helper and not the caller.
 *  - `test/task/spawn-cwd-layer-inheritance.test.ts` drives the real spawn but
 *    stops at the options object handed to `runSubprocess`; it never renders a
 *    prompt, so a template that received the list and dropped it stays green.
 * This suite closes both halves: it drives `TaskTool.execute`, takes the
 * `contextFiles` the spawn site actually produced, and renders the child's prompt
 * from exactly those, asserting the operator's file BYTES are in it.
 *
 * IF THIS REGRESSES: subagents silently ignore every project and global rule,
 * and the failure is invisible from inside the child, which simply believes the
 * prompt that told it the rules were already inlined.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentLifecycleManager } from "@veyyon/coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@veyyon/coding-agent/registry/agent-registry";
import { buildSystemPrompt } from "@veyyon/coding-agent/system-prompt";
import { TaskTool } from "@veyyon/coding-agent/task";
import * as discoveryModule from "@veyyon/coding-agent/task/discovery";
import * as executorModule from "@veyyon/coding-agent/task/executor";
import type { AgentDefinition, SingleResult, TaskParams } from "@veyyon/coding-agent/task/types";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import { useIsolatedAgentDir } from "../helpers/isolated-agent-dir";
import { makeToolSession } from "../helpers/tool-session";

// A spawn writes a session file under the ACTIVE PROFILE's agent dir. Without this the
// suite writes into the operator's real `~/.veyyon/profiles/<profile>/agent`.
useIsolatedAgentDir();

const taskAgent: AgentDefinition = {
	name: "task",
	description: "General-purpose task agent",
	systemPrompt: "You are a task agent.",
	source: "bundled",
};

// A real directory, because `resolveSpawnCwd` rejects a path that does not exist. Under the
// OS temp dir, never the operator's home or config root.
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-spawn-agentsmd-"));
const projectCwd = path.join(fixtureRoot, "project");
fs.mkdirSync(projectCwd, { recursive: true });

afterAll(() => {
	fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

/**
 * Three scopes, all named `AGENTS.md`, which is precisely what the old filter ate. The
 * bodies are distinct multi-line prose so `dedupeContainedContextFiles` cannot fold one
 * into another and leave a passing assertion on the survivor.
 */
const GLOBAL_AGENTS_PATH = path.join(fixtureRoot, "fake-home", ".veyyon", "AGENTS.md");
const PROFILE_AGENTS_PATH = path.join(fixtureRoot, "fake-home", ".veyyon", "profiles", "work", "agent", "AGENTS.md");
const PROJECT_AGENTS_PATH = path.join(projectCwd, "AGENTS.md");

const GLOBAL_BYTES = "GLOBAL-SCOPE-MARKER\n\nNever force push to a shared branch.";
const PROFILE_BYTES = "PROFILE-SCOPE-MARKER\n\nCommit messages are imperative and scoped.";
const PROJECT_BYTES = "PROJECT-SCOPE-MARKER\n\nRun bun check before calling anything done.";

const parentContextFiles = [
	{ path: GLOBAL_AGENTS_PATH, content: `${GLOBAL_BYTES}\n`, depth: 0 },
	{ path: PROJECT_AGENTS_PATH, content: `${PROJECT_BYTES}\n`, depth: 0 },
	{ path: PROFILE_AGENTS_PATH, content: `${PROFILE_BYTES}\n`, depth: 0 },
];

const EMPTY_TREE = { rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] as string[] };

function makeResult(name: string): SingleResult {
	return {
		index: 0,
		id: name,
		agent: "task",
		task: "Work.",
		output: "done",
		exitCode: 0,
		durationMs: 1,
	} as SingleResult;
}

function createParentSession(overrides: Partial<ToolSession> = {}): ToolSession {
	return makeToolSession({
		cwd: projectCwd,
		hasUI: false,
		settings: Settings.isolated({ "async.enabled": false }),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		contextFiles: parentContextFiles,
		...overrides,
	});
}

/** Spawn one child through the real tool and return what the spawn site handed the runner. */
async function spawnAndCapture(session: ToolSession, callId: string, name: string) {
	const spy = vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(makeResult(name));
	const tool = await TaskTool.create(session);
	await tool.execute(callId, {
		agent: "task",
		name,
		task: "Work here.",
	} as TaskParams);
	expect(spy).toHaveBeenCalledTimes(1);
	return spy.mock.calls[0]?.[0];
}

describe("a spawned subagent's prompt carries the operator's AGENTS.md scopes", () => {
	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [taskAgent],
			projectAgentsDir: null,
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});

	/**
	 * THE headline case. The subject is the rendered prompt, not the options bag,
	 * because the whole section is gated on `contextFiles.length` inside the
	 * template: a list that reaches the builder and dies in the template is
	 * exactly the failure that shipped.
	 *
	 * Three files, every one named `AGENTS.md`, and the assertion is on their
	 * bytes, so re-introducing ANY basename filter leaves nothing behind to pass
	 * on.
	 */
	it("renders every inherited AGENTS.md scope's bytes into the child prompt", async () => {
		const options = await spawnAndCapture(createParentSession(), "tc-agentsmd", "ScopeCarrier");

		// The spawn site kept all three, in the parent's prompt order, none filtered by name.
		expect(options?.contextFiles?.map(file => file.path)).toEqual([
			GLOBAL_AGENTS_PATH,
			PROJECT_AGENTS_PATH,
			PROFILE_AGENTS_PATH,
		]);
		expect(options?.contextFiles?.every(file => path.basename(file.path) === "AGENTS.md")).toBe(true);

		const { systemPrompt } = await buildSystemPrompt({
			cwd: projectCwd,
			contextFiles: options?.contextFiles,
			skills: [],
			rules: [],
			toolNames: ["read"],
			workspaceTree: { rootPath: projectCwd, ...EMPTY_TREE },
			activeRepoContext: null,
		});
		const rendered = systemPrompt.join("\n\n");

		// The operator's own bytes, verbatim, inside the wrapper the template emits.
		for (const [filePath, body] of [
			[GLOBAL_AGENTS_PATH, GLOBAL_BYTES],
			[PROJECT_AGENTS_PATH, PROJECT_BYTES],
			[PROFILE_AGENTS_PATH, PROFILE_BYTES],
		] as const) {
			expect(rendered).toContain(`<file path="${filePath}">`);
			expect(rendered).toContain(body);
		}
		// Rendered order matches the resolved order, so precedence is not reshuffled.
		expect(Array.from(rendered.matchAll(/<file path="([^"]+)">/g), m => m[1])).toEqual([
			GLOBAL_AGENTS_PATH,
			PROJECT_AGENTS_PATH,
			PROFILE_AGENTS_PATH,
		]);
	});

	/**
	 * The second half of the same defect, and the reason the first half was
	 * silent. `buildSystemPrompt` reads a PRESENT array as "already resolved" and
	 * skips discovery. So when a parent has nothing to hand down, the spawn site
	 * must hand `undefined` and let the child discover for itself. Handing `[]`
	 * disables the child's own scope loading with no diagnostic at all.
	 *
	 * `toBeUndefined` is not enough on its own here: `[]` is falsy-adjacent in
	 * plenty of assertions and `expect([]).toEqual(undefined)` is the mistake this
	 * pins, so the identity of the empty array is checked explicitly.
	 */
	it("hands undefined, never an empty array, when the parent resolved no scopes", async () => {
		const options = await spawnAndCapture(
			createParentSession({ contextFiles: [] }),
			"tc-empty-parent",
			"EmptyParent",
		);

		expect(options?.contextFiles).toBeUndefined();
		expect(Array.isArray(options?.contextFiles)).toBe(false);
	});
});
