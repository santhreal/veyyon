/**
 * Contracts for the session-transcript naming rules: one extension, one advisor stem, and helpers that mean
 * what their names say.
 *
 * WHY THIS SUITE EXISTS. The extension is a WRITER-AND-SCANNER contract. `session/session-manager.ts` builds
 * `<timestamp>_<id>.jsonl`; `session/session-listing.ts`, `cli/gc-cli.ts`, `export/html`, `debug/report-bundle.ts`,
 * `registry/persisted-subagents.ts`, `internal-urls/registry-helpers.ts` and `@veyyon/stats`'s parser all
 * DISCOVER transcripts by matching it. It was spelled inline at dozens of sites in four packages, plus three
 * constants that shared no name: `JSONL_SUFFIX`, `SESSION_SUFFIX` and `JSONL_SUFFIX_LENGTH`, the last of which
 * was the value expressed as a number so a grep for the extension never found it. `tools/read.ts` had a fourth
 * form, `slice(0, -6)`.
 *
 * THE FAILURE IS SILENT AND IT LOSES DATA FROM THE USER'S POINT OF VIEW. Nothing throws when a scanner stops
 * matching what the writer produces: sessions keep being written and simply stop being listed, resumed,
 * garbage-collected or counted, because an empty directory listing is a valid answer. The advisor half is the
 * same shape across a package boundary: `@veyyon/stats` cannot import the coding agent, so it had declared
 * `"__advisor.jsonl"` itself, and a stem change would have moved the writer while leaving the classifier
 * counting advisor transcripts as ordinary subagent sessions.
 *
 * The cases below pin the exact bytes, prove each helper against the forms callers actually hold, and cover
 * the two idempotence traps that a naive implementation gets wrong.
 */

import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import {
	ADVISOR_TRANSCRIPT_FILENAME,
	ADVISOR_TRANSCRIPT_PREFIX,
	ADVISOR_TRANSCRIPT_STEM,
	advisorTranscriptSlug,
	isAdvisorTranscriptName,
	isSessionBackupName,
	isSessionFileName,
	SESSION_BACKUP_EXTENSION,
	SESSION_FILE_EXTENSION,
	sessionBackupName,
	sessionBackupPrimaryName,
	sessionFileName,
	sessionFileStem,
} from "../src/session-file";

describe("the session file extension", () => {
	/** The exact bytes, including the leading dot. Callers concatenate it, so the dot is part of the value. */
	it("is .jsonl, dot included", () => {
		expect(SESSION_FILE_EXTENSION).toBe(".jsonl");
	});

	/** Six characters. The old `slice(0, -6)` in `tools/read.ts` was this length written as a magic number. */
	it("is six characters long, which is what the magic 6 in read.ts used to be", () => {
		expect(SESSION_FILE_EXTENSION.length).toBe(6);
	});
});

describe("isSessionFileName", () => {
	/** The writer's own output, in the two shapes it produces: a top-level session and a nested subagent. */
	it("matches what the session manager writes", () => {
		expect(isSessionFileName("20260726-120000_01ABCDEF.jsonl")).toBeTrue();
		expect(isSessionFileName("SubAgent7.jsonl")).toBeTrue();
	});

	/** A full path, since several callers pass one rather than a basename. */
	it("matches a full path", () => {
		expect(isSessionFileName(path.join("/home/u/.veyyon/agent/sessions/proj", "a.jsonl"))).toBeTrue();
	});

	/** The neighbours in a session directory that are NOT transcripts, each of which a scanner must skip. */
	it("rejects the neighbours that live beside a transcript", () => {
		expect(isSessionFileName("session.jsonl.gz")).toBeFalse();
		expect(isSessionFileName("session.jsonl.01ABCDEF.bak")).toBeFalse();
		expect(isSessionFileName("artifacts")).toBeFalse();
		expect(isSessionFileName("notes.md")).toBeFalse();
		expect(isSessionFileName("")).toBeFalse();
	});

	/**
	 * Case-sensitive, matching how the writer spells it. A case-insensitive match would classify a
	 * hand-renamed `.JSONL` as a transcript on Linux, where the writer will never produce one.
	 */
	it("is case-sensitive", () => {
		expect(isSessionFileName("session.JSONL")).toBeFalse();
	});

	/** The extension alone is not a transcript name, since a stem of `""` is not an id. */
	it("still matches a bare extension, which is what endsWith means", () => {
		expect(isSessionFileName(".jsonl")).toBeTrue();
	});
});

