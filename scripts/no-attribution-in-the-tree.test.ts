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

/** Why an extension carries no prose about anybody. Shared so the table below stays readable. */
const NO_COMMENT_SYNTAX = { skip: "no comment syntax, so a line is data rather than prose" } as const;
const RECORDED_OUTPUT = { skip: "recorded command output kept byte for byte as a fixture" } as const;
const GENERATED_DATA = { skip: "generated data, not written by hand" } as const;
const LEGAL_TEXT = { skip: "licence or notice text taken verbatim from upstream" } as const;
const BINARY_ASSET = { skip: "binary asset" } as const;

type ExtensionDecision = "scan" | { readonly skip: string };

/**
 * One decision per extension the repository actually contains.
 *
 * Keyed by extension rather than expressed as a scanned-only list, because a list of what to scan
 * fails open: the first `.go` or `.kt` tree lands invisible to this gate and nothing says so. The
 * census tests below compare this table against the extensions git is tracking in both directions,
 * so a new language turns them RED until someone records a decision here, and a decision left
 * behind by a deleted tree turns them RED too rather than sitting here as decoration.
 */
const EXTENSION_POLICY: Readonly<Record<string, ExtensionDecision>> = {
	"": "scan", // Dockerfiles, git hooks, ignore files: `#` comments
	".ts": "scan",
	".tsx": "scan",
	".js": "scan",
	".rs": "scan",
	".py": "scan",
	".rb": "scan",
	".jl": "scan",
	".sh": "scan",
	".ps1": "scan",
	".css": "scan",
	".md": "scan",
	".html": "scan",
	".xml": "scan",
	".hbs": "scan",
	".j2": "scan",
	".toml": "scan",
	".yml": "scan",
	".yaml": "scan",
	".jsonc": "scan",
	".proto": "scan",
	".lark": "scan",
	".sublime-syntax": "scan",
	".tape": "scan",
	".dockerfile": "scan",
	".dockerignore": "scan",
	".veybot": "scan",
	".example": "scan",
	".json": NO_COMMENT_SYNTAX,
	".webmanifest": NO_COMMENT_SYNTAX,
	".lock": GENERATED_DATA,
	".dict": GENERATED_DATA,
	".hex": GENERATED_DATA,
	".bdf": GENERATED_DATA,
	".txt": RECORDED_OUTPUT,
	".raw": RECORDED_OUTPUT,
	".min": RECORDED_OUTPUT,
	".exit": RECORDED_OUTPUT,
	".cmd": RECORDED_OUTPUT,
	".patch": RECORDED_OUTPUT,
	".diff": RECORDED_OUTPUT,
	".err": RECORDED_OUTPUT,
	".typescript": RECORDED_OUTPUT,
	".jsonl": NO_COMMENT_SYNTAX,
	".tsv": NO_COMMENT_SYNTAX,
	".recorder": "scan", // A Dockerfile named by its stage: `#` comments
	".typed": { skip: "empty marker file" },
	".LICENSE": LEGAL_TEXT,
	".png": BINARY_ASSET,
	".jpg": BINARY_ASSET,
	".webp": BINARY_ASSET,
	".gif": BINARY_ASSET,
	".ico": BINARY_ASSET,
	".mp4": BINARY_ASSET,
	".pdf": BINARY_ASSET,
	".ttf": BINARY_ASSET,
	".gz": BINARY_ASSET,
	".svg": { skip: "vector art, not prose" },
};

/** Extensions whose prose is the document itself rather than a comment inside code. */
const MARKUP_EXTENSIONS = new Set([".md", ".html", ".xml", ".hbs", ".j2"]);

/**
 * Markdown under a package's `src/`, under `agents/` or under `.veyyon/` is product content:
 * prompts and agent definitions, which describe the user to a model as part of their job.
 */
function isProductMarkdown(file: string): boolean {
	return (
		path.extname(file) === ".md" &&
		(file.includes("/src/") || file.startsWith("agents/") || file.startsWith(".veyyon/"))
	);
}

/**
 * Everything the path rules alone admit, before the extension decision.
 *
 * Separate from {@link inScope} so the census can ask "which extensions reach the extension
 * decision at all", which is the set the policy table has to answer for.
 */
function scopedByPath(file: string): boolean {
	// This file spells out every construction it forbids, in its header and in its positive
	// controls, so it is the one file that must quote them to work at all.
	if (file === "scripts/no-attribution-in-the-tree.test.ts") return false;
	if (EXEMPT_DIRS.some(dir => file.startsWith(dir))) return false;
	const base = path.basename(file);
	if (EXEMPT_NAMES.has(base) || base.includes(".min.")) return false;
	return !isProductMarkdown(file);
}

