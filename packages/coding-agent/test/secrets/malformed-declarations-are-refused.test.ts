/**
 * A `secrets.yml` entry that is not a valid declaration stops the session.
 *
 * WHY THIS SUITE EXISTS, and it is the inside-out version of the bug the whole secrets subsystem
 * was built to prevent. Every validation branch in `validateEntry` used to be `logger.warn`
 * followed by `return false`. The default transport set is `{ file: true }` with no console
 * transport (`logger.ts:219`), and no TUI can write to the console without corrupting its render,
 * so the warning reached nobody. The consequence was not a cosmetic one: an operator who wrote
 * `type: plaintext` instead of `type: plain` had that entry dropped, was told nothing, and the
 * credential they had just declared secret went to the model provider in plain text. The session
 * started cleanly and reported success. The handbook said "a malformed or unreadable `secrets.yml`
 * also stops startup" while the code warned into a file, so this was a documented security behaviour
 * the code did not have.
 *
 * So what these tests pin is not "invalid input is rejected" in the abstract. It is:
 *
 *   1. Each malformed shape REFUSES rather than skipping, one test per field, because a skip is
 *      indistinguishable from working and the whole file is security-relevant.
 *   2. The message names the entry index and the fix, so the refusal is actionable rather than
 *      merely strict.
 *   3. EVERY problem in the file is reported at once, so three typos cost one restart.
 *   4. A plain entry's `content` is NEVER quoted back, because that is the credential and a
 *      malformed declaration is no reason for a secret to appear in an error message.
 *   5. Valid files still load, so the refusal has not been bought by refusing everything.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { loadSecrets } from "@veyyon/coding-agent/secrets";

let root: string;
let projectDir: string;
let profileDir: string;

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-secrets-yml-"));
	projectDir = path.join(root, "project");
	profileDir = path.join(root, "profile");
	await fs.mkdir(path.join(projectDir, ".veyyon"), { recursive: true });
	await fs.mkdir(profileDir, { recursive: true });
});

afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true });
});

/** Write the project-level `secrets.yml`, which is the file every test below declares in. */
async function writeProjectSecrets(yaml: string): Promise<void> {
	await fs.writeFile(path.join(projectDir, ".veyyon", "secrets.yml"), yaml);
}

