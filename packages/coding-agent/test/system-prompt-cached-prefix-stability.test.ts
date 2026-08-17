/**
 * Block 0 of the system prompt is the bytes providers cache, and nothing failed
 * when an edit changed them.
 *
 * WHY THIS SUITE EXISTS. `buildSystemPrompt` returns `string[]`, and that array
 * boundary is a caching contract rather than a structural tier: entry 0 is the
 * rendered template, byte-stable across a session so the provider serves it from
 * its prefix cache, and every later entry holds text that changes during a
 * session (the argot handle table is rewritten whenever a dictionary loads). Move
 * volatile text into entry 0 and every turn re-reads the whole prompt at fresh
 * input prices.
 *
 * Three guards already covered the RUNTIME side of that. `refreshBaseSystemPrompt`
 * records a mid-session prompt change with its reason and stays quiet when a
 * rebuild produces identical bytes (`system-prompt-cache-invalidation.test.ts`);
 * `detectCacheInvalidation` renders a marker in the transcript when a turn's cache
 * footprint collapses; a forked session inherits its parent's `promptCacheKey`
 * rather than cold-starting (`session-fork-prompt-cache-key.test.ts`).
 *
 * All three watch a session that is already running. None of them is a BUILD-time
 * guard, so an edit to the template, to a banner, or to the assembler could change
 * block 0 for every user on every session and no test anywhere would notice — the
 * cost lands as a one-time full re-read of every conversation, which is invisible
 * in a diff and expensive in aggregate. That gap was found while unifying the
 * banner underline widths, a change that had to be shown NOT to touch block 0.
 *
 * These tests do not forbid changing the prompt. They make it impossible to change
 * it by accident: the digest below is the review gate, and updating it is a
 * deliberate line in a diff that says the prompt bytes moved.
 */
import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { PROMPTS } from "@veyyon/coding-agent/prompts/registry";
import { buildSystemPrompt } from "@veyyon/coding-agent/system-prompt";
import { isBannerUnderline, renderBanner } from "@veyyon/coding-agent/system-prompt-builder/banner-grammar";
import { RUNTIME_SECTIONS, TEMPLATE_SECTIONS } from "@veyyon/coding-agent/system-prompt-builder/section-registry";

const EMPTY_TREE = {
	rootPath: "/tmp",
	rendered: "",
	truncated: false,
	totalLines: 0,
	agentsMdFiles: [] as string[],
};

type BuildOptions = Parameters<typeof buildSystemPrompt>[0];

/**
 * A fixed configuration, so the digest is a fact about the PROMPT rather than
 * about the machine running the test. Anything that varies by host (the workspace
 * tree, discovered context files, the active model) is pinned to empty here.
 */
const fixedOptions = (): BuildOptions & { toolNames: string[] } =>
	({
		toolNames: ["read", "write", "bash"],
		contextFiles: [],
		skills: [],
		rules: [],
		workspaceTree: EMPTY_TREE,
		activeRepoContext: null,
	}) as BuildOptions & { toolNames: string[] };

const sha = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 16);

