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
 * tell. It also allows CHANGELOG files, whose released sections are immutable by policy, and the
 * instruction files (AGENTS.md, CLAUDE.md, SKILL.md), which address the reader on purpose.
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
];

/** Comment and prose lines only: a string literal that is test DATA is not prose about a person. */
function proseLines(file: string, source: string): ReadonlyArray<{ readonly line: number; readonly text: string }> {
	const markdown = path.extname(file) === ".md";
	const out: { line: number; text: string }[] = [];
	let inFence = false;
	source.split("\n").forEach((raw, index) => {
		const trimmed = raw.trim();
		if (markdown) {
			if (trimmed.startsWith("```")) inFence = !inFence;
			else if (!inFence && trimmed.length > 0) out.push({ line: index + 1, text: raw });
			return;
		}
		const isComment =
			trimmed.startsWith("//") ||
			trimmed.startsWith("*") ||
			trimmed.startsWith("/*") ||
			(trimmed.startsWith("#") && !trimmed.startsWith("#!") && !trimmed.startsWith("#["));
		if (isComment) out.push({ line: index + 1, text: raw });
	});
	return out;
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
			for (const { line, text } of proseLines(file, source)) {
				for (const { name, pattern } of BANNED) {
					if (pattern.test(text)) violations.push(`${file}:${line} (${name}): ${text.trim()}`);
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
		];
		for (const line of legal) {
			for (const { name, pattern } of BANNED) {
				expect(pattern.test(line), `${name} must not match: ${line}`).toBe(false);
			}
		}
	});
});