describe("sessionFileStem", () => {
	/** The ordinary case: drop the extension, keep everything else. */
	it("drops the extension", () => {
		expect(sessionFileStem("20260726-120000_01ABCDEF.jsonl")).toBe("20260726-120000_01ABCDEF");
	});

	/**
	 * And it leaves the DIRECTORY alone, which is the difference from `path.basename(file, ".jsonl")`. Some
	 * callers wanted a sibling path built from the stem, and `basename` would have thrown the directory away.
	 */
	it("leaves the directory part alone, unlike path.basename", () => {
		const full = "/home/u/.veyyon/agent/sessions/proj/a.jsonl";
		expect(sessionFileStem(full)).toBe("/home/u/.veyyon/agent/sessions/proj/a");
		expect(path.basename(full, ".jsonl")).toBe("a");
	});

	/**
	 * A name that does not carry the extension comes back UNCHANGED. The slice form it replaces would have
	 * cut six characters off regardless, turning an id into a truncated id with nothing raised.
	 */
	it("returns a name without the extension unchanged", () => {
		expect(sessionFileStem("SubAgent7")).toBe("SubAgent7");
		expect(sessionFileStem("short")).toBe("short");
		expect(sessionFileStem("")).toBe("");
	});

	/** Only the LAST extension goes, so a stem containing a dot survives. */
	it("strips only the trailing extension", () => {
		expect(sessionFileStem("__advisor.reviewer.jsonl")).toBe("__advisor.reviewer");
	});
});

describe("sessionFileName", () => {
	/** The ordinary case: a stem becomes a transcript name. */
	it("applies the extension to a stem", () => {
		expect(sessionFileName("SubAgent7")).toBe("SubAgent7.jsonl");
	});

	/**
	 * IDEMPOTENT, which is the trap. Callers hold both forms, and an unconditional append produces
	 * `<id>.jsonl.jsonl`, a name every scanner here would happily list as a session because it ends with the
	 * extension. The file would then be a transcript nobody wrote.
	 */
	it("does not double the extension", () => {
		expect(sessionFileName("SubAgent7.jsonl")).toBe("SubAgent7.jsonl");
		expect(sessionFileName(sessionFileName("SubAgent7"))).toBe("SubAgent7.jsonl");
	});

	/** Round-trip with the stem helper, in both directions, which is what the writer and scanners rely on. */
	it("round-trips with sessionFileStem", () => {
		for (const stem of ["a", "20260726-120000_01ABCDEF", "__advisor", "__advisor.reviewer", "orphan-task-9"]) {
			expect(sessionFileStem(sessionFileName(stem)), stem).toBe(stem);
			expect(isSessionFileName(sessionFileName(stem)), stem).toBeTrue();
		}
	});
});

