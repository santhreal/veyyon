/**
 * WHY THIS SUITE EXISTS (NO-ATTRIBUTION).
 *
 * Comments, WHY headers and internal docs in this tree used to carry the person behind a change:
 * quoted chat messages, dated report and screenshot credits, "in the operator's own words", "a user
 * reported", "user-approved". That is a privacy leak in a public repository, and it is also bad
 * engineering prose: a comment that says who asked cannot say what is true, so the next reader gets
 * an anecdote where they needed an invariant. Both problems have exactly one fix, which is to write
 * the behavior instead.
 *
 * WHY A TEXT SCAN, given that source-grep tests are banned. The banned kind asserts that some
 * implementation LOOKS a certain way and breaks on a harmless rename. This one has text as its
 * subject: the contract is a property of the bytes committed to the repository, in the same family
 * as the brand-leak and OSS/private separation locks. There is no behavior to exercise instead.
 *
 * WHAT IT DOES NOT CATCH. Paraphrase. "The requirement here is a key that reclaims the turn" is
 * indistinguishable from a rewritten quote, and a reviewer, not a regex, is the only thing that can
 * tell. Nor "the user asked for full output", which is deliberately legal: in a comment about a
 * flag it names WHERE a value came from, so a pattern for it would fire on 40-odd accurate lines and
 * teach the next reader to delete the explanation instead of the attribution. It also allows
 * CHANGELOG files, whose released sections are immutable by policy, and the instruction files
 * (AGENTS.md, CLAUDE.md, SKILL.md), which address the reader on purpose.
 */
import { describe, expect, it } from "bun:test";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(import.meta.dirname, "..");

/** Every text file git tracks, so a new file is scanned the moment it is added. */
async function trackedFiles(): Promise<string[]> {
	const { stdout } = await execFileAsync("git", ["ls-files", "-z"], { cwd: REPO_ROOT, maxBuffer: 64 * 1024 * 1024 });
	return stdout.split("\0").filter(entry => entry.length > 0);
}

/**
 * Directories and names that are out of scope, each for a stated reason. Vendored and generated
 * trees are not ours to write; changelog files carry immutable released sections; instruction files
 * address the reader deliberately; the product's own prompts tell a model about "the user" and must.
 */
const EXEMPT_DIRS = [
	"crates/vendor/",
	"docs/handbook/book/",
	"website/",
	"packages/coding-agent/src/export/html/vendor/",
	"packages/catalog/src/discovery/cursor-gen/",
];
const EXEMPT_NAMES = new Set(["CHANGELOG.md", "AGENTS.md", "CLAUDE.md", "SKILL.md", "UPSTREAM.md"]);
const SCANNED_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".rs", ".py", ".sh", ".bash", ".css", ".md"]);

function inScope(file: string): boolean {
	// This file spells out every construction it forbids, in its header and in its positive
	// controls, so it is the one file that must quote them to work at all.
	if (file === "scripts/no-attribution-in-the-tree.test.ts") return false;
	if (EXEMPT_DIRS.some(dir => file.startsWith(dir))) return false;
	const base = path.basename(file);
	if (EXEMPT_NAMES.has(base) || base.includes(".min.")) return false;
	const ext = path.extname(file);
	if (!SCANNED_EXTENSIONS.has(ext)) return false;
	// Markdown under a package's src/ or under agents/ is product content: prompts and agent
	// definitions, which describe the user to a model as part of their job.
	if (ext === ".md" && (file.includes("/src/") || file.startsWith("agents/") || file.startsWith(".veyyon/")))
		return false;
	return true;
}

/**
 * One entry per banned construction, each naming the shape it forbids. Every pattern matches an
 * ATTRIBUTION — a claim about what a person said, asked, approved, screenshotted or reported — and
 * not the ordinary technical senses of "user" and "request", which describe what the product was
 * told to do through a flag, a setting or a command.
 */
