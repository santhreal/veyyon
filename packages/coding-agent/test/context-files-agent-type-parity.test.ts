import { describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { discoverContextFiles } from "@veyyon/coding-agent/sdk";
import { buildSystemPrompt } from "@veyyon/coding-agent/system-prompt";
import { inheritContextFiles } from "@veyyon/coding-agent/task/context-inheritance";
import { logger } from "@veyyon/utils";
import {
	GLOBAL_BODY,
	PROFILE_BODY,
	PROJECT_NESTED_BODY,
	PROJECT_ROOT_BODY,
	renderedContextBlock,
	useContextScopeFixture,
} from "./helpers/context-scope-fixture";

const fixture = useContextScopeFixture("context-parity-");

const EMPTY_TREE = { rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] as string[] };

type ContextEntry = { path: string; content: string; depth?: number };

async function renderPrompt(options: {
	cwd: string;
	agentDir: string;
	contextFiles?: ContextEntry[];
	resolvedCustomPrompt?: string;
}): Promise<string> {
	const { systemPrompt } = await buildSystemPrompt({
		cwd: options.cwd,
		agentDir: options.agentDir,
		contextFiles: options.contextFiles,
		resolvedCustomPrompt: options.resolvedCustomPrompt,
		skills: [],
		rules: [],
		toolNames: [],
		workspaceTree: { rootPath: options.cwd, ...EMPTY_TREE },
		activeRepoContext: null,
	});
	return systemPrompt.join("\n\n");
}

/** Every `<file path="...">` block in a rendered prompt, in rendered order. */
function renderedContextPaths(prompt: string): string[] {
	return Array.from(prompt.matchAll(/<file path="([^"]+)">/g), match => match[1]);
}

/**
 * AGENT-TYPE PARITY.
 *
 * Three prompt-assembly paths exist and they diverged: the default agent renders
 * context through `session/project-prompt.md`, an agent with a custom system
 * prompt renders it through `session/custom-system-prompt.md`, and a spawned
 * subagent does not discover at all, it INHERITS the parent's resolved list.
 *
 * The subagent path is where this bug family did its worst damage. Every spawn
 * site dropped inherited entries whose basename was `AGENTS.md`, which is every
 * scope a user actually writes, and then handed the child a prompt asserting
 * that "every AGENTS.md is already inlined" and that it must never grep for one.
 * The child therefore had neither the rules nor permission to look for them, and
 * nothing anywhere reported a problem. These cases pin all three paths to the
 * same resolved set so a fix to one can never again leave the others behind.
 */
