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
const fixedOptions = (): BuildOptions =>
	({
		toolNames: ["read", "write", "bash"],
		contextFiles: [],
		skills: [],
		rules: [],
		workspaceTree: EMPTY_TREE,
		activeRepoContext: null,
	}) as BuildOptions;

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
			sha: "ae952af26fba457e",
			length: 10_333,
		});
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
