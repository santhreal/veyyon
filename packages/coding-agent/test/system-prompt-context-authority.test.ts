import { describe, expect, it } from "bun:test";
import { buildSystemPrompt, loadProjectContextFiles } from "@veyyon/coding-agent/system-prompt";
import { useContextScopeFixture } from "./helpers/context-scope-fixture";

const fixture = useContextScopeFixture("context-authority-");

const EMPTY_TREE = { rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] as string[] };

/** The unconditional half of the ruling: it must hold with or without context files. */
const USER_INSTRUCTION_AUTHORITY = "The user's instructions in this conversation have ABSOLUTE authority.";
/** The conditional half: the three-scope ladder, which only means something when files are loaded. */
const PROJECT_IS_LOWEST =
	"3. The PROJECT's files, from the repository you are working in. LOWEST authority of the three.";
const PROJECT_MAY_NOT_CONTRADICT = "It MAY NOT contradict them, loosen them, or forbid something they allow.";
/** The closing reprise, in the highest-recency slot of the context block. */
const CLOSING_REPRISE = "do what the user asked and say which";

/** The two sentences that produced the operator's refusal. Neither may come back. */
const REFUSAL_CAUSE_AUTHORITY = "later and deeper files override earlier and broader files";
const REFUSAL_CAUSE_DIR_CONTEXT = "Deeper rules override higher ones";

const GLOBAL_ALLOWS_SUBAGENTS = [
	"# My standing orders",
	"",
	"Use subagents freely. Fan work out whenever it parallelizes.",
	"Marker: OPERATOR-GLOBAL-ALLOWS-SUBAGENTS-1f0c.",
].join("\n");

const PROJECT_FORBIDS_SUBAGENTS = [
	"# Repository rules",
	"",
	"Do not use subagents for this repository.",
	"Marker: PROJECT-FORBIDS-SUBAGENTS-4b71.",
].join("\n");

async function renderPrompt(cwd: string, agentDir: string, resolvedCustomPrompt?: string): Promise<string> {
	const { systemPrompt } = await buildSystemPrompt({
		cwd,
		agentDir,
		resolvedCustomPrompt,
		skills: [],
		rules: [],
		toolNames: [],
		workspaceTree: { rootPath: cwd, ...EMPTY_TREE },
		activeRepoContext: null,
	});
	return systemPrompt.join("\n\n");
}

/**
 * WHICH CONTEXT FILE WINS, and what the prompt tells the model about it.
 *
 * This is the precedence file. A reader looking for "does a project AGENTS.md
 * outrank my own one" should land here, and the first case reproduces the
 * reported precedence failure end to end rather than paraphrasing it.
 *
 * Every case measures through the REAL loader on a real temp fixture. Passing
 * `contextFiles` to `buildSystemPrompt` explicitly BYPASSES the authority sort and
 * renders the caller's array verbatim, so a hand-built array cannot prove anything
 * about precedence: it proves what the test itself typed.
 */