describe("context file agent-type parity", () => {
	/**
	 * The headline invariant: for one cwd and one agent dir, the default agent,
	 * a custom-prompt agent, and a subagent inheriting from the default agent all
	 * put the SAME files, in the SAME order, into their prompts.
	 *
	 * Comparing rendered paths rather than loader output is deliberate: the two
	 * templates each gate the whole context section on `contextFiles.length`, so
	 * a divergence that never reaches a template is exactly the divergence that
	 * shipped.
	 */
	it("gives the default agent, a custom-prompt agent, and a subagent the same rendered scopes", async () => {
		const f = fixture("parity-all-paths");
		f.writeFile(f.globalAgentsPath, `${GLOBAL_BODY}\n`);
		f.writeFile(f.profileAgentsPath, `${PROFILE_BODY}\n`);
		f.writeFile(f.rootAgentsPath, `${PROJECT_ROOT_BODY}\n`);
		f.writeFile(f.nestedAgentsPath, `${PROJECT_NESTED_BODY}\n`);

		const parentContextFiles = await discoverContextFiles(f.cwd, f.agentDir);
		const inherited = inheritContextFiles({
			parentContextFiles,
			parentCwd: f.cwd,
			spawnCwd: f.cwd,
			agentName: "reviewer",
		});

		const defaultPrompt = await renderPrompt({ cwd: f.cwd, agentDir: f.agentDir });
		const customPrompt = await renderPrompt({
			cwd: f.cwd,
			agentDir: f.agentDir,
			resolvedCustomPrompt: "You are a narrow reviewer agent.",
		});
		const subagentPrompt = await renderPrompt({
			cwd: f.cwd,
			agentDir: f.agentDir,
			contextFiles: inherited,
			resolvedCustomPrompt: "You are a narrow reviewer agent.",
		});

		const expectedPaths = [f.globalAgentsPath, f.rootAgentsPath, f.nestedAgentsPath, f.profileAgentsPath];
		expect(parentContextFiles.map(file => file.path)).toEqual(expectedPaths);
		expect(renderedContextPaths(defaultPrompt)).toEqual(expectedPaths);
		expect(renderedContextPaths(customPrompt)).toEqual(expectedPaths);
		expect(renderedContextPaths(subagentPrompt)).toEqual(expectedPaths);
		expect(subagentPrompt).toContain(renderedContextBlock(f.globalAgentsPath, GLOBAL_BODY));
		expect(subagentPrompt).toContain(renderedContextBlock(f.profileAgentsPath, PROFILE_BODY));
	});

	/**
	 * The inheritance seam itself, on the path that matters: same cwd, non-empty
	 * parent list. The child must receive the parent's entries UNFILTERED.
	 *
	 * The deleted implementation filtered by basename, so a list of four scopes
	 * became a list of zero, silently. Asserting identity of the array (not just
	 * equal length) also pins that nothing is copied and re-sorted on the way
	 * through, which would break the prominence order the parent resolved.
	 */
	it("hands a same-cwd subagent the parent's context files unfiltered and in order", async () => {
		const f = fixture("parity-inherit");
		f.writeFile(f.globalAgentsPath, `${GLOBAL_BODY}\n`);
		f.writeFile(f.profileAgentsPath, `${PROFILE_BODY}\n`);
		f.writeFile(f.nestedAgentsPath, `${PROJECT_NESTED_BODY}\n`);

		const parentContextFiles = await discoverContextFiles(f.cwd, f.agentDir);
		const inherited = inheritContextFiles({
			parentContextFiles,
			parentCwd: f.cwd,
			spawnCwd: f.cwd,
			agentName: "reviewer",
		});

		expect(inherited).toBe(parentContextFiles);
		expect(inherited?.map(file => file.path)).toEqual([f.globalAgentsPath, f.nestedAgentsPath, f.profileAgentsPath]);
		expect(inherited?.every(file => path.basename(file.path) === "AGENTS.md")).toBe(true);
	});

	/**
	 * A subagent rooted somewhere else must RE-DISCOVER, not inherit.
	 *
	 * The parent's project walk describes the parent's tree. Handing it to a
	 * child spawned with a different cwd would inline rules for directories the
	 * child cannot see, and would suppress the child's own repo rules, because
	 * any array at all counts as "already resolved" downstream.
	 */
	it("returns undefined so a subagent spawned in another directory discovers its own scopes", () => {
		const f = fixture("parity-other-cwd");
		const parentContextFiles = [{ path: f.nestedAgentsPath, content: `${PROJECT_NESTED_BODY}\n`, depth: 0 }];

		const inherited = inheritContextFiles({
			parentContextFiles,
			parentCwd: f.cwd,
			spawnCwd: f.repoRoot,
			agentName: "reviewer",
		});

		expect(inherited).toBeUndefined();
	});

	/**
	 * A parent that resolved ZERO scopes must produce `undefined` plus an
	 * operator-visible warning, never `[]`.
	 *
	 * This is the silent-failure mechanism in its purest form. Downstream
	 * (`sdk.ts` and `system-prompt.ts`) treat any array as already resolved and
	 * skip discovery, so `[]` would propagate the parent's emptiness to every
	 * descendant with nothing rendered and nothing logged. The global
	 * `AGENTS.md` is seeded at startup, so zero scopes means a load failed, which
	 * is the exact condition the operator hit.
	 */
	it("warns and declines to inherit when the parent resolved zero scopes", () => {
		const f = fixture("parity-empty-parent");
		const warnings: Array<{ message: string; fields: Record<string, unknown> }> = [];
		const warnSpy = vi
			.spyOn(logger, "warn")
			.mockImplementation((message: string, fields?: Record<string, unknown>) => {
				warnings.push({ message, fields: fields ?? {} });
			});

		try {
			const inherited = inheritContextFiles({
				parentContextFiles: [],
				parentCwd: f.cwd,
				spawnCwd: f.cwd,
				agentName: "reviewer",
			});

			expect(inherited).toBeUndefined();
			expect(warnings).toEqual([
				{
					message: "Spawning agent with no inherited context files; parent session resolved zero scopes",
					fields: { agent: "reviewer", cwd: f.cwd },
				},
			]);
		} finally {
			warnSpy.mockRestore();
		}
	});

	/**
	 * A parent that never resolved context files at all is not an anomaly (the
	 * eval bridge and some embedders start that way), so it must be quiet. This
	 * separates "nothing was attempted" from "something was attempted and came
	 * back empty", which the previous code could not distinguish and which is
	 * the difference between a normal start and a broken install.
	 */
	it("stays silent when the parent never resolved context files", () => {
		const f = fixture("parity-undefined-parent");
		const warnings: string[] = [];
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation((message: string) => {
			warnings.push(message);
		});

		try {
			const inherited = inheritContextFiles({
				parentContextFiles: undefined,
				parentCwd: f.cwd,
				spawnCwd: f.cwd,
				agentName: "reviewer",
			});

			expect(inherited).toBeUndefined();
			expect(warnings).toEqual([]);
		} finally {
			warnSpy.mockRestore();
		}
	});
});
