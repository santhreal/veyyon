/**
 * WHY THIS SUITE EXISTS.
 *
 * An isolated agent did its work, exited 0, and the merge back into the parent
 * tree did not land: the patch did not apply, or the task branch did not
 * cherry-pick over a parent commit that touched the same lines. The tool result
 * read `status="completed"`, `isError` was false and `results[0].error` was
 * unset; the only trace was a `<system-notification>` inside the merge summary
 * prose. A parent scanning results for failures found none and carried on as if
 * the work were in the tree.
 *
 * THE CLASS THIS CLOSES. Every way `mergeIsolatedChanges` can report
 * `changesApplied === false` for an exit-0 child sets `SingleResult.error`, so
 * `classifyAgentOutcome` reports `merge-failed` (label `merge failed`, `isError`
 * true) and the spawn record reads `failed`. The merge modes are swept from the
 * `agent.isolation.merge` setting's declared values, so a new mode is driven
 * here or turns the suite red. The clean-merge control pins that the fix does
 * not turn every isolated run into a failure.
 *
 * The sibling defect rides along: an explicit `agent.isolation.mode` the host
 * cannot honour used to run on the next backend with no trace. The result now
 * opens its merge summary with the requested and actual backends and the
 * reason, and `SingleResult.isolationFallback` carries the same. `auto`, and an
 * explicit mode the host does honour, report nothing; `rcopy` is the one
 * explicit mode every host and every filesystem honours, so it is the control.
 * The unavailable modes are discovered at run time from the setting's values
 * against this host's resolver, so the arm is portable and non-empty on every
 * platform (no host has APFS, ProjFS and NTFS block clone at once). A mode the
 * resolver admits but the repo's filesystem rejects at `isoStart` (reflink on
 * tmpfs) is reported the same way, which is why the control is not derived
 * from the resolver's `auto` pick.
 *
 * WHAT IT DOES NOT CATCH. The eval `agent()` bridge, which throws on a failed
 * merge through its own path; and the rendering of the `merge failed` label in
 * the terminal card, which `task-result-render.test.ts` covers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AGENTS_SETTINGS } from "@veyyon/coding-agent/config/settings-domains/agents";
import * as sdkModule from "@veyyon/coding-agent/sdk";
import { TaskTool } from "@veyyon/coding-agent/task";
import * as discoveryModule from "@veyyon/coding-agent/task/discovery";
import type { AgentDefinition, SingleResult, TaskParams } from "@veyyon/coding-agent/task/types";
import { parseIsolationMode } from "@veyyon/coding-agent/task/worktree";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import * as natives from "@veyyon/natives";
import { $ } from "bun";
import { createMockSession, createSessionResult, yieldSuccessEvent } from "../helpers/agent-session";
import { useIsolatedAgentDir, useIsolatedWorktreesDir } from "../helpers/isolated-agent-dir";
import { makeToolSession } from "../helpers/tool-session";
import { useTrackedTempDirFactory } from "../helpers/tracked-temp-dir";

useIsolatedAgentDir();
useIsolatedWorktreesDir();
const makeTempDir = useTrackedTempDirFactory();

const MERGE_MODES = AGENTS_SETTINGS["agent.isolation.merge"].values;
const ISOLATION_MODES = AGENTS_SETTINGS["agent.isolation.mode"].values;

// `deep` is enabled at defaults; an unknown name is refused before any spawn.
const worker: AgentDefinition = { name: "deep", description: "worker", systemPrompt: "work", source: "bundled" };

const BASE = "line1\nline2\nline3\n";
const CHILD_EDIT = "line1\nCHILD\nline3\n";
const PARENT_EDIT = "line1\nPARENT\nline3\n";

async function git(cwd: string, ...args: string[]): Promise<string> {
	const run = await $`git ${args}`.cwd(cwd).quiet().nothrow();
	if (run.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr.toString()}`);
	return run.text();
}

async function seedRepo(): Promise<string> {
	const root = makeTempDir("veyyon-iso-merge-");
	await git(root, "init", "-q", "-b", "main");
	await git(root, "config", "user.email", "test@example.com");
	await git(root, "config", "user.name", "Test");
	await fs.writeFile(path.join(root, "foo.txt"), BASE);
	await git(root, "add", "foo.txt");
	await git(root, "commit", "-q", "-m", "base");
	return root;
}

function session(cwd: string, settings: Record<string, unknown>): ToolSession {
	return makeToolSession({
		cwd,
		hasUI: false,
		settings: Settings.isolated({ "async.enabled": false, "agent.batch": false, ...settings }),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getAgentId: () => "Main",
		modelRegistry: { refresh: async () => {} } as never,
	});
}

/**
 * The child: writes `content` into `foo.txt` of the cwd it was spawned in (the
 * isolation dir), runs `whileRunning` (the parent moving on underneath it), and
 * yields. It never touches the parent tree itself.
 */
function childThatWrites(content: string, whileRunning?: () => Promise<void>): void {
	vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async opts =>
		createSessionResult(
			createMockSession(async ({ emit }) => {
				await fs.writeFile(path.join(String(opts?.cwd), "foo.txt"), content);
				await whileRunning?.();
				emit(yieldSuccessEvent({ wrote: "foo.txt" }, "y"));
			}),
		),
	);
}

