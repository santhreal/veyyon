import { describe, expect, it } from "bun:test";
import { PROFILE_AGENTS_GUIDANCE } from "@veyyon/coding-agent/discovery/agents-guidance";
import { buildSystemPrompt } from "@veyyon/coding-agent/system-prompt";
import {
	GLOBAL_BODY,
	PROFILE_BODY,
	PROJECT_NESTED_BODY,
	PROJECT_ROOT_BODY,
	renderedContextBlock,
	useContextScopeFixture,
} from "./helpers/context-scope-fixture";

const fixture = useContextScopeFixture("system-prompt-context-files-");

/**
 * The operator's real global file is about 24KB of instructions. Size is part of
 * the reproduction: a truncating or size-gated path would look correct against a
 * one-line fixture and still lose the file the operator actually has.
 */
const OPERATOR_GLOBAL_BODY = [
	"# Global standing orders",
	"",
	...Array.from({ length: 560 }, (_, index) => `Rule ${index + 1}: never skip verification step ${index + 1}.`),
	"",
	"Marker: OPERATOR-GLOBAL-TAIL-a71c.",
].join("\n");

async function renderPrompt(cwd: string, agentDir: string, resolvedCustomPrompt?: string): Promise<string> {
	const { systemPrompt } = await buildSystemPrompt({
		cwd,
		agentDir,
		resolvedCustomPrompt,
		skills: [],
		rules: [],
		toolNames: [],
		workspaceTree: { rootPath: cwd, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
		activeRepoContext: null,
	});
	return systemPrompt.join("\n\n");
}

/**
 * Context files reaching the ASSEMBLED PROMPT, which is the only place the bug
 * was observable.
 *
 * Loading the right files is necessary and not sufficient: both prompt templates
 * wrap the whole context section in `{{#if contextFiles.length}}`, so a list that
 * arrives empty, or arrives after the section has already been rendered, produces
 * a prompt with no context block, no error, and no clue. The operator's report
 * was exactly that. These cases assert on rendered bytes for that reason.
 */
describe("system prompt context files", () => {
	/**
	 * THE REPORTED BUG, in the operator's exact install shape: a 24KB global
	 * `~/.veyyon/AGENTS.md` full of real instructions, a profile `AGENTS.md` that
	 * is nothing but the 597-byte seeded preamble, and a project file.
	 *
	 * The global file existed on disk the whole time and simply never appeared in
	 * the prompt. If this regresses, every machine-wide instruction the user has
	 * written is silently ignored by whichever agent path broke, and the only
	 * symptom is an agent that stops obeying rules it was never shown.
	 */
	it("regression: a non-empty global AGENTS.md is never absent from the assembled prompt", async () => {
		const f = fixture("prompt-operator-install");
		f.writeFile(f.globalAgentsPath, `${OPERATOR_GLOBAL_BODY}\n`);
		f.writeFile(f.profileAgentsPath, PROFILE_AGENTS_GUIDANCE);
		f.writeFile(f.rootAgentsPath, `${PROJECT_ROOT_BODY}\n`);

		const prompt = await renderPrompt(f.cwd, f.agentDir);

		expect(OPERATOR_GLOBAL_BODY.length).toBeGreaterThan(24_000);
		expect(prompt).toContain(renderedContextBlock(f.globalAgentsPath, `${OPERATOR_GLOBAL_BODY}\n`));
		expect(prompt).toContain(renderedContextBlock(f.rootAgentsPath, `${PROJECT_ROOT_BODY}\n`));
		// The seeded preamble is veyyon's own managed header. It contributes
		// nothing, and it must not have taken the other two scopes with it.
		expect(prompt).not.toContain("PROFILE-SPECIFIC AGENTS.md");
		expect(prompt).not.toContain(`<file path="${f.profileAgentsPath}">`);
	});

	/**
	 * Rendered AUTHORITY, which is what recency means to the model: the last
	 * statement on a subject is the one it follows. The prompt's own authority block
	 * ranks the operator's own file highest and the project lowest, so the rendered
	 * sequence has to match the promise the same prompt makes, or position quietly
	 * beats prose. It did, and that is the bug this suite reports.
	 *
	 * Asserting only that all four blocks are present would accept the exact
	 * inversion this bug family produces, where the repository the user happens to
	 * have checked out is rendered last and overrides their own configuration.
	 */
	it("renders repo root, then the file closest to cwd, then the profile file, then global last", async () => {
		const f = fixture("prompt-order");
		f.writeFile(f.globalAgentsPath, `${GLOBAL_BODY}\n`);
		f.writeFile(f.profileAgentsPath, `${PROFILE_BODY}\n`);
		f.writeFile(f.rootAgentsPath, `${PROJECT_ROOT_BODY}\n`);
		f.writeFile(f.nestedAgentsPath, `${PROJECT_NESTED_BODY}\n`);

		const prompt = await renderPrompt(f.cwd, f.agentDir);
		const positions = [
			prompt.indexOf(renderedContextBlock(f.rootAgentsPath, `${PROJECT_ROOT_BODY}\n`)),
			prompt.indexOf(renderedContextBlock(f.nestedAgentsPath, `${PROJECT_NESTED_BODY}\n`)),
			prompt.indexOf(renderedContextBlock(f.profileAgentsPath, `${PROFILE_BODY}\n`)),
			prompt.indexOf(renderedContextBlock(f.globalAgentsPath, `${GLOBAL_BODY}\n`)),
		];

		expect(positions.every(position => position >= 0)).toBe(true);
		expect(positions).toEqual([...positions].sort((a, b) => a - b));
		expect(new Set(positions).size).toBe(4);
	});

	/**
	 * An agent with a custom system prompt renders its context through
	 * `session/custom-system-prompt.md` instead of `session/project-prompt.md`.
	 * That is a SECOND template with its own `{{#if contextFiles.length}}` gate,
	 * so a scope that reaches one path can still be missing from the other. A
	 * user who sets a custom prompt must not thereby lose their AGENTS.md.
	 */
	it("renders the same four scopes for an agent with a custom system prompt", async () => {
		const f = fixture("prompt-custom");
		f.writeFile(f.globalAgentsPath, `${GLOBAL_BODY}\n`);
		f.writeFile(f.profileAgentsPath, `${PROFILE_BODY}\n`);
		f.writeFile(f.rootAgentsPath, `${PROJECT_ROOT_BODY}\n`);
		f.writeFile(f.nestedAgentsPath, `${PROJECT_NESTED_BODY}\n`);

		const prompt = await renderPrompt(f.cwd, f.agentDir, "You are a narrow reviewer agent.");

		expect(prompt).toContain("You are a narrow reviewer agent.");
		expect(prompt).toContain(renderedContextBlock(f.globalAgentsPath, `${GLOBAL_BODY}\n`));
		expect(prompt).toContain(renderedContextBlock(f.profileAgentsPath, `${PROFILE_BODY}\n`));
		expect(prompt).toContain(renderedContextBlock(f.rootAgentsPath, `${PROJECT_ROOT_BODY}\n`));
		expect(prompt).toContain(renderedContextBlock(f.nestedAgentsPath, `${PROJECT_NESTED_BODY}\n`));
	});

	/**
	 * The failure MECHANISM, pinned so nobody mistakes it for a safe default: an
	 * empty context list renders no block at all, not an empty one. There is
	 * nothing in the prompt to notice, which is why the loader is required to warn
	 * on an unreadable file rather than return a short list. This case documents
	 * why the sibling suites assert warnings.
	 */
	it("renders no context block at all when every scope is empty", async () => {
		const f = fixture("prompt-empty");

		const prompt = await renderPrompt(f.cwd, f.agentDir);

		expect(prompt).not.toContain('<file path="');
		expect(prompt).toContain("<workstation>");
	});

	/**
	 * The profile scope follows the agent dir the prompt is being BUILT FOR.
	 *
	 * This is the ignored-parameter defect at the prompt boundary: `agentDir` was
	 * accepted, used for the rendered configuration paths, and never forwarded to
	 * the loader, so the prompt advertised one profile's AGENTS.md path in its
	 * configuration block while inlining a different profile's content. If it
	 * regresses, the prompt is internally inconsistent and the agent follows rules
	 * from a profile the user did not select.
	 */
	it("inlines the profile file belonging to the agentDir the prompt is built for", async () => {
		const f = fixture("prompt-active");
		const otherAgentDir = f.agentDirFor("prompt-other");
		f.writeFile(f.profileAgentsPath, `${PROFILE_BODY}\n`);
		const otherAgentsPath = f.writeFile(`${otherAgentDir}/AGENTS.md`, "Marker: OTHER-PROFILE-BYTES-4d19.\n");

		const prompt = await renderPrompt(f.cwd, otherAgentDir);

		expect(prompt).toContain(renderedContextBlock(otherAgentsPath, "Marker: OTHER-PROFILE-BYTES-4d19.\n"));
		expect(prompt).not.toContain(`<file path="${f.profileAgentsPath}">`);
	});

	/**
	 * A project directory holding both `AGENTS.md` and `CLAUDE.md` contributes only
	 * the `AGENTS.md`, and the loser's bytes never reach the model.
	 *
	 * The prompt is the only place this is observable to a user. Inlining both
	 * would hand the model two rules for one directory with nothing to tell it
	 * which is current: a `CLAUDE.md` left behind by another tool would sit at the
	 * same depth as the maintained `AGENTS.md` beside it and compete with it purely
	 * on render order.
	 */
	it("inlines only the AGENTS.md when a project directory carries both names", async () => {
		const f = fixture("prompt-both-names");
		f.writeFile(f.rootAgentsPath, `${PROJECT_ROOT_BODY}\n`);
		f.writeFile(`${f.repoRoot}/CLAUDE.md`, "Marker: STALE-CLAUDE-BYTES-6b3f.\n");

		const prompt = await renderPrompt(f.cwd, f.agentDir);

		expect(prompt).toContain(renderedContextBlock(f.rootAgentsPath, `${PROJECT_ROOT_BODY}\n`));
		expect(prompt).not.toContain("STALE-CLAUDE-BYTES-6b3f");
		expect(prompt).not.toContain(`<file path="${f.repoRoot}/CLAUDE.md">`);
	});

	/**
	 * A PROJECT file must never be presented as outranking the operator's own global file.
	 *
	 * Reproduced by the operator: a repository's `AGENTS.md` said "do not use subagents for this
	 * repository", the operator directly asked for subagents, and the agent REFUSED, citing the
	 * project file over both their global configuration and their live instruction. Two sentences
	 * caused it. `context-file-authority.md` said "later and deeper files override earlier and
	 * broader files", and `project-prompt.md`'s dir-context block said "Deeper rules override
	 * higher ones". Both are now inverted, because a project file is content checked into a
	 * repository the operator may not have written, so letting it outrank their own rules is
	 * privilege escalation by document rather than a convention choice.
	 */
	it("tells the model a project file never overrides the user or a broader file", async () => {
		const f = fixture("prompt-precedence");
		f.writeFile(f.rootAgentsPath, `${PROJECT_ROOT_BODY}\n`);

		const prompt = await renderPrompt(f.cwd, f.agentDir);

		expect(prompt).toContain("The user's instructions in this conversation have ABSOLUTE authority.");
		expect(prompt).toContain("LOWEST authority of the three");
		expect(prompt).toContain("MUST NOT contradict, loosen, or forbid what a");
		// The exact wording that produced the refusal, in both places it lived.
		expect(prompt).not.toContain("later and deeper files override earlier and broader files");
		expect(prompt).not.toContain("Deeper rules override higher ones");
	});

	/**
	 * The precedence reminder sits AFTER the last context file, not only before the first.
	 *
	 * Position is part of the fix. The files are inlined narrowest-first, so the PROJECT file lands
	 * in the LOWEST-recency slot and the operator's own global file holds the highest one. Stating
	 * the ranking only above the files still left the last word to whatever the model read most
	 * recently, so a closing restatement puts the ranking itself in the final slot.
	 */
	it("restates the precedence after the inlined files, not only before them", async () => {
		const f = fixture("prompt-precedence-recency");
		f.writeFile(f.rootAgentsPath, `${PROJECT_ROOT_BODY}\n`);

		const prompt = await renderPrompt(f.cwd, f.agentDir);
		const lastFile = prompt.lastIndexOf(PROJECT_ROOT_BODY);
		const closingReminder = prompt.indexOf("Precedence again");

		expect(lastFile).toBeGreaterThan(-1);
		expect(closingReminder).toBeGreaterThan(lastFile);
		expect(prompt).toContain("do what the user asked and say which\nfile you set aside");
	});
});