describe("context-file authority", () => {
	/**
	 * THE REGRESSION, reproduced.
	 *
	 * A repository's `AGENTS.md` said "do not use subagents for this repository".
	 * A direct request asked for subagents. The agent REFUSED, citing the
	 * project file over both their own global `AGENTS.md` and their live
	 * instruction. Four separate causes all told the model that a narrower file
	 * wins: the authority prose said "later and deeper files override earlier and
	 * broader files", the dir-context block said "Deeper rules override higher
	 * ones", the provider doc said "Later scopes override earlier ones" under a
	 * list that numbered project last, and the render order put every project file
	 * AFTER the global one, where recency made it the last word.
	 *
	 * The ruling this pins: the user's live instruction is absolute, then their own
	 * home configuration, then the profile, then the project lowest. It is a safety
	 * boundary, not a convention, because a project file is content checked into a
	 * repository the operator may not have written.
	 *
	 * This is the durable artifact of the whole fix and should be the last case
	 * deleted if the design ever changes.
	 */
	it("regression: a project file forbidding subagents outranks neither the user's own file nor the user", async () => {
		const f = fixture("operator-subagent-refusal");
		f.writeFile(f.globalAgentsPath, `${GLOBAL_ALLOWS_SUBAGENTS}\n`);
		f.writeFile(f.rootAgentsPath, `${PROJECT_FORBIDS_SUBAGENTS}\n`);

		const files = await loadProjectContextFiles({ cwd: f.cwd, agentDir: f.agentDir });
		const prompt = await renderPrompt(f.cwd, f.agentDir);
		const projectAt = prompt.indexOf("PROJECT-FORBIDS-SUBAGENTS-4b71");
		const globalAt = prompt.indexOf("OPERATOR-GLOBAL-ALLOWS-SUBAGENTS-1f0c");

		// Both files reach the model. Neither is dropped; the question is only which one ranks.
		expect(files.map(file => file.path)).toEqual([f.rootAgentsPath, f.globalAgentsPath]);

		// POSITION: the operator's own file holds the last and highest-recency slot.
		expect(projectAt).toBeGreaterThanOrEqual(0);
		expect(globalAt).toBeGreaterThan(projectAt);

		// PROSE: and it says so, in words, in the same prompt.
		expect(prompt).toContain(USER_INSTRUCTION_AUTHORITY);
		expect(prompt).toContain(PROJECT_IS_LOWEST);
		expect(prompt).toContain(PROJECT_MAY_NOT_CONTRADICT);
		expect(prompt.lastIndexOf(CLOSING_REPRISE)).toBeGreaterThan(globalAt);

		// The exact wording that produced the refusal, in both places it lived.
		expect(prompt).not.toContain(REFUSAL_CAUSE_AUTHORITY);
		expect(prompt).not.toContain(REFUSAL_CAUSE_DIR_CONTEXT);
	});

	/**
	 * The ladder is stated BEFORE the files in both prompt modes, and it reaches the
	 * CUSTOM template through `buildSystemPrompt`, not just through a hand-passed
	 * render.
	 *
	 * Two templates render context. The default agent uses
	 * `session/project-prompt.md`; an agent with a custom system prompt uses
	 * `session/custom-system-prompt.md`, a separate `{{contextFileAuthority}}`
	 * interpolation with its own `{{#if contextFiles.length}}` gate. A fix applied to
	 * one of them is invisible in the other.
	 *
	 * The custom half is a byte proof of a wiring nobody had checked. When a custom
	 * prompt is active, `buildSystemPrompt` renders the project footer with
	 * `contextFiles: []`, which closes THAT template's context block, so every
	 * occurrence of the ladder in a custom-prompt session comes from the custom
	 * template. `test/core/custom-system-prompt.test.ts` passes `contextFileAuthority`
	 * into `prompt.render` by hand, which proves the template interpolates the field
	 * and says nothing about whether the builder supplies it. Asserting exactly one
	 * occurrence, inside the custom template's own `<instructions>` wrapper, closes
	 * that gap: if the builder stopped supplying the field the count would be zero.
	 */
	it("states the scope ladder before the loaded files in both prompt modes", async () => {
		const f = fixture("authority-both-modes");
		f.writeFile(f.rootAgentsPath, `${PROJECT_FORBIDS_SUBAGENTS}\n`);

		const [defaultPrompt, customPrompt] = await Promise.all([
			renderPrompt(f.cwd, f.agentDir),
			renderPrompt(f.cwd, f.agentDir, "Context authority regression prompt."),
		]);

		for (const prompt of [defaultPrompt, customPrompt]) {
			const ladderAt = prompt.indexOf(PROJECT_IS_LOWEST);
			const fileAt = prompt.indexOf(`<file path="${f.rootAgentsPath}">`);
			expect(ladderAt).toBeGreaterThanOrEqual(0);
			expect(fileAt).toBeGreaterThan(ladderAt);
			expect(prompt).toContain(USER_INSTRUCTION_AUTHORITY);
		}

		// The custom path: exactly one ladder, and it is the custom template's copy.
		expect(customPrompt.split(PROJECT_IS_LOWEST)).toHaveLength(2);
		const instructionsAt = customPrompt.indexOf("<instructions>");
		const instructionsEndAt = customPrompt.indexOf("</instructions>");
		expect(instructionsAt).toBeGreaterThanOrEqual(0);
		expect(customPrompt.indexOf(PROJECT_IS_LOWEST)).toBeGreaterThan(instructionsAt);
		expect(customPrompt.indexOf(PROJECT_IS_LOWEST)).toBeLessThan(instructionsEndAt);
	});

	/**
	 * A session with ZERO context files still gets the absolute-authority sentence.
	 *
	 * The scope ladder is gated on `{{#if contextFiles.length}}` and rightly so:
	 * with no files there is nothing to rank. "The user's live instruction is
	 * absolute" is a different claim and is NOT about files. Rules, always-apply
	 * rules and memories all render without a single `AGENTS.md` on disk, and any of
	 * them can tell the model to refuse. Gating the whole statement on context files
	 * therefore left the safety boundary switched off in exactly the sessions where
	 * nothing else states it, which is why the two halves are separate prompts.
	 */
	it("states the user's absolute authority even when no context file is loaded", async () => {
		const f = fixture("authority-no-files");

		const prompt = await renderPrompt(f.cwd, f.agentDir);

		expect(prompt).toContain(USER_INSTRUCTION_AUTHORITY);
		// Non-vacuity: the ladder really is absent, so the sentence above is not
		// arriving as part of the context block.
		expect(prompt).not.toContain("<context>");
		expect(prompt).not.toContain(PROJECT_IS_LOWEST);
	});
});