describe("the session backup naming", () => {
	/**
	 * The suffix and, more importantly, the FORMAT. A backup is only ever produced when
	 * `session/session-storage.ts` cannot rename a temp file over the live transcript (Windows EPERM, a
	 * scanner or an editor holding the handle) and moves the live one aside first.
	 */
	it("names a backup <primary>.<id>.bak", () => {
		expect(SESSION_BACKUP_EXTENSION).toBe(".bak");
		expect(sessionBackupName("a.jsonl", "01ABCDEF")).toBe("a.jsonl.01ABCDEF.bak");
		expect(sessionBackupName("20260726-120000_01H.jsonl", 12345)).toBe("20260726-120000_01H.jsonl.12345.bak");
	});

	/**
	 * THE ROUND TRIP, which is the whole point of the pair. The writer's template and the reader's parse
	 * lived one file apart and were written independently. If they disagreed, a user who hit the EPERM path
	 * would keep the only copy of a session in a file that nothing recovers, nothing lists and nothing
	 * collects, which is indistinguishable from having lost the session.
	 */
	it("reads back exactly what it writes", () => {
		for (const primary of ["a.jsonl", "SubAgent7.jsonl", "__advisor.reviewer.jsonl"]) {
			for (const id of ["01ABCDEF", 7, 1755300000000]) {
				const backup = sessionBackupName(primary, id);
				expect(isSessionBackupName(backup), backup).toBeTrue();
				expect(sessionBackupPrimaryName(backup), backup).toBe(primary);
			}
		}
	});

	/**
	 * A backup is NOT itself a transcript, which is what keeps it out of every session listing. The Agent Control Center
	 * and HTML export both rely on this: a backup appearing as a session would show the user a duplicate of a
	 * session they already have, dated from a crash.
	 */
	it("is not a session file name", () => {
		expect(isSessionFileName(sessionBackupName("a.jsonl", "1"))).toBeFalse();
	});

	/**
	 * And `undefined` rather than a guess for anything that does not fit, INCLUDING a `.bak` whose primary is
	 * not a transcript. This one is not a tidiness point: recovery RENAMES the backup over the returned path,
	 * so a wrong answer here does not spoil a listing, it overwrites a file.
	 */
	it("refuses to guess a primary it cannot read", () => {
		expect(sessionBackupPrimaryName("notes.md")).toBeUndefined();
		expect(sessionBackupPrimaryName("a.jsonl")).toBeUndefined();
		// A backup of something that is not a session: the update CLI writes `<binary>.<ts>.<pid>.bak`.
		expect(sessionBackupPrimaryName("veyyon.1755300000000.4242.bak")).toBeUndefined();
		// No id segment at all.
		expect(sessionBackupPrimaryName("a.jsonl.bak")).toBeUndefined();
		// An empty id segment.
		expect(sessionBackupPrimaryName("a.jsonl..bak")).toBeUndefined();
		// Nothing before the id.
		expect(sessionBackupPrimaryName(".01ABCDEF.bak")).toBeUndefined();
		expect(sessionBackupPrimaryName("")).toBeUndefined();
	});

	/**
	 * The newest-wins rule the recovery loop applies needs several backups of ONE primary to collapse to that
	 * primary, which is what makes "pick the newest by mtime" a choice between candidates rather than a
	 * coincidence.
	 */
	it("maps every backup of one transcript back to the same primary", () => {
		const primaries = ["01A", "01B", "01C"].map(id => sessionBackupPrimaryName(sessionBackupName("a.jsonl", id)));
		expect(primaries).toEqual(["a.jsonl", "a.jsonl", "a.jsonl"]);
	});
});

describe("the advisor transcript naming", () => {
	/** The exact bytes both the writer and `@veyyon/stats`'s classifier depend on. */
	it("names the default advisor's transcript __advisor.jsonl", () => {
		expect(ADVISOR_TRANSCRIPT_STEM).toBe("__advisor");
		expect(ADVISOR_TRANSCRIPT_FILENAME).toBe("__advisor.jsonl");
		expect(ADVISOR_TRANSCRIPT_PREFIX).toBe("__advisor.");
	});

	/**
	 * The filename is DERIVED from the stem rather than spelled again, so the two cannot drift. Asserted as a
	 * value relationship, since that is what the derivation buys.
	 */
	it("derives the filename from the stem", () => {
		expect(ADVISOR_TRANSCRIPT_FILENAME).toBe(sessionFileName(ADVISOR_TRANSCRIPT_STEM));
		expect(ADVISOR_TRANSCRIPT_PREFIX).toBe(`${ADVISOR_TRANSCRIPT_STEM}.`);
	});

	/**
	 * The leading underscores are what keeps the advisor out of the task-subagent id namespace. If a subagent
	 * could be handed the id `__advisor`, its transcript would be classified as the advisor's and its usage
	 * would be attributed to the wrong agent.
	 */
	it("uses a stem a task id cannot produce", () => {
		expect(ADVISOR_TRANSCRIPT_STEM.startsWith("__")).toBeTrue();
	});

	/** Both advisor forms classify, the default and a named one. */
	it("recognises the default and named advisor transcripts", () => {
		expect(isAdvisorTranscriptName("__advisor.jsonl")).toBeTrue();
		expect(isAdvisorTranscriptName("__advisor.reviewer.jsonl")).toBeTrue();
		expect(isAdvisorTranscriptName("__advisor.a.b.jsonl")).toBeTrue();
	});

	/**
	 * And a task subagent's transcript does NOT, which is the half that keeps the stats split honest: every
	 * nested transcript that is not an advisor's is counted as a subagent's.
	 */
	it("rejects a subagent transcript and the near misses", () => {
		expect(isAdvisorTranscriptName("SubAgent7.jsonl")).toBeFalse();
		expect(isAdvisorTranscriptName("20260726-120000_01ABCDEF.jsonl")).toBeFalse();
		// The stem without the separator: a subagent literally named `__advisorial` is not the advisor.
		expect(isAdvisorTranscriptName("__advisorial.jsonl")).toBeFalse();
		// The right name with the wrong extension is a backup, not a transcript.
		expect(isAdvisorTranscriptName("__advisor.jsonl.gz")).toBeFalse();
		expect(isAdvisorTranscriptName("__advisor")).toBeFalse();
	});

	/** The slug, which the Agent Control Center shows: empty for the default advisor, the name for a named one. */
	it("reads the slug of a named advisor and empty for the default", () => {
		expect(advisorTranscriptSlug("__advisor.jsonl")).toBe("");
		expect(advisorTranscriptSlug("__advisor.reviewer.jsonl")).toBe("reviewer");
		expect(advisorTranscriptSlug("__advisor.a.b.jsonl")).toBe("a.b");
	});

	/** And the slug round-trips back to the filename the recorder writes. */
	it("round-trips a slug through the filename", () => {
		for (const slug of ["reviewer", "a.b", "x"]) {
			const name = sessionFileName(`${ADVISOR_TRANSCRIPT_PREFIX}${slug}`);
			expect(isAdvisorTranscriptName(name), slug).toBeTrue();
			expect(advisorTranscriptSlug(name), slug).toBe(slug);
		}
	});
});

