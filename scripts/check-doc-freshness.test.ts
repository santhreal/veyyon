import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { checkFreshness, listInternalDocs, NEAR_MISS_PATTERN, parseStamp, STAMP_PATTERN } from "./check-doc-freshness";

describe("parseStamp", () => {
	it("parses a well-formed stamp on the last line", () => {
		const doc = "# Title\n\nBody.\n\n*Verified against `11c84f4` on 2026-07-16.*\n";
		expect(parseStamp(doc)).toEqual({ sha: "11c84f4", date: "2026-07-16" });
	});

	it("accepts a full 40-char sha", () => {
		const sha = "a".repeat(40);
		expect(parseStamp(`x\n*Verified against \`${sha}\` on 2025-01-02.*`)).toEqual({ sha, date: "2025-01-02" });
	});

	it("returns null for unstamped docs", () => {
		expect(parseStamp("# Title\n\nBody only.\n")).toBeNull();
	});

	it("returns null when the stamp is not the last non-empty line", () => {
		expect(parseStamp("*Verified against `abcdef1` on 2026-01-01.*\n\nTrailing prose.\n")).toBeNull();
	});

	it("rejects malformed shas and dates", () => {
		expect(parseStamp("x\n*Verified against `xyz` on 2026-01-01.*")).toBeNull();
		expect(parseStamp("x\n*Verified against `abcdef1` on 2026-1-1.*")).toBeNull();
	});

	it("STAMP_PATTERN matches only the exact footer shape", () => {
		expect("*Verified against `abcdef1` on 2026-01-01.*").toMatch(STAMP_PATTERN);
		expect("Verified against `abcdef1` on 2026-01-01.").not.toMatch(STAMP_PATTERN);
	});
});

/** Build a throwaway git repo with one committed doc per fixture. */
function makeRepo(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "doc-freshness-"));
	const run = (args: string[]) => {
		const result = spawnSync("git", args, { cwd: root, encoding: "utf-8" });
		if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
		return result.stdout.trim();
	};
	run(["init", "-q"]);
	run(["config", "user.email", "test@test"]);
	run(["config", "user.name", "test"]);
	fs.mkdirSync(path.join(root, "docs/internal"), { recursive: true });
	return root;
}

function commit(root: string, file: string, content: string, dateIso: string): string {
	fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
	fs.writeFileSync(path.join(root, file), content);
	const env = { ...process.env, GIT_AUTHOR_DATE: `${dateIso}T12:00:00`, GIT_COMMITTER_DATE: `${dateIso}T12:00:00` };
	for (const args of [
		["add", file],
		["commit", "-q", "-m", `edit ${file}`],
	]) {
		const result = spawnSync("git", args, { cwd: root, encoding: "utf-8", env });
		if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
	}
	return spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, encoding: "utf-8" }).stdout.trim();
}