function inScope(file: string): boolean {
	if (!scopedByPath(file)) return false;
	return EXTENSION_POLICY[path.extname(file)] === "scan";
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
	{
		// Every rule above keys off the words "operator" and "user", so naming the person outright
		// walked straight past all of them: `reported by @santhreal`, `per Mukund's screenshot`.
		// A handle or a capitalised name after a credit verb is a person; the ordinary technical
		// senses put a lowercase common noun there (`reported by the provider`, `requested by the
		// caller`) and stay legal. The identity list is this repository's own accounts, so a URL
		// like github.com/santhreal/veyyon does not match: it needs a credit noun behind it.
		name: "attributing a change to a named person",
		pattern:
			/\b(?:reported|requested|approved|reviewed|verified|confirmed|screenshotted)\s+by\s+@[\w-]+|\b(?:mukund|santhreal|santhsecurity|anionicsanth)(?:'s)?\s+(?:report|reports|screenshot|screenshots|review|reviews|request|requests|ask|asks|words|verdict|complaint)\b/i,
	},
];

/**
 * Everything on one line that is NOT inside an HTML preformatted block, plus the depth to carry
 * into the next line.
 *
 * `<pre>` is a document's code block, exactly as a ``` fence is, and the fence rule below already
 * says a code block in a document is code. The proof pages display captured `git show` output
 * inside `pre.difftext`, and `.diff` is RECORDED_OUTPUT in the policy table above — so the same
 * captured bytes were exempt as a file and prose as a figure, which is the only reason a phrase
 * this suite had already driven out of the source comments still failed it from a rendered diff.
 *
 * Returns the OUTSIDE text rather than skipping the whole line, so prose sharing a line with a
 * closing tag is still scanned and the exemption cannot be widened by writing `</pre>` in front
 * of an attribution.
 */
function outsidePreformatted(line: string, depth: number): { readonly kept: string; readonly depth: number } {
	const tag = /<pre\b|<\/pre\s*>/gi;
	let kept = "";
	let cursor = 0;
	let open = depth;
	let match = tag.exec(line);
	while (match !== null) {
		if (match[0].startsWith("</")) {
			if (open > 0) open -= 1;
		} else {
			if (open === 0) kept += line.slice(cursor, match.index);
			open += 1;
		}
		cursor = match.index + match[0].length;
		match = tag.exec(line);
	}
	if (open === 0) kept += line.slice(cursor);
	return { kept, depth: open };
}

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
	// Markup carries its prose outside any comment marker, so every line is prose. The fence rule
	// still applies: a code block in a document is code, whether it is fenced or in a `<pre>`.
	const markup = MARKUP_EXTENSIONS.has(path.extname(file));
	const raw: { line: number; text: string }[] = [];
	let inFence = false;
	let preformatted = 0;
	source.split("\n").forEach((line, index) => {
		const trimmed = line.trim();
		if (markup) {
			if (trimmed.startsWith("```")) {
				inFence = !inFence;
				return;
			}
			const { kept, depth } = outsidePreformatted(line, preformatted);
			preformatted = depth;
			if (!inFence && kept.trim().length > 0) raw.push({ line: index + 1, text: kept });
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
			["attributing a change to a named person", "// the wrap fix, reported by @santhreal, keeps the row pinned."],
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
			// A credit verb followed by a component, not a person: this is what the ordinary
			// technical sense looks like, and the rule above must leave every one of them alone.
			"\t// A retry is requested by the caller, never by the classifier.",
			"\t// reported by the provider as a rate limit, so the classifier trusts it.",
			" * approved by the approval policy before the tool ever runs.",
			" * See github.com/santhreal/veyyon/releases for what the installer resolves.",
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
	 * A rendered diff is a recording, not prose about a person — and the exemption stops at the
	 * closing tag.
	 *
	 * `.diff` and `.patch` are RECORDED_OUTPUT in the policy table, so a captured `git show`
	 * carrying a phrase from an old comment is exempt as a file. The proof pages display those
	 * same captures inside `pre.difftext`, and `.html` is markup, where every line outside a ```
	 * fence was prose: the identical bytes were exempt as a file and a violation as a figure. The
	 * source comments in that capture had already been rewritten to carry no attribution, so the
	 * only thing failing was the historical record of having fixed it, which no edit to the tree
	 * can change.
	 *
	 * The three cases below are the whole contract, and the last two are why this is not simply a
	 * hole: a caption is still prose, and a line that closes the block and then keeps writing is
	 * still prose, so `</pre>` in front of an attribution silences nothing.
	 */
	it("exempts a rendered diff but not the prose around it", () => {
		const attribution = "the operator's verdict on this build was that the animations are barely noticeable";
		const source = [
			"<h2>Selection band</h2>",
			'<pre class="difftext">',
			`<span class="green">+</span><span class="green">// ${attribution}</span>`,
			"</pre>",
			`<p class="cap">${attribution}</p>`,
			// A blank line, so the two prose cases are not CONSECUTIVE scanned lines. The window
			// above joins each entry with the next one, and with the caption and the split line
			// adjacent, blanking either one left the other's text inside the survivor's window and
			// both negative controls below stayed green while proving nothing.
			"",
			`<pre class="difftext">inside</pre><p>${attribution}</p>`,
		].join("\n");

		const caught = proseLines("proof/page.html", source).filter(entry =>
			BANNED.some(rule => rule.pattern.test(entry.window)),
		);

		// Line 3 is inside the block and exempt; line 5 is a caption and line 7 is prose sharing a
		// line with the block that closed before it. Exact equality, so widening the exemption to
		// the rest of a closing line, or to the whole document, fails here.
		expect(caught.map(entry => entry.line)).toEqual([5, 7]);
	});

	/**
	 * The quoting rule is a list of speech verbs, and a list is only as good as the day it was
	 * written: the first draft held `said` alone, so `the operator wrote "…"` and
	 * `the user called it "…"` were the same leak wearing a different verb and landed green. The
	 * verbs are read back out of the pattern source here rather than retyped, so a verb removed
	 * from the rule fails this test instead of quietly narrowing the guard, and every verb the
	 * rule claims is proven to match a real quotation.
	 */
	/**
	 * The scope constants are the fail-open of a text gate: a violation is silenced by adding one
	 * directory here, or by dropping one extension, and the gate stays green while the leak ships.
	 * They are pinned by exact equality so widening scope is a decision someone makes on purpose
	 * and defends in review, rather than a diff nobody reads.
	 */
	it("pins every exemption, so scope cannot be widened quietly", () => {
		expect(EXEMPT_DIRS).toEqual([
			"crates/vendor/",
			"docs/handbook/book/",
			"website/",
			"packages/coding-agent/src/export/html/vendor/",
			"packages/catalog/src/discovery/cursor-gen/",
		]);
		expect([...EXEMPT_NAMES].sort()).toEqual(["AGENTS.md", "CHANGELOG.md", "CLAUDE.md", "SKILL.md", "UPSTREAM.md"]);
		expect([...MARKUP_EXTENSIONS].sort()).toEqual([".hbs", ".html", ".j2", ".md", ".xml"]);
		// The product-markdown carve-out is a path rule, so it is pinned by behavior: these three
		// prefixes are exempt and an ordinary document is not.
		expect(isProductMarkdown("packages/coding-agent/src/prompts/system.md")).toBe(true);
		expect(isProductMarkdown("agents/deep.md")).toBe(true);
		expect(isProductMarkdown(".veyyon/skills/record-demo/SKILL.md")).toBe(true);
		expect(isProductMarkdown("docs/internal/releasing.md")).toBe(false);
		expect(isProductMarkdown("packages/coding-agent/src/eval/prelude.py")).toBe(false);
	});

	/**
	 * A decision for every extension in the tree, in both directions. Adding a language turns this
	 * red until the table answers for it, which is the only thing standing between a new tree and
	 * a gate that silently does not read it.
	 */
	it("records a decision for every extension git tracks", async () => {
		const present = new Set((await trackedFiles()).filter(scopedByPath).map(file => path.extname(file)));
		const undecided = [...present].filter(ext => EXTENSION_POLICY[ext] === undefined).sort();
		expect(undecided).toEqual([]);
	});

	it("keeps no decision for an extension the tree no longer has", async () => {
		const present = new Set((await trackedFiles()).filter(scopedByPath).map(file => path.extname(file)));
		const stale = Object.keys(EXTENSION_POLICY)
			.filter(ext => !present.has(ext))
			.sort();
		expect(stale).toEqual([]);
	});

	/**
	 * Every scanned extension is proven to have its comment syntax recognized. A decision to scan
	 * a language whose comments this file cannot find is worse than skipping it: the census above
	 * reports it as covered and nothing reads it. Each sample is the same attribution written in
	 * that language's own comment form, and it must be caught.
	 */
	it("finds an attribution in every language it claims to scan", () => {
		const commentFor: Readonly<Record<string, (line: string) => string>> = {
			"": line => `# ${line}`,
			".ts": line => `// ${line}`,
			".tsx": line => `// ${line}`,
			".js": line => `// ${line}`,
			".rs": line => `/// ${line}`,
			".py": line => `# ${line}`,
			".rb": line => `# ${line}`,
			".jl": line => `# ${line}`,
			".sh": line => `# ${line}`,
			".ps1": line => `# ${line}`,
			".css": line => `/* ${line} */`,
			".md": line => line,
			".html": line => line,
			".xml": line => line,
			".hbs": line => `{{! ${line} }}`,
			".j2": line => `{# ${line} #}`,
			".toml": line => `# ${line}`,
			".yml": line => `# ${line}`,
			".yaml": line => `# ${line}`,
			".jsonc": line => `// ${line}`,
			".proto": line => `// ${line}`,
			".lark": line => `// ${line}`,
			".sublime-syntax": line => `# ${line}`,
			".tape": line => `# ${line}`,
			".dockerfile": line => `# ${line}`,
			".recorder": line => `# ${line}`,
			".dockerignore": line => `# ${line}`,
			".veybot": line => `# ${line}`,
			".example": line => `# ${line}`,
		};
		const scanned = Object.entries(EXTENSION_POLICY)
			.filter(([, decision]) => decision === "scan")
			.map(([ext]) => ext)
			.sort();
		// Every scanned extension needs a sample, and a sample for something no longer scanned is
		// dead weight: both directions are pinned so the two lists cannot drift apart.
		expect(Object.keys(commentFor).sort()).toEqual(scanned);

		const attribution = 'the operator asked for "exactly this", so the row never moves.';
		for (const ext of scanned) {
			const render = commentFor[ext];
			if (!render) throw new Error(`no comment form for ${ext}`);
			const source = ["line one of the file", render(attribution), "line after it"].join("\n");
			const windows = proseLines(`fixture${ext === "" ? "" : ext}`, source);
			const caught = windows.filter(entry => BANNED.some(rule => rule.pattern.test(entry.window)));
			expect(caught.length, `${ext} must be scanned for attributions`).toBeGreaterThan(0);
		}
	});

	/**
	 * The named-person rule has two branches and one sample cannot gate both: a handle behind a
	 * credit verb, and one of this repository's own identities behind a credit noun. Each verb and
	 * each identity the pattern claims is read back out of its source and proven to match, so
	 * narrowing the rule to the one shape that leaked fails here instead of quietly shrinking.
	 */
	it("catches an attribution to a named person on both of its branches", () => {
		const rule = BANNED.find(entry => entry.name === "attributing a change to a named person");
		if (!rule) throw new Error("the named-person rule is gone");

		const verbs = /\\b\(\?:([a-z|]+)\)\\s\+by/.exec(rule.pattern.source);
		if (!verbs) throw new Error("the named-person rule no longer lists its credit verbs");
		const identities = /\\b\(\?:([a-z|]+)\)\(\?:'s\)\?/.exec(rule.pattern.source);
		if (!identities) throw new Error("the named-person rule no longer lists the identities");
		const credited = verbs[1].split("|");
		const people = identities[1].split("|");
		expect(credited).toContain("reported");
		expect(credited.length).toBeGreaterThanOrEqual(5);
		expect(people).toContain("santhreal");
		expect(people.length).toBeGreaterThanOrEqual(3);

		for (const verb of credited) {
			expect(rule.pattern.test(`// the wrap fix, ${verb} by @santhsecurity, keeps the row pinned.`), verb).toBe(
				true,
			);
			// A component rather than a person is the ordinary technical sense and stays legal.
			expect(rule.pattern.test(`// the retry is ${verb} by the caller, never by the classifier.`), verb).toBe(false);
		}
		for (const person of people) {
			expect(rule.pattern.test(` * per ${person}'s screenshot the row sat one cell low.`), person).toBe(true);
			// The same identity with no credit noun behind it is ordinary prose about an account,
			// which is how it appears in release and auth documentation.
			expect(rule.pattern.test(` * ${person} is the account the release workflow acts as.`), person).toBe(false);
			// The repository URL carries the same word with no credit noun behind it.
			expect(rule.pattern.test(` * see github.com/${person}/veyyon/releases for the assets.`), person).toBe(false);
		}
	});

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
