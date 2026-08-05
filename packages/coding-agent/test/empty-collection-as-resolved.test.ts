import { describe, expect, it, vi } from "bun:test";
import { buildSystemPrompt } from "@veyyon/coding-agent/system-prompt";
import { logger } from "@veyyon/utils";
import {
	GLOBAL_BODY,
	PROJECT_ROOT_BODY,
	renderedContextBlock,
	useContextScopeFixture,
} from "./helpers/context-scope-fixture";

const fixture = useContextScopeFixture("empty-resolved-");

const EMPTY_TREE = { rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] as string[] };

/** Capture `logger.warn` for the duration of `body`, restoring the spy either way. */
async function withCapturedWarnings<T>(
	body: (warnings: Array<{ message: string; fields: Record<string, unknown> }>) => Promise<T> | T,
): Promise<T> {
	const warnings: Array<{ message: string; fields: Record<string, unknown> }> = [];
	const warnSpy = vi.spyOn(logger, "warn").mockImplementation((message: string, fields?: Record<string, unknown>) => {
		warnings.push({ message, fields: fields ?? {} });
	});
	try {
		return await body(warnings);
	} finally {
		warnSpy.mockRestore();
	}
}

/**
 * EMPTY COLLECTION READ AS "ALREADY RESOLVED".
 *
 * One shape, several call sites: a layer is `T[] | undefined`, presence means "the caller resolved
 * this, do not discover", and some path hands over `[]`. The result is not "load nothing extra", it
 * is "discovery is off", and because every array is truthy the two spellings `x ? a : b` and
 * `x !== undefined ? a : b` looked interchangeable while only one of them said what it meant.
 *
 * This is the mechanism that removed every `AGENTS.md` from every spawned agent: three spawn sites
 * filtered their inherited list down to `[]`, the child's own discovery was then skipped, and
 * nothing anywhere reported it. These cases pin the CONSUMER half of the contract, `buildSystemPrompt`,
 * which must announce when an empty resolved list turns discovery off. The producer half, the spawn
 * sites that must hand over `undefined` instead of an ambiguous empty array, is pinned in
 * `task/inherited-collections.test.ts`.
 */
describe("buildSystemPrompt must not take the resolved branch in silence", () => {
	/**
	 * LOCKS OUT: `buildSystemPrompt` taking its "caller already resolved the context files" branch in
	 * silence. An accidental `[]` (a filter that matched everything, a parent with nothing loaded)
	 * shipped a prompt with zero operator context and produced no signal at all, which is why the
	 * loss was only ever noticed as "the model stopped following the rules".
	 *
	 * IF THIS REGRESSES: an operator whose standing instructions vanish from a session has, once
	 * again, nothing in the log to point at.
	 */
	it("warns when a caller supplies an empty resolved context-file list", async () => {
		const f = fixture("empty-list");
		f.writeFile(f.globalAgentsPath, `${GLOBAL_BODY}\n`);
		f.writeFile(f.rootAgentsPath, `${PROJECT_ROOT_BODY}\n`);

		const warnings = await withCapturedWarnings(async captured => {
			const { systemPrompt } = await buildSystemPrompt({
				cwd: f.cwd,
				agentDir: f.agentDir,
				contextFiles: [],
				skills: [],
				rules: [],
				toolNames: [],
				workspaceTree: { rootPath: f.cwd, ...EMPTY_TREE },
				activeRepoContext: null,
			});
			// The empty list is still honored: an explicit "resolved to nothing" is a real caller
			// intent (the legacy resource loader's `noContextFiles` opt-out), so it is announced, not
			// overridden.
			expect(systemPrompt.join("\n\n")).not.toContain(renderedContextBlock(f.globalAgentsPath, GLOBAL_BODY));
			return captured;
		});

		expect(
			warnings.filter(
				entry => entry.message === "Context file discovery disabled: caller supplied an empty resolved list",
			),
		).toEqual([
			{
				message: "Context file discovery disabled: caller supplied an empty resolved list",
				fields: { cwd: f.cwd, agentDir: f.agentDir },
			},
		]);
	});

	/**
	 * LOCKS OUT: the warning above firing on the ordinary path, which would train every reader to
	 * ignore it. Omitting the option means "not resolved", and that must stay both silent and fully
	 * discovering.
	 */
	it("discovers silently when no context-file list is supplied", async () => {
		const f = fixture("no-list");
		f.writeFile(f.globalAgentsPath, `${GLOBAL_BODY}\n`);
		f.writeFile(f.rootAgentsPath, `${PROJECT_ROOT_BODY}\n`);

		const { prompt, warnings } = await withCapturedWarnings(async captured => {
			const { systemPrompt } = await buildSystemPrompt({
				cwd: f.cwd,
				agentDir: f.agentDir,
				skills: [],
				rules: [],
				toolNames: [],
				workspaceTree: { rootPath: f.cwd, ...EMPTY_TREE },
				activeRepoContext: null,
			});
			return { prompt: systemPrompt.join("\n\n"), warnings: captured };
		});

		expect(prompt).toContain(renderedContextBlock(f.globalAgentsPath, GLOBAL_BODY));
		expect(prompt).toContain(renderedContextBlock(f.rootAgentsPath, PROJECT_ROOT_BODY));
		expect(warnings.map(entry => entry.message)).not.toContain(
			"Context file discovery disabled: caller supplied an empty resolved list",
		);
	});
});