describe("the cacheable prefix does not move without somebody saying so", () => {
	/**
	 * The review gate. If this fails, block 0 changed: every user's next request
	 * after the release re-reads their whole conversation at fresh-input prices
	 * once. That may be exactly what you intended — updating the digest is how you
	 * say so, and the diff then shows a reviewer that prompt bytes moved.
	 *
	 * The length is asserted alongside the digest because a digest alone gives a
	 * reader nothing to reason about: a changed length says "text was added or
	 * removed", a same-length change says "text was edited in place".
	 *
	 * It doubles as a purity guard. The digest is recorded from a fixed set of
	 * options, and block 0 was checked to contain no hostname, home directory,
	 * cwd, platform or architecture. So a failure that appears only on another
	 * machine does not mean the digest is fragile: it means block 0 reads ambient
	 * state, which would make the cached prefix differ per host and per session
	 * for reasons no diff shows.
	 */
	it("renders block 0 to the recorded digest", async () => {
		const { systemPrompt } = await buildSystemPrompt(fixedOptions());
		const blockZero = systemPrompt[0] as string;

		expect({ sha: sha(blockZero), length: blockZero.length }).toEqual({
			// Updated 2026-08-16, deliberately: `3a000fddb2eb6620` / 10_515 ->
			// `868374d0fd2969de` / 9_469 (−1_046).
			//
			// WHAT THE −1_046 IS. Duplicate always-on prose left block 0. Exploration
			// no longer restates Specialized Tools as "use grep/glob to…"; implement
			// no longer says "Grep instead of guessing"; verification-source is one
			// clause on `<critical>` instead of its own XML block; completeness no
			// longer restates contract's don't-shrink-the-ask; cleanup is one
			// paragraph; internal URL schemes dropped their query-flag grammars; the
			// default personality dropped Reasoning Format / Succinct Patterns. The
			// two early-stop sentences stay (this fixture still ends in
			// `<never-stop-early>`). Personality is in this fixture, so that cut is
			// in the number.
			//
			// Updated 2026-08-16, deliberately: `562a3940c0412e3a` / 11_160 ->
			// `3a000fddb2eb6620` / 10_515 (−645).
			//
			// WHAT THE −645 IS. `execution-workflow/commit-often` is gone. That
			// statement told the agent to commit finished work without being asked.
			// Commit cadence is an operator or project rule, not a harness default,
			// and the three bullets were 645 bytes at this fixture (bash is granted,
			// so the row rendered). Ablating it at this fixture is the whole delta.
			//
			// Updated 2026-08-07, deliberately: `e9ee4981c4a330e5` / 11_132 ->
			// `562a3940c0412e3a` / 11_160 (+28).
			//
			// WHAT THE +28 IS, measured rather than assumed. Shipping `browser` off by default made
			// the `execution-workflow/verify` UI bullet tool-agnostic: "drive it in browser" became
			// "drive the real interface and look at the result", which is exactly 28 bytes longer,
			// and the browser-specific mechanics moved into `execution-workflow/verify-browser`
			// conditioned on `contains("tools", "browser")`. This fixture grants read/write/bash, so
			// the new statement renders nothing here and the whole delta is the reworded bullet.
			// Ablating the reword at this fixture returns `e9ee4981c4a330e5` / 11_132.
			//
			// The gate did its job and nobody read it: the reword landed while the prompt digest was
			// only being run inside a whole-package bucket whose failures were being triaged as
			// environment noise. The lesson recorded here is that this pair is the single line a
			// prompt change has to touch, so a red digest means "find the bytes", never "rerun it".
			//
			// Updated 2026-08-04, deliberately: `2a975b88105db940` / 10_108 -> `e9ee4981c4a330e5`
			// / 11_132 (+1_024).
			//
			// THE +1_024 IS THE DEBT THE PREVIOUS ENTRY NAMED, now paid. That entry recorded the
			// COMMITTED tree rather than the working tree, because three statement rows
			// (`tool-policy/bash-cwd`, `tool-policy/delegation-allowed`,
			// `execution-workflow/commit-often`) had been added to the registry but not committed,
			// and recording their bytes would have left HEAD red for everyone until they landed.
			// It predicted `e9ee4981c4a330e5` / 11_132 for when they did. They are committed now
			// (`git ls-files` resolves all three .md files), the tree renders exactly that pair,
			// and this line is the prediction being kept. Measured by ablating each row at this
			// fixture, the two that render here are worth exactly 1_024 bytes;
			// `delegation-allowed` contributes nothing because the fixture grants no `task` tool.
			//
			// NOT THE CONTEXT-FILE PRECEDENCE CHANGE that lands in the same commit, and that is a
			// measured fact rather than an assumption. `session/context-file-authority.md`,
			// `session/project-prompt.md` and the new `session/user-instruction-authority.md` all
			// render into the PROJECT runtime section, which is `systemPrompt[1]`, never block 0.
			// Block 0 hashed `e9ee4981c4a330e5` / 11_132 both before and after those edits at this
			// fixture. The precedence work costs zero prefix-cache invalidation, which is why the
			// unconditional user-authority sentence was put in the runtime section rather than
			// promoted into a statement row.
			//
			// WHAT THE +507 IS. Five instructions that upstream oh-my-pi carries and
			// this fork had dropped are restored as statements: `delivery-contract/no-partial-yield`,
			// `delivery-contract/no-punting`, `delivery-contract/verification-source`,
			// `delivery-contract/never-stop-early` and `execution-workflow/decompose-todo-batching`
			// (conditioned on the todo tool, so it contributes nothing to THIS fixture, which grants
			// only read/write/bash). Four of the five are anti-early-stop text, and the last one is
			// last on purpose: it holds the final recency slot of the cached prefix.
			//
			// WHY THEY CAME BACK. The 2026-07-27 trim recorded below removed "NEVER yield unless the
			// deliverable is complete" and "NEVER punt half-solved work back" as redundant against
			// "the `<critical>` line saying there is no stopping condition other than completion".
			// That line is not in `<critical>` and never was: it lives in `prompts/session/
			// project-prompt.md`, which is the SUBAGENT prompt. So the main-session prompt lost both
			// prohibitions and gained nothing, and the justification named text that does not render
			// here. `packages/coding-agent/test/system-prompt-never-stops-early.test.ts` now asserts
			// each restored line against the composed bytes, so the next trim has to argue with an
			// assertion instead of with a comment.
			//
			// The 2026-07-27 trim itself, kept for provenance: 731 bytes SHORTER (10_332 -> 9_601).
			// `<contract>` also lost "NEVER fabricate outputs...", which `<evidence-and-output>` does
			// state verbatim two sections later. `<yielding>` lost two items restating
			// `<completeness>` and `<evidence-and-output>`. `# 3. Decompose` lost a sentence
			// re-explaining the cleanup phase defined directly below it.
			//
			// NOT the delegation gating, which is the change this digest looks like it should be. The
			// fixture grants `toolNames: ["read","write","bash"]` and therefore no `task` tool, so the
			// whole delegation section is closed in this render: block 0 is byte-identical with and
			// without `subagentNames`, measured both ways at this digest. A future change to delegation
			// prose will not move this number, and if it does, something is rendering that section
			// unconditionally.
			//
			// The zero-prose cutover originally used `String.replace(slot, body)`.
			// That treats `$&`, `$`` and `$'` inside BODY as replacement tokens.
			// The LaTeX guidance contains `$` followed by a backtick, so three
			// literal bytes disappeared from the prompt. Direct registry-order
			// assembly restores them (9_598 -> 9_601) without changing policy.
			//
			// The one-time cost this gate exists to surface is real and was accepted:
			// every conversation re-reads its prefix once after the release.
			sha: "868374d0fd2969de",
			length: 9_469,
		});
	});

	/**
	 * The digest above cannot be moved by delegation prose, which is why it is safe to read a
	 * failure of it as "the shared prompt text changed".
	 *
	 * This exists because the digest bump beside it was misdiagnosed for exactly this reason. The
	 * delegation section had just been put behind `hasSpawnableSubagent`, and a 731-byte drop in
	 * block 0 is about the size of that section, so the gating looked like the obvious cause and was
	 * not. `fixedOptions()` grants no `task` tool, so the section is closed no matter what the
	 * subagent configuration says, and the bytes came from the redundancy trim instead.
	 *
	 * Pinning it turns that measurement into a standing fact. If someone renders delegation prose
	 * unconditionally, or moves it out from behind the task-tool gate, this fails and names the
	 * reason rather than leaving the next reader to re-derive it from a digest that moved.
	 */
	it("renders an identical block 0 whether or not subagents are configured", async () => {
		const bare = await buildSystemPrompt(fixedOptions());
		const withAgents = await buildSystemPrompt({
			...fixedOptions(),
			subagentNames: ["task", "scout"],
		} as BuildOptions);

		const blockZero = bare.systemPrompt[0] as string;

		// Non-vacuity: the fixture must really withhold the task tool, or this passes because the
		// option was ignored rather than because the section is gated.
		expect(fixedOptions().toolNames).not.toContain("task");
		expect(blockZero).not.toContain("Delegation gates:");

		expect(sha(withAgents.systemPrompt[0] as string)).toBe(sha(blockZero));
	});

	/**
	 * The structural half, which survives an intentional digest update.
	 *
	 * A digest bump is easy to make for the right reason and still land the wrong
	 * change: moving a runtime section into block 0 alters the digest exactly like
	 * an ordinary wording edit does, and it is the failure that actually costs
	 * money, because that section's text changes DURING a session rather than
	 * between releases.
	 */
	it("keeps every runtime section out of block 0", async () => {
		const { systemPrompt } = await buildSystemPrompt({
			...fixedOptions(),
			argotPreamble: "<<PREAMBLE>>",
			argotHandles: "<<HANDLES>>",
		} as BuildOptions);
		const [blockZero, ...rest] = systemPrompt as string[];

		// Non-vacuity: the runtime sections must actually have rendered, or "not in
		// block 0" is true because they are nowhere at all.
		expect(rest.join("\n")).toContain("<<PREAMBLE>>");
		expect(rest.join("\n")).toContain("<<HANDLES>>");

		const blockZeroLines = new Set((blockZero as string).split("\n"));
		for (const section of RUNTIME_SECTIONS) {
			expect(blockZeroLines.has(section.name), `${section.id} rendered inside the cached prefix`).toBe(false);
		}
	});

	/**
	 * Passing an option must not perturb the prefix at all.
	 *
	 * The subtle version of the failure above: a runtime section could stay in its
	 * own array entry and still change block 0 by, say, appending a line to the
	 * template when the feature is on. Then the prefix differs between a session
	 * with argot armed and one without, and arming it mid-session invalidates the
	 * cache even though the section itself lives outside the prefix.
	 */
	it("renders an identical block 0 whether or not the runtime sections are present", async () => {
		const bare = await buildSystemPrompt(fixedOptions());
		const armed = await buildSystemPrompt({
			...fixedOptions(),
			argotPreamble: "<<PREAMBLE>>",
			argotHandles: "<<HANDLES>>",
		} as BuildOptions);

		expect(sha(armed.systemPrompt[0] as string)).toBe(sha(bare.systemPrompt[0] as string));
	});

	/**
	 * Two builds of the same configuration are byte-identical.
	 *
	 * Anything non-deterministic in assembly — a timestamp, a set iteration order,
	 * a `Date` in the environment framing — would invalidate the cache on every
	 * single refresh, which is the worst version of this bug and the one that
	 * cannot be seen by reading a diff.
	 */
	it("builds the same bytes twice from the same inputs", async () => {
		const first = await buildSystemPrompt(fixedOptions());
		const second = await buildSystemPrompt(fixedOptions());

		expect(second.systemPrompt).toEqual(first.systemPrompt);
	});
});