describe("checkFreshness", () => {
	it("counts unstamped docs without failing them", () => {
		const root = makeRepo();
		commit(root, "docs/internal/a.md", "# A\n\nNo stamp.\n", "2026-01-10");
		const result = checkFreshness(root, ["docs/internal/a.md"]);
		expect(result.filesChecked).toBe(1);
		expect(result.stamped).toBe(0);
		expect(result.unstamped).toEqual(["docs/internal/a.md"]);
		expect(result.issues).toEqual([]);
	});

	it("passes a stamped doc whose stamp postdates its last edit", () => {
		const root = makeRepo();
		const sha = commit(root, "docs/internal/b.md", "# B\n\nBody.\n", "2026-01-10");
		commit(
			root,
			"docs/internal/b.md",
			`# B\n\nBody.\n\n*Verified against \`${sha}\` on 2026-01-10.*\n`,
			"2026-01-10",
		);
		const result = checkFreshness(root, ["docs/internal/b.md"]);
		expect(result.stamped).toBe(1);
		expect(result.issues).toEqual([]);
	});

	it("fails a doc edited after its verification stamp", () => {
		const root = makeRepo();
		const sha = commit(
			root,
			"docs/internal/c.md",
			"# C\n\nOld body.\n\n*Verified against `HEAD` on 2026-01-10.*\n",
			"2026-01-10",
		);
		commit(
			root,
			"docs/internal/c.md",
			`# C\n\nNew body.\n\n*Verified against \`${sha}\` on 2026-01-10.*\n`,
			"2026-03-01",
		);
		const result = checkFreshness(root, ["docs/internal/c.md"]);
		expect(result.issues).toHaveLength(1);
		expect(result.issues[0].file).toBe("docs/internal/c.md");
		expect(result.issues[0].reason).toContain("after its 2026-01-10 verification stamp");
	});

	it("reports a tracked-but-deleted file as missing instead of crashing", () => {
		const root = makeRepo();
		commit(root, "docs/internal/gone.md", "# Gone\n", "2026-01-10");
		fs.rmSync(path.join(root, "docs/internal/gone.md"));
		const result = checkFreshness(root, ["docs/internal/gone.md"]);
		expect(result.missing).toEqual(["docs/internal/gone.md"]);
		expect(result.filesChecked).toBe(0);
		expect(result.issues).toEqual([]);
	});

	/**
	 * The blind spot this rule closes. Both of these lines shipped in real docs and
	 * both parsed to null, so the gate filed them under "unstamped" and never
	 * checked a single later edit against them, while a reader saw the word
	 * "Verified" and believed the page had been checked.
	 */
	it.each([
		"*Verified against tree on 2026-07-21.*",
		"*Verified against the scroll-tape change on 2026-07-24.*",
		"*Verified against `abcdef1`.*",
		"*Verified against `abcdef1` on 2026-1-1.*",
		"Verified against `abcdef1` on 2026-01-01.",
	])("fails a doc whose last line claims verification it cannot prove: %s", claim => {
		const root = makeRepo();
		commit(root, "docs/internal/near.md", `# Near\n\nBody.\n\n${claim}\n`, "2026-01-10");

		const result = checkFreshness(root, ["docs/internal/near.md"]);

		expect(result.issues).toHaveLength(1);
		expect(result.unstamped).toEqual([]);
		expect(result.stamped).toBe(0);
		expect(result.issues[0].reason).toContain("cannot read");
		// The message has to name the exact accepted shape, or the author's next
		// attempt is another guess at it.
		expect(result.issues[0].reason).toContain("*Verified against `<sha>` on YYYY-MM-DD.*");
	});

	/** A doc that makes no claim at all is still fine. Stamping is earned, so
	 *  silence is honest and must not be turned into an error by this rule. */
	it("still passes a doc with no verification claim anywhere", () => {
		const root = makeRepo();
		commit(root, "docs/internal/quiet.md", "# Quiet\n\nNo claim.\n", "2026-01-10");

		const result = checkFreshness(root, ["docs/internal/quiet.md"]);

		expect(result.unstamped).toEqual(["docs/internal/quiet.md"]);
		expect(result.issues).toEqual([]);
	});

	/** The claim only counts as a claim when it is the FOOTER. `toolconv/deepseek.md`
	 *  cites its upstream source with "Verified against:" in a blockquote mid-page,
	 *  which is prose about a model card, not an assertion about this repository. */
	it("ignores a verification claim that is not the last line", () => {
		const root = makeRepo();
		commit(
			root,
			"docs/internal/cited.md",
			"# Cited\n\n> Verified against: the upstream model card.\n\nMore prose follows.\n",
			"2026-01-10",
		);

		const result = checkFreshness(root, ["docs/internal/cited.md"]);

		expect(result.unstamped).toEqual(["docs/internal/cited.md"]);
		expect(result.issues).toEqual([]);
	});

	it("fails a stamp pointing at a nonexistent commit", () => {
		const root = makeRepo();
		commit(
			root,
			"docs/internal/d.md",
			"# D\n\nBody.\n\n*Verified against `deadbeefdeadbeefdeadbeefdeadbeefdeadbeef` on 2099-01-01.*\n",
			"2026-01-10",
		);
		const result = checkFreshness(root, ["docs/internal/d.md"]);
		expect(result.issues).toHaveLength(1);
		expect(result.issues[0].reason).toContain("does not exist");
	});
});

describe("real repo", () => {
	/** The two docs this rule was written for are fixed, and no third one has crept
	 *  in. Without this, the rule could be satisfied by a passing unit test while a
	 *  real doc still carried an unreadable claim. */
	it("no internal doc ends with a verification claim the gate cannot read", () => {
		const root = path.resolve(import.meta.dir, "..");
		const offenders: string[] = [];
		for (const file of listInternalDocs(root)) {
			const abs = path.join(root, file);
			if (!fs.existsSync(abs)) continue;
			const lines = fs.readFileSync(abs, "utf-8").trimEnd().split("\n");
			const last = lines[lines.length - 1]?.trim() ?? "";
			if (NEAR_MISS_PATTERN.test(last) && !STAMP_PATTERN.test(last)) offenders.push(`${file}: ${last}`);
		}

		expect(offenders).toEqual([]);
	});

	it("every stamped doc in docs/internal passes the gate right now", () => {
		const root = path.resolve(import.meta.dir, "..");
		const result = checkFreshness(root, listInternalDocs(root));
		expect(result.filesChecked).toBeGreaterThan(40);
		expect(result.issues).toEqual([]);
	});
});