/** Load, returning the thrown message so a test can assert on its wording. */
async function loadAndCatch(): Promise<string> {
	try {
		await loadSecrets(projectDir, profileDir);
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	throw new Error("loadSecrets resolved, but the file it read was supposed to be refused.");
}

describe("an entry with an unusable type", () => {
	/**
	 * THE ORIGINAL BUG, in the shape it actually takes in the wild.
	 *
	 * `plaintext` is the natural typo for `plain`, and it used to drop the entry silently. The
	 * refusal has to name what the valid values are, because "invalid type" alone does not tell an
	 * operator that the word they want is `plain`.
	 */
	it("refuses, naming both valid types", async () => {
		await writeProjectSecrets(`- type: plaintext\n  content: sk-live-abcdefghijklmnop\n`);

		const message = await loadAndCatch();

		expect(message).toContain("Refusing to start");
		expect(message).toContain("entry 0");
		expect(message).toContain('type "plaintext"');
		expect(message).toContain('"plain"');
		expect(message).toContain('"regex"');
	});

	/** A missing `type` is the same refusal, reported as `null` rather than as a crash. */
	it("refuses an entry with no type at all", async () => {
		await writeProjectSecrets(`- content: sk-live-abcdefghijklmnop\n`);

		const message = await loadAndCatch();

		expect(message).toContain("entry 0");
		expect(message).toContain("type null");
	});
});

describe("an entry whose content is unusable", () => {
	/**
	 * Refused, and the message does NOT contain the content.
	 *
	 * This is the one field whose value is the credential. An error message that helpfully quoted
	 * "the content you gave" would print the secret to the terminal, into the scrollback, and into
	 * whatever CI log captured startup. So the message describes the field instead.
	 */
	it("refuses a non-string content without quoting it", async () => {
		await writeProjectSecrets(`- type: plain\n  content: 12345678901234567890\n`);

		const message = await loadAndCatch();

		expect(message).toContain("entry 0");
		expect(message).toContain('non-empty "content"');
		expect(message).not.toContain("12345678901234567890");
	});

	/** An empty string declares nothing and would match everywhere, so it is refused too. */
	it("refuses an empty content", async () => {
		await writeProjectSecrets(`- type: plain\n  content: ""\n`);

		expect(await loadAndCatch()).toContain('non-empty "content"');
	});
});

describe("unknown declaration fields", () => {
	/**
	 * A near-miss field name is refused rather than ignored.
	 *
	 * Ignoring `replacment` would start successfully while using a different replacement from the
	 * one the operator requested. The diagnostic names the field but never its value or `content`,
	 * either of which may itself be sensitive.
	 */
	it("refuses a field typo without quoting secret-bearing values", async () => {
		const secret = "sk-live-field-typo-must-not-leak";
		const replacement = "private-mask-must-not-leak";
		await writeProjectSecrets(`- type: plain\n  content: ${secret}\n  mode: replace\n  replacment: ${replacement}\n`);

		const message = await loadAndCatch();

		expect(message).toContain('unknown field "replacment"');
		expect(message).toContain("Allowed fields");
		expect(message).not.toContain(secret);
		expect(message).not.toContain(replacement);
	});

	/** Even a valid declaration is refused when an extra unsupported field would otherwise be dropped. */
	it("refuses an extra unsupported field", async () => {
		await writeProjectSecrets(`- type: plain\n  content: sk-live-abcdefghijklmnop\n  owner: platform\n`);

		expect(await loadAndCatch()).toContain('unknown field "owner"');
	});
});

describe("an entry with an unusable mode", () => {
	/**
	 * Refused, and the message says which mode is reversible.
	 *
	 * The distinction is the whole reason two modes exist, so a refusal that only listed the two
	 * words would leave the operator guessing which one they meant.
	 */
	it("refuses, saying what each mode does", async () => {
		await writeProjectSecrets(`- type: plain\n  content: sk-live-abcdefghijklmnop\n  mode: hide\n`);

		const message = await loadAndCatch();

		expect(message).toContain('mode "hide"');
		expect(message).toContain("reversible");
		expect(message).toContain("one-way");
	});
});

describe("incompatible declaration fields", () => {
	/**
	 * Flags change regex matching and have no meaning for an exact plain value.
	 *
	 * Silently accepting the field would tell an operator case-insensitive coverage exists when it
	 * does not. The secret itself remains absent from the diagnostic.
	 */
	it("refuses regex flags on a plain entry without quoting its content", async () => {
		const secret = "sk-live-flags-on-plain-must-not-leak";
		await writeProjectSecrets(`- type: plain\n  content: ${secret}\n  flags: i\n`);

		const message = await loadAndCatch();

		expect(message).toContain('"flags"');
		expect(message).toContain("regex entries only");
		expect(message).not.toContain(secret);
	});

	/**
	 * A replacement is consulted only by replace mode.
	 *
	 * Refusing it in the default obfuscate mode prevents a plausible configuration from appearing
	 * to honour a mask that the runtime never reads.
	 */
	it("refuses replacement outside replace mode", async () => {
		const secret = "sk-live-unused-replacement-must-not-leak";
		await writeProjectSecrets(`- type: plain\n  content: ${secret}\n  replacement: hidden\n`);

		const message = await loadAndCatch();

		expect(message).toContain('"replacement"');
		expect(message).toContain('"mode" is "replace"');
		expect(message).not.toContain(secret);
	});

	/** Replace mode has no length floor, so accepting `minLength` there would silently ignore it. */
	it("refuses minLength on a replace-mode regex", async () => {
		await writeProjectSecrets(`- type: regex\n  content: "token-[A-Za-z0-9]+"\n  mode: replace\n  minLength: 12\n`);

		const message = await loadAndCatch();

		expect(message).toContain("minLength");
		expect(message).toContain('"replace" mode');
		expect(message).toContain("no length floor");
	});
});

describe("minLength on a plain entry", () => {
	/**
	 * Refused, because ignoring it is a lie about coverage.
	 *
	 * `minLength` is a floor on how short a REGEX MATCH may be. On a plain entry there is no match
	 * to bound, so the field does nothing. An operator who set it on a 4-character plain secret set
	 * it precisely because they wanted that short secret protected, and the old behaviour dropped
	 * the whole entry, leaving the value they were trying to cover completely unprotected. The
	 * refusal names `mode: replace`, which is the thing that actually works for a short value.
	 */
	it("refuses and names the option that does work for a short value", async () => {
		await writeProjectSecrets(`- type: plain\n  content: shortpw\n  minLength: 4\n`);

		const message = await loadAndCatch();

		expect(message).toContain("entry 0");
		expect(message).toContain("regex entries only");
		expect(message).toContain('"mode: replace"');
	});

	/** A non-integer floor is refused on its own terms, before the plain/regex question. */
	it("refuses a fractional minLength", async () => {
		await writeProjectSecrets(`- type: regex\n  content: "AKIA[0-9A-Z]{16}"\n  minLength: 2.5\n`);

		expect(await loadAndCatch()).toContain("whole number of 1 or more");
	});

	/** Zero would mean "match the empty string", which no pattern should be allowed to claim. */
	it("refuses a minLength of zero", async () => {
		await writeProjectSecrets(`- type: regex\n  content: "AKIA[0-9A-Z]{16}"\n  minLength: 0\n`);

		expect(await loadAndCatch()).toContain("whole number of 1 or more");
	});
});

describe("a regex that does not compile", () => {
	/**
	 * Refused with the pattern quoted, which is the opposite call from `content` on a plain entry.
	 *
	 * A pattern is not a credential. It is a rule the operator wrote, and quoting it back is what
	 * makes the error fixable without opening the file. The message also says what the cost of
	 * carrying on would have been, since a broken pattern protects nothing at all.
	 */
	it("refuses, quoting the pattern and the compiler's complaint", async () => {
		await writeProjectSecrets(`- type: regex\n  content: "AKIA[0-9A-Z{16}"\n`);

		const message = await loadAndCatch();

		expect(message).toContain("entry 0");
		expect(message).toContain("does not compile");
		expect(message).toContain("AKIA[0-9A-Z{16}");
		expect(message).toContain("unprotected");
	});
});

describe("a file with several problems", () => {
	/**
	 * Reports all of them in one refusal.
	 *
	 * Fail-fast on the first bad entry would make fixing a file an N-restart loop, and each restart
	 * of a coding agent is slow enough that an operator would be tempted to delete the file instead
	 * of fixing it. Every problem, once, so one pass through the file is enough.
	 */
	it("names every bad entry, with its index", async () => {
		await writeProjectSecrets(
			[
				`- type: plaintext`,
				`  content: sk-live-abcdefghijklmnop`,
				`- type: plain`,
				`  content: sk-live-qrstuvwxyzabcdef`,
				`- type: regex`,
				`  content: "AKIA[0-9A-Z{16}"`,
				`- type: plain`,
				`  content: shortpw`,
				`  minLength: 4`,
			].join("\n"),
		);

		const message = await loadAndCatch();

		expect(message).toContain("3 entries");
		expect(message).toContain("entry 0");
		expect(message).toContain("entry 2");
		expect(message).toContain("entry 3");
		// The one VALID entry is not complained about, so the count is the count of problems and
		// not of entries.
		expect(message).not.toContain("entry 1");
	});

	/** Singular wording for a single problem, because "1 entries" reads as a bug in the tool. */
	it("uses singular wording for one problem", async () => {
		await writeProjectSecrets(`- type: plaintext\n  content: sk-live-abcdefghijklmnop\n`);

		const message = await loadAndCatch();

		expect(message).toContain("1 entry");
		expect(message).not.toContain("1 entries");
	});
});

describe("a valid file", () => {
	/**
	 * Still loads, which is what keeps the refusals above meaningful.
	 *
	 * A guard that refuses everything is not a guard. This asserts the exact entries, including the
	 * defaulted `mode`, so a future tightening cannot pass by rejecting valid declarations.
	 */
	it("loads every entry, with mode defaulted", async () => {
		await writeProjectSecrets(
			[
				`- type: plain`,
				`  content: sk-live-abcdefghijklmnop`,
				`- type: regex`,
				`  content: "AKIA[0-9A-Z]{16}"`,
				`  minLength: 20`,
				`  flags: "i"`,
				`- type: plain`,
				`  content: hunter2`,
				`  mode: replace`,
				`  replacement: "********"`,
			].join("\n"),
		);

		const entries = await loadSecrets(projectDir, profileDir);

		expect(entries).toHaveLength(3);
		expect(entries[0]).toMatchObject({ type: "plain", content: "sk-live-abcdefghijklmnop", mode: "obfuscate" });
		expect(entries[1]).toMatchObject({ type: "regex", content: "AKIA[0-9A-Z]{16}", flags: "i", minLength: 20 });
		expect(entries[2]).toMatchObject({ type: "plain", content: "hunter2", mode: "replace", replacement: "********" });
	});

	/** A missing file is still empty, which is the one absence that is not a failure. */
	it("treats an absent file as nothing declared", async () => {
		expect(await loadSecrets(projectDir, profileDir)).toEqual([]);
	});
});

describe("the refused file's identity", () => {
	/**
	 * The message names WHICH file, because two are read.
	 *
	 * A refusal that says "secrets.yml is invalid" sends an operator to the wrong file half the
	 * time, and the profile-level one lives in a directory most people do not have open.
	 */
	it("names the profile file when the problem is there", async () => {
		await fs.writeFile(path.join(profileDir, "secrets.yml"), `- type: plaintext\n  content: sk-live-abcdefghij\n`);

		const message = await loadAndCatch();

		expect(message).toContain(path.join(profileDir, "secrets.yml"));
	});

	/** And the project file when it is there instead. */
	it("names the project file when the problem is there", async () => {
		await writeProjectSecrets(`- type: plaintext\n  content: sk-live-abcdefghij\n`);

		const message = await loadAndCatch();

		expect(message).toContain(path.join(projectDir, ".veyyon", "secrets.yml"));
	});
});