describe("one banner grammar reaches the model", () => {
	/**
	 * Every banner in every shipped prompt is underlined the same way.
	 *
	 * Three widths used to ship: 14 in `session/system-prompt.md`, 35 in
	 * `subagent/system-prompt.md`, and 35 again from the assembler, which pasted
	 * `"=".repeat(33)` onto a registry field ending in `==`. So one system prompt
	 * showed the model 14-wide banners for its template sections and 35-wide ones
	 * for its runtime sections, with the width owned in three places and written
	 * down in none.
	 */
	it("underlines every banner in every prompt file identically", () => {
		const widths = new Set<number>();
		for (const prompt of Object.values(PROMPTS)) {
			for (const line of prompt.text.split("\n")) {
				if (/^=+$/.test(line)) widths.add(line.length);
			}
		}

		// Non-vacuity first: a regex that matched nothing would leave one empty set
		// and pass forever.
		expect(widths.size).toBeGreaterThan(0);
		expect([...widths]).toEqual([14]);
	});

	/** The assembler's banners use the same width as the files' banners. */
	it("renders registry banners at the shipped width", () => {
		for (const section of [...TEMPLATE_SECTIONS, ...RUNTIME_SECTIONS]) {
			if (section.name === null) continue;
			const [nameLine, underline] = renderBanner(section.name).split("\n");

			expect(nameLine).toBe(section.name);
			expect(underline).toBe("==============");
			// And the emitted underline must satisfy the recognition rule, or the
			// splitter cannot cut on a banner the assembler just wrote.
			expect(isBannerUnderline(underline)).toBe(true);
		}
	});
});