const BANNED: ReadonlyArray<{ readonly name: string; readonly pattern: RegExp }> = [
	{ name: "quoting a person's words", pattern: /\b(?:in\s+)?(?:the\s+)?(?:operator|user)(?:'s)?\s+own\s+words\b/i },
	{
		name: "a dated report or screenshot credit",
		pattern: /\b(?:operator|user)s?(?:'s)?[\s-](?:report|reports|screenshot|screenshots)\b/i,
	},
	{
		name: "attributing a report to a person",
		pattern: /\b(?:a|the)\s+(?:operator|user)\s+(?:reported|reports|complained|screenshotted)\b/i,
	},
	{ name: "attributing approval to a person", pattern: /\b(?:operator|user)[\s-]approved\b/i },
	{
		name: "attributing an order to a person",
		pattern: /\bthe\s+(?:operator|user)\s+(?:ordered|insisted|demanded|repeatedly)\b/i,
	},
	{
		name: "citing a person as the authority",
		pattern: /\bper\s+the\s+(?:operator|user)\b|\breported\s+by\s+the\s+(?:operator|user)\b/i,
	},
	{
		name: "a person's standing instructions as authority",
		pattern: /\b(?:operator|user)'s\s+standing\s+(?:order|orders|rule|rules|instruction|instructions)\b/i,
	},
	{
		// Not "instruction"/"instructions": an operator's instruction FILES are AGENTS.md and
		// CLAUDE.md, a real technical noun, and not "words", which rule one already covers in the
		// only shape that is an attribution.
		name: "a person's ask or complaint as the reason",
		pattern:
			/\b(?:operator|user)'s\s+(?:ask|asks|complaint|complaints|wording|verdict|verdicts|phrasing|screenshot|screenshots)\b/i,
	},
	{
		// Past tense and a quotation that opens after the verb. A bare "the user asked for full
		// output" names where a value came from and stays legal, and so does the present tense —
		// `the operator says "remember this"` describes what someone MAY type. "told" is excluded
		// outright because the common direction is the product telling the operator: `an operator
		// told only "cannot discard"`. "wrote" is excluded too, and that one is a judgement rather
		// than a gap: in prose about a coding tool it almost always means what somebody typed at
		// the CLI, or labels where a value came from (`"the operator wrote this"` against `"the
		// binary shipped this"`), and neither reproduces anything anybody said. The gap admits no
		// quote or backtick so the quotation has to be the verb's own object.
		name: "quoting what a person said",
		pattern:
			/\b(?:the\s+)?(?:operator|user)\s+(?:said|wanted|put\s+it|called\s+it|described\s+it\s+as|asked\s+to|asked\s+for)\b[^\n`"“]{0,24}["“]/i,
	},
	{
		name: "a dated credit next to a person",
		pattern: /\b(?:operator|user)(?:'s)?\b[^\n]{0,40}?\b20\d\d-\d\d-\d\d\b/i,
	},
];

/**
 * Comment and prose lines only: a string literal that is test DATA is not prose about a person.
 *
 * Each entry carries a `window` that appends the NEXT prose line, because at 80 columns an
 * attribution and the sentence it introduces routinely straddle a wrap:
 *
 *     /// Not a header, not an empty bucket, not a placeholder. The operator
 *     /// asked for "actual completely separate workspaces with blank sidebars",
 *
 * Matching one line at a time sees neither half and reports nothing, which is how a leak of
 * exactly this shape survived an earlier pass of this suite.
 */
function proseLines(
	file: string,
	source: string,
): ReadonlyArray<{ readonly line: number; readonly text: string; readonly window: string }> {
	const markdown = path.extname(file) === ".md";
	const raw: { line: number; text: string }[] = [];
	let inFence = false;
	source.split("\n").forEach((line, index) => {
		const trimmed = line.trim();
		if (markdown) {
			if (trimmed.startsWith("```")) inFence = !inFence;
			else if (!inFence && trimmed.length > 0) raw.push({ line: index + 1, text: line });
			return;
		}
		const isComment =
			trimmed.startsWith("//") ||
			trimmed.startsWith("*") ||
			trimmed.startsWith("/*") ||
			(trimmed.startsWith("#") && !trimmed.startsWith("#!") && !trimmed.startsWith("#["));
		if (isComment) raw.push({ line: index + 1, text: line });
	});

	// Strip the leading comment marker before joining, so the continuation reads as prose.
	const asProse = (text: string) => text.trim().replace(/^(?:\/{2,3}!?|\/\*+|\*+\/?|#)\s?/, "");
	return raw.map((entry, index) => {
		const next = raw[index + 1];
		const joined = next && next.line === entry.line + 1 ? `${entry.text} ${asProse(next.text)}` : entry.text;
		return { line: entry.line, text: entry.text, window: joined };
	});
}

describe("no comment or internal doc attributes a change to a person", () => {
	/**
	 * The class gate. Scope is derived from `git ls-files` at run time rather than a checked-in
	 * list, so a file added tomorrow is covered without anyone remembering to add it, and a new
	 * violation fails here instead of shipping.
	 */
	it("carries no attribution in any tracked comment or internal doc", async () => {
		const files = (await trackedFiles()).filter(inScope);
		expect(files.length).toBeGreaterThan(1000); // the scan is not vacuous

		const violations: string[] = [];
		for (const file of files) {
			const source = await fs.readFile(path.join(REPO_ROOT, file), "utf8");
			// Cheap pre-filter: the vast majority of files mention neither word.
			if (!/operator|user/i.test(source)) continue;
			for (const { line, text, window } of proseLines(file, source)) {
				for (const { name, pattern } of BANNED) {
					if (pattern.test(window)) violations.push(`${file}:${line} (${name}): ${text.trim()}`);
				}
			}
		}
		expect(violations).toEqual([]);
	});

	/**
	 * A positive control for every pattern, so a rule that stopped matching anything at all cannot
	 * sit in the list looking like protection. Each sample is the shape that was really committed
	 * and really removed.
	 */
	it("still recognizes each banned construction", () => {
		const samples: ReadonlyArray<readonly [string, string]> = [
			["quoting a person's words", ' * THE NAVIGATION KILLER, in the operator\'s own words: "...".'],
			[
				"a dated report or screenshot credit",
				"\t// jerking the whole footer (user report 2026-07-22); the zone reserves it.",
			],
			["attributing a report to a person", " * A user reported exactly that bar."],
			["attributing approval to a person", " * the V1 aligned-quiet merge (user-approved 2026-07-22)"],
			["attributing an order to a person", " * The operator ordered these three files replaced byte for byte."],
			["citing a person as the authority", "// reported by the operator on 2026-07-24"],
			["a person's standing instructions as authority", " * ran with none of the operator's standing orders."],
			[
				"a person's ask or complaint as the reason",
				"\t\t// The operator's ask (2026-07-23): the indicator says \"click to",
			],
			[
				"quoting what a person said",
				' * user said "these and nothing else", and silently restoring seven tools they did not name',
			],
			[
				"a dated credit next to a person",
				" *    tell unset from a genuinely negative value (operator review 2026-07-24).",
			],
		];
		expect(samples.map(([name]) => name).sort()).toEqual(BANNED.map(rule => rule.name).sort());
		for (const [name, sample] of samples) {
			const rule = BANNED.find(entry => entry.name === name);
			if (!rule) throw new Error(`no rule named ${name}`);
			expect(rule.pattern.test(sample), `${name} must match its own sample`).toBe(true);
		}
	});

	/**
	 * The other half of the same guard: the ordinary technical senses must stay legal, or the gate
	 * becomes a reason to delete accurate comments. A flag the caller passed, a setting written to
	 * config, and a provider's own error text are all facts about the product.
	 */
	it("leaves the technical senses of user and request alone", () => {
		const legal = [
			"\t// Verbose flags bypass filtering entirely: full output was requested.",
			" * True when this credential is pinned for the session by an explicit flag.",
			"\t// The provider's own words survive: a rewritten summary loses the reason.",
			"\t// `reload *` is an explicit request to re-read config from disk.",
			"// roots keep each scan bounded to exactly what the caller asked for.",
			"\t// the user asked for full output, so nothing here is filtered.",
			// Present tense describes what someone MAY type, which is product behavior, not a record
			// of anyone having typed it.
			' * how the model learns WHERE to write when the operator says "remember this".',
			// A provenance label that is itself quoted: the quotation opens before the verb, so it
			// names a category of origin rather than reproducing anything anybody said.
			' * alone does not separate "the operator wrote this" from "the binary shipped this".',
			// What somebody typed at the CLI is product behavior, and the quote inside it belongs to
			// the command line rather than to a conversation.
			' * It means the user wrote `--plan --profile work "message"` without the extension loaded.',
			// Reaches its quote only through a code span, so the quotation belongs to the command
			// line and not to the verb. This is the control that makes the gap's backtick exclusion
			// load-bearing: remove it from the pattern and this line starts matching.
			' * the user said `--profile "work"` was ignored, and the bootstrap had already stripped it.',
		];
		for (const line of legal) {
			for (const { name, pattern } of BANNED) {
				expect(pattern.test(line), `${name} must not match: ${line}`).toBe(false);
			}
		}
	});

	/**
	 * An attribution that wraps is the same violation, and it is the shape this codebase actually
	 * produces: comments are hard-wrapped, so the clause naming the person and the sentence it
	 * quotes land on different lines. Scanning line by line found neither half.
	 */
	it("catches an attribution split across a comment wrap", () => {
		const source = [
			"/// A brand new workspace draws NOTHING.",
			"///",
			"/// Not a header, not an empty bucket, not a placeholder. The operator",
			'/// asked for "actual completely separate workspaces with blank sidebars",',
			"/// and a header over nothing makes a blank sidebar look broken.",
		].join("\n");

		const windows = proseLines("app/src/state/tests.rs", source);
		const caught = windows.filter(entry => BANNED.some(rule => rule.pattern.test(entry.window)));
		expect(caught.map(entry => entry.line)).toEqual([3]);

		// The negative control for the same input: no single LINE carries the violation, so a
		// per-line scan reports nothing and the wrap is what does the hiding.
		const perLine = windows.filter(entry => BANNED.some(rule => rule.pattern.test(entry.text)));
		expect(perLine).toEqual([]);
	});

	/**
	 * The quoting rule is a list of speech verbs, and a list is only as good as the day it was
	 * written: the first draft held `said` alone, so `the operator wrote "…"` and
	 * `the user called it "…"` were the same leak wearing a different verb and landed green. The
	 * verbs are read back out of the pattern source here rather than retyped, so a verb removed
	 * from the rule fails this test instead of quietly narrowing the guard, and every verb the
	 * rule claims is proven to match a real quotation.
	 */
	it("catches a quotation behind any speech verb the rule claims", () => {
		const rule = BANNED.find(entry => entry.name === "quoting what a person said");
		if (!rule) throw new Error("the quoting rule is gone");

		const alternation = /\(\?:said\|([^)]*)\)/.exec(rule.pattern.source);
		if (!alternation) throw new Error("the quoting rule no longer lists its verbs");
		const verbs = ["said", ...alternation[1].split("|")].map(verb => verb.replace(/\\s\+/g, " "));
		// The two shapes that actually leaked here, so narrowing the rule back to one verb fails.
		expect(verbs).toContain("said");
		expect(verbs).toContain("asked for");
		expect(verbs.length).toBeGreaterThanOrEqual(6);

		for (const verb of verbs) {
			expect(rule.pattern.test(` * the operator ${verb} "exactly this", so the row never moves.`), verb).toBe(true);
			expect(rule.pattern.test(` * the user ${verb} “exactly this”, so the row never moves.`), verb).toBe(true);
			// Without a quotation it is ordinary prose about what somebody wanted, not a record of
			// the words they used, and the guard must leave it alone.
			expect(rule.pattern.test(` * the operator ${verb} the row pinned to the bottom of the frame.`), verb).toBe(
				false,
			);
		}
	});
});