async function runIsolated(
	root: string,
	settings: Record<string, unknown>,
	callId: string,
): Promise<{ isError: boolean | undefined; text: string; result: SingleResult }> {
	const tool = await TaskTool.create(session(root, settings));
	const outcome = await tool.execute(callId, {
		agent: "deep",
		name: `Iso${callId}`,
		task: "edit foo",
		isolated: true,
	} as TaskParams);
	const result = outcome.details?.results[0];
	if (!result) throw new Error("the spawn produced no result");
	return {
		isError: outcome.isError,
		text: outcome.content.map(part => (part.type === "text" ? part.text : "")).join("\n"),
		result,
	};
}

beforeEach(() => {
	vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [worker], projectAgentsDir: null });
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("a merge that does not land fails the isolated agent", () => {
	// Fail-by-default: a third merge mode is driven by the loop below, and this
	// pin makes the addition visible so its conflict shape is checked on purpose.
	it("sweeps every declared merge mode", () => {
		expect([...MERGE_MODES]).toEqual(["patch", "branch"]);
	});

	for (const merge of MERGE_MODES) {
		describe(`agent.isolation.merge = ${merge}`, () => {
			const settings = { "agent.isolation.mode": "rcopy", "agent.isolation.merge": merge };

			it("control: a merge that lands reads as completed", async () => {
				const root = await seedRepo();
				childThatWrites(CHILD_EDIT);
				const run = await runIsolated(root, settings, `ok-${merge}`);
				expect(run.result.exitCode).toBe(0);
				expect(run.result.error).toBeUndefined();
				expect(run.isError).toBeFalsy();
				expect(run.text).toContain('status="completed"');
				expect(await fs.readFile(path.join(root, "foo.txt"), "utf8")).toBe(CHILD_EDIT);
			});

			it("a parent commit on the same lines makes the merge fail, and the result says so", async () => {
				const root = await seedRepo();
				childThatWrites(CHILD_EDIT, async () => {
					await fs.writeFile(path.join(root, "foo.txt"), PARENT_EDIT);
					await git(root, "commit", "-qam", "parent moved on");
				});
				const run = await runIsolated(root, settings, `conflict-${merge}`);
				// The child itself succeeded: this is the merge's failure, not the child's.
				expect(run.result.exitCode).toBe(0);
				expect(run.result.aborted).toBeFalsy();
				expect(run.result.error).toStartWith("Merge failed: ");
				expect(run.isError).toBe(true);
				expect(run.text).toContain('status="merge failed"');
				// The work did not land, and the parent's tree is intact.
				expect(await fs.readFile(path.join(root, "foo.txt"), "utf8")).toBe(PARENT_EDIT);
			});
		});
	}
});

describe("an explicit isolation mode the host cannot honour is reported", () => {
	const explicitModes = ISOLATION_MODES.filter(
		(mode): mode is Exclude<(typeof ISOLATION_MODES)[number], "none" | "auto"> => mode !== "none" && mode !== "auto",
	);
	const unavailable = explicitModes.filter(mode => {
		const kind = parseIsolationMode(mode);
		return kind !== undefined && natives.isoResolve(kind).fellBack;
	});

	it("this host cannot honour at least one declared mode, so the arm below is not empty", () => {
		expect(unavailable.length).toBeGreaterThan(0);
	});

	for (const mode of unavailable) {
		it(`mode=${mode}: the result opens with the backend it ran on and why`, async () => {
			const root = await seedRepo();
			childThatWrites(CHILD_EDIT);
			const run = await runIsolated(
				root,
				{ "agent.isolation.mode": mode, "agent.isolation.merge": "patch" },
				`fb-${mode}`,
			);
			const fallback = run.result.isolationFallback;
			expect(fallback).toBeDefined();
			expect(fallback?.requested).toBe(mode);
			expect(fallback?.actual).not.toBe(mode);
			expect(fallback?.reason.length).toBeGreaterThan(0);
			expect(run.text).toContain(`Isolation fell back from ${mode} to ${fallback?.actual}: ${fallback?.reason}`);
			// Report-and-continue: the run still merges.
			expect(run.isError).toBeFalsy();
			expect(await fs.readFile(path.join(root, "foo.txt"), "utf8")).toBe(CHILD_EDIT);
		});
	}

	for (const mode of ["auto", "rcopy"] as const) {
		it(`control: mode=${mode} reports no fallback`, async () => {
			const root = await seedRepo();
			childThatWrites(CHILD_EDIT);
			const run = await runIsolated(
				root,
				{ "agent.isolation.mode": mode, "agent.isolation.merge": "patch" },
				`ctl-${mode}`,
			);
			expect(run.result.isolationFallback).toBeUndefined();
			expect(run.text).not.toContain("Isolation fell back");
			expect(run.isError).toBeFalsy();
			expect(await fs.readFile(path.join(root, "foo.txt"), "utf8")).toBe(CHILD_EDIT);
		});
	}
});