describe("the naming module has one owner", () => {
	/**
	 * The ratchet, keyed on the LITERAL rather than on a constant name, because the three copies it replaced
	 * had three different names and one of them was a length rather than a string. A name-keyed check would
	 * have found none of them.
	 *
	 * Scoped to the modules that speak this contract, and `memories/` is in that list because of a mistake
	 * worth keeping: it was first judged a separate corpus and is not one. `collectThreads` reads
	 * `sessionManager.getSessionDir()` and scans it for transcripts, so it speaks exactly this contract. The
	 * DIRECTORY a scan runs over decides that, not the module the scan lives in.
	 *
	 * Other `.jsonl` files exist and are deliberately NOT this one, each checked the same way: `collab/guest.ts`
	 * writes a room replica under the collab dir, `autoresearch` names a legacy artifact it cleans out of a work
	 * dir, and `@veyyon/metaharness` writes job records. `debug/` is left out of the scan for a different
	 * reason: `report-bundle.ts` declares `session.jsonl` as a fixed ENTRY NAME inside a debug bundle, so every
	 * bundle has the same layout whatever session produced it. That is a name for a place in an archive, not the
	 * extension a scanner matches.
	 */
	it("declares the extension nowhere else in the session and stats paths", async () => {
		const repoRoot = path.resolve(import.meta.dir, "../../..");
		const scanned = [
			"packages/coding-agent/src/session",
			"packages/coding-agent/src/advisor",
			"packages/coding-agent/src/internal-urls",
			"packages/coding-agent/src/memories",
			"packages/stats/src",
		];
		const offenders: string[] = [];
		let filesRead = 0;
		for (const dir of scanned) {
			for (const rel of new Bun.Glob("**/*.ts").scanSync(path.join(repoRoot, dir))) {
				if (rel.includes("__tests__")) continue;
				const file = path.join(dir, rel);
				const text = await Bun.file(path.join(repoRoot, file)).text();
				filesRead += 1;
				for (const line of text.split("\n")) {
					const code = line.trim();
					// Prose in a doc comment names the extension on purpose; a declaration does not.
					if (code.startsWith("*") || code.startsWith("//")) continue;
					if (code.includes('".jsonl"') || code.includes('"__advisor.jsonl"')) offenders.push(`${file}: ${code}`);
				}
			}
		}
		expect(offenders).toEqual([]);
		// Non-vacuity: the scan really read the modules that used to hold the copies.
		expect(filesRead).toBeGreaterThan(20);
	});

	/** The positive half: the writer and the two scanners that matter reach the owner. */
	it("has the writer and the scanners importing the owner", async () => {
		const repoRoot = path.resolve(import.meta.dir, "../../..");
		for (const file of [
			"packages/coding-agent/src/session/session-manager.ts",
			"packages/coding-agent/src/session/session-listing.ts",
			"packages/coding-agent/src/cli/gc-cli.ts",
			"packages/stats/src/parser.ts",
		]) {
			const text = await Bun.file(path.join(repoRoot, file)).text();
			expect(text, file).toContain('from "@veyyon/utils/session-file"');
		}
	});

	/** The owner is a leaf, so a package pays one module for the contract. */
	it("imports nothing", async () => {
		const owner = await Bun.file(path.resolve(import.meta.dir, "../src/session-file.ts")).text();
		expect(owner).not.toMatch(/^\s*import\s/m);
		expect(owner).not.toMatch(/\bfrom\s+"/);
	});
});
