/**
 * Which environment variable names are treated as holding a credential.
 *
 * WHY THIS SUITE EXISTS, AND WHY IT ASSERTS BOTH DIRECTIONS PER NAME. A detection list has two
 * failure modes and they pull against each other. Too narrow and a real credential is sent to the
 * provider in plain text. Too wide and an ordinary value is replaced by a placeholder everywhere it
 * appears, which shreds prose and paths throughout a transcript. Asserting only the names that
 * SHOULD match would let a later widening quietly start matching `TOKENIZER`, and asserting only
 * the exclusions would let the list rot the other way, so every name below is pinned in the
 * direction it belongs.
 *
 * The exclusions are the load-bearing half. `AUTHORIZED_USER` not matching is not an oversight the
 * next person should fix: obfuscating its value would blank out fragments of ordinary words
 * wherever that value occurred.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { collectEnvSecrets } from "@veyyon/coding-agent/secrets";
import {
	BUNDLED_ENV_KEYWORDS,
	buildEnvSecretPattern,
	ENV_KEYWORDS_FILENAME,
	loadEnvSecretKeywords,
} from "@veyyon/coding-agent/secrets/env-keywords";

const bundled = (): RegExp => buildEnvSecretPattern([...BUNDLED_ENV_KEYWORDS]);

let agentDir: string;
let cwd: string;

beforeEach(async () => {
	agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-envkw-agent-"));
	cwd = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-envkw-cwd-"));
});

afterEach(async () => {
	await fs.rm(agentDir, { recursive: true, force: true });
	await fs.rm(cwd, { recursive: true, force: true });
});

describe("names that are detected", () => {
	/** The ordinary cases, one per bundled keyword, in both boundary positions. */
	it("matches a keyword at the end of a name", () => {
		const pattern = bundled();
		for (const name of [
			"API_KEY",
			"CLIENT_SECRET",
			"DEPLOY_TOKEN",
			"DB_PASSWORD",
			"MY_PASS",
			"GPG_PASSPHRASE",
			"BASIC_AUTH",
			"AWS_CREDENTIAL",
			"SSH_PRIVATE",
			"GOOGLE_OAUTH",
		]) {
			expect(pattern.test(name)).toBe(true);
		}
	});

	/** And with the keyword followed by an underscore rather than ending the name. */
	it("matches a keyword followed by an underscore", () => {
		const pattern = bundled();
		for (const name of ["KEY_FILE", "SECRET_PATH", "TOKEN_URL", "PASSWORD_FILE", "AUTH_HEADER"]) {
			expect(pattern.test(name)).toBe(true);
		}
	});

	/**
	 * `PASSPHRASE`, the one genuine gap the original inline list had.
	 *
	 * `GPG_PASSPHRASE` was detected only because of the underscore in front of it. A bare
	 * `PASSPHRASE` matched nothing, because `PASS` is followed by `P` rather than by `_` or the end
	 * of the name, and it is a name people really use for a real secret.
	 */
	it("matches PASSPHRASE, which the old list missed", () => {
		expect(bundled().test("PASSPHRASE")).toBe(true);
		expect(bundled().test("PASSPHRASE_FILE")).toBe(true);
	});

	/**
	 * `APIKEY`, `PRIVKEY` and `SECRETKEY` need NO keyword of their own.
	 *
	 * They were filed as candidates for widening, and measuring showed the trailing-position half
	 * of the boundary rule already covers them: `KEY` ends each name. Pinned so nobody adds three
	 * redundant entries, and so a change to the boundary rule that broke them fails here.
	 */
	it("matches the compound KEY names without a keyword of their own", () => {
		const pattern = bundled();
		for (const name of ["APIKEY", "PRIVKEY", "SECRETKEY", "MY_APIKEY"]) {
			expect(pattern.test(name)).toBe(true);
		}
		expect(BUNDLED_ENV_KEYWORDS).not.toContain("APIKEY");
		expect(BUNDLED_ENV_KEYWORDS).not.toContain("PRIVKEY");
		expect(BUNDLED_ENV_KEYWORDS).not.toContain("SECRETKEY");
	});

	/** Case-insensitive, because a lowercase variable name is legal and people use them. */
	it("matches regardless of case", () => {
		expect(bundled().test("deploy_token")).toBe(true);
		expect(bundled().test("Api_Key")).toBe(true);
	});
});

describe("names that are deliberately NOT detected", () => {
	/**
	 * The keyword runs into the rest of the name, so it is not the name's subject.
	 *
	 * Each of these would be a false positive that replaced an ordinary value with a placeholder
	 * everywhere it appeared. They are correct exclusions, not gaps.
	 */
	it("does not match a keyword that runs into another word", () => {
		const pattern = bundled();
		for (const name of ["TOKENIZER", "SECRETIVE_THING", "AUTHORIZED_USER", "PASSTHROUGH", "KEYBOARD_LAYOUT"]) {
			expect(pattern.test(name)).toBe(false);
		}
	});

	/**
	 * `PWD` IS REFUSED, and it is the one candidate with a severe false positive.
	 *
	 * `PWD` is the POSIX current-working-directory variable. It exists in every shell and its value
	 * is a path that is almost always over the length floor, so detecting it would replace the
	 * user's working directory with a placeholder in every message that mentions a path. That is
	 * not protection, it is text corruption. `OLDPWD` is the same. Pinned as an exclusion so the
	 * candidate cannot be added without deleting this test and reading why.
	 */
	it("does not match PWD or OLDPWD", () => {
		expect(bundled().test("PWD")).toBe(false);
		expect(bundled().test("OLDPWD")).toBe(false);
		expect(BUNDLED_ENV_KEYWORDS).not.toContain("PWD");
	});

	/** Ordinary variables every shell has stay untouched. */
	it("does not match common non-secret variables", () => {
		const pattern = bundled();
		for (const name of ["HOME", "PATH", "SHELL", "TERM", "LANG", "USER", "EDITOR", "TMPDIR"]) {
			expect(pattern.test(name)).toBe(false);
		}
	});
});

describe("the pattern builder", () => {
	/**
	 * An EMPTY list matches NOTHING, not everything.
	 *
	 * The dangerous reading of an empty keyword list is an empty alternation, `(?:)(?:_|$)`, which
	 * matches essentially every name and would push every environment value through the obfuscator.
	 * "Detect nothing" is the only sane meaning of "no keywords".
	 */
	it("matches nothing when the list is empty", () => {
		const pattern = buildEnvSecretPattern([]);

		for (const name of ["API_KEY", "HOME", "", "ANYTHING_AT_ALL"]) {
			expect(pattern.test(name)).toBe(false);
		}
	});

	/**
	 * A keyword is escaped, so it is data and not a pattern.
	 *
	 * The bundled keywords need no escaping, but a user file is arbitrary text. An unescaped `.`
	 * would match any character and quietly widen detection well past what the operator wrote.
	 */
	it("treats a keyword with regex characters as a literal", () => {
		const pattern = buildEnvSecretPattern(["A.C"]);

		expect(pattern.test("A.C")).toBe(true);
		expect(pattern.test("ABC")).toBe(false);
	});

	/** The boundary rule is applied to a user keyword too, not just the bundled ones. */
	it("applies the boundary rule to a user keyword", () => {
		const pattern = buildEnvSecretPattern(["VAULTPASS"]);

		expect(pattern.test("VAULTPASS")).toBe(true);
		expect(pattern.test("VAULTPASS_FILE")).toBe(true);
		expect(pattern.test("VAULTPASSWORDLESS")).toBe(false);
	});

	/** An empty item is not an empty list: compiling it as an alternation would detect every variable. */
	it("refuses empty and whitespace-only keyword items", () => {
		expect(() => buildEnvSecretPattern([""])).toThrow(/empty environment-secret keyword/i);
		expect(() => buildEnvSecretPattern(["  \t"])).toThrow(/empty environment-secret keyword/i);
	});

	/** Direct callers receive the same whitespace normalization as keywords loaded from YAML. */
	it("trims and de-duplicates direct keyword input", () => {
		const pattern = buildEnvSecretPattern(["  CUSTOM_TOKEN  ", "custom_token"]);
		expect(pattern.test("MY_CUSTOM_TOKEN")).toBe(true);
	});
});

describe("loading the list from disk", () => {
	/** With no user file, the bundled list is what you get. */
	it("returns the bundled list when no user file exists", async () => {
		expect(await loadEnvSecretKeywords({ cwd, agentDir })).toEqual([...BUNDLED_ENV_KEYWORDS]);
	});

	/** A profile file adds to the list, which is the point of it being data. */
	it("adds keywords from the profile file", async () => {
		await fs.writeFile(path.join(agentDir, ENV_KEYWORDS_FILENAME), "keywords:\n  - VAULTPASS\n");

		const keywords = await loadEnvSecretKeywords({ cwd, agentDir });
		expect(keywords).toContain("VAULTPASS");
		expect(buildEnvSecretPattern(keywords).test("MY_VAULTPASS")).toBe(true);
	});

	/** A project file adds too, so a repository can cover its own variables. */
	it("adds keywords from the project file", async () => {
		await fs.mkdir(path.join(cwd, ".veyyon"), { recursive: true });
		await fs.writeFile(path.join(cwd, ".veyyon", ENV_KEYWORDS_FILENAME), "keywords:\n  - SCANSEED\n");

		expect(await loadEnvSecretKeywords({ cwd, agentDir })).toContain("SCANSEED");
	});

	/**
	 * A user file is ADD ONLY: it cannot remove a bundled keyword.
	 *
	 * Letting a project file switch off detection of `TOKEN` would let a repository quietly turn
	 * off protection for everyone who opens it. A detection list is the wrong thing to be able to
	 * narrow from inside the thing being scanned.
	 */
	it("cannot remove a bundled keyword", async () => {
		await fs.writeFile(path.join(agentDir, ENV_KEYWORDS_FILENAME), "keywords:\n  - ONLYTHIS\n");

		const keywords = await loadEnvSecretKeywords({ cwd, agentDir });
		for (const bundledKeyword of BUNDLED_ENV_KEYWORDS) expect(keywords).toContain(bundledKeyword);
		expect(buildEnvSecretPattern(keywords).test("DEPLOY_TOKEN")).toBe(true);
	});

	/** Keywords are uppercased and de-duplicated, so the file is forgiving about how it is written. */
	it("normalises what it reads", async () => {
		await fs.writeFile(path.join(agentDir, ENV_KEYWORDS_FILENAME), "keywords:\n  - vaultpass\n  - token\n");

		const keywords = await loadEnvSecretKeywords({ cwd, agentDir });
		expect(keywords).toContain("VAULTPASS");
		expect(keywords.filter(keyword => keyword === "TOKEN")).toHaveLength(1);
	});

	/**
	 * A MALFORMED file is refused, not ignored.
	 *
	 * The same asymmetry `secrets.yml` uses. Ignoring it would detect fewer variables than the
	 * operator believes are covered, and they would have no way to notice.
	 */
	it("refuses a file that is not a keyword list", async () => {
		await fs.writeFile(path.join(agentDir, ENV_KEYWORDS_FILENAME), "keywords: not-a-list\n");

		await expect(loadEnvSecretKeywords({ cwd, agentDir })).rejects.toThrow(/must have a "keywords" list/);
	});

	/**
	 * Extra fields are refused rather than ignored.
	 *
	 * A typo beside a valid `keywords` list is especially dangerous: without an exact-field check
	 * the file loads successfully, so the operator has no signal that the misspelled declaration
	 * contributes nothing.
	 */
	it("refuses an unknown field beside a valid keyword list", async () => {
		await fs.writeFile(
			path.join(agentDir, ENV_KEYWORDS_FILENAME),
			"keywords:\n  - VAULTPASS\nkeyword:\n  - SCANSEED\n",
		);

		await expect(loadEnvSecretKeywords({ cwd, agentDir })).rejects.toThrow(/unknown field "keyword"/);
	});

	/** A non-string entry is refused for the same reason. */
	it("refuses a keyword that is not a string", async () => {
		await fs.writeFile(path.join(agentDir, ENV_KEYWORDS_FILENAME), "keywords:\n  - 42\n");

		await expect(loadEnvSecretKeywords({ cwd, agentDir })).rejects.toThrow(/not a non-empty string/);
	});

	/** Invalid YAML is refused with the file named, so the operator can go and fix it. */
	it("refuses invalid YAML and names the file", async () => {
		const filePath = path.join(agentDir, ENV_KEYWORDS_FILENAME);
		await fs.writeFile(filePath, "keywords:\n  - [unclosed\n");

		await expect(loadEnvSecretKeywords({ cwd, agentDir })).rejects.toThrow(new RegExp(escapeForRegExp(filePath)));
	});

	/** Repeating the sole mapping key must not silently replace the operator's first keyword list. */
	it("refuses duplicate keyword mapping keys", async () => {
		await fs.writeFile(
			path.join(agentDir, ENV_KEYWORDS_FILENAME),
			"keywords:\n  - VAULTPASS\nkeywords:\n  - SCANSEED\n",
		);

		await expect(loadEnvSecretKeywords({ cwd, agentDir })).rejects.toThrow(/Map keys must be unique/);
	});
});

describe("collecting from the real environment", () => {
	/** A detected variable's value is picked up and marked reversible. */
	it("collects a value from a detected variable", () => {
		process.env.VEYYON_ENVKW_TEST_TOKEN = "a-long-enough-secret-value";
		try {
			const collected = collectEnvSecrets(bundled());

			expect(collected.some(entry => entry.content === "a-long-enough-secret-value")).toBe(true);
			expect(collected.find(entry => entry.content === "a-long-enough-secret-value")?.mode).toBe("obfuscate");
		} finally {
			delete process.env.VEYYON_ENVKW_TEST_TOKEN;
		}
	});

	/** An excluded name's value is not collected, however secret-looking the value is. */
	it("does not collect from an excluded name", () => {
		process.env.VEYYON_ENVKW_TEST_TOKENIZER = "a-long-enough-ordinary-value";
		try {
			expect(collectEnvSecrets(bundled()).some(entry => entry.content === "a-long-enough-ordinary-value")).toBe(
				false,
			);
		} finally {
			delete process.env.VEYYON_ENVKW_TEST_TOKENIZER;
		}
	});

	/**
	 * A caller-supplied pattern is honoured, which is what makes the list configurable at all.
	 *
	 * `SCANSEED` rather than a `*PASS` name on purpose: writing this test with
	 * `VEYYON_ENVKW_TEST_VAULTPASS` proved only that the bundled `PASS` keyword already matched it,
	 * which is a fine property and not the one under test here.
	 */
	it("uses the pattern it is given", () => {
		process.env.VEYYON_ENVKW_TEST_SCANSEED = "another-long-enough-value";
		try {
			expect(collectEnvSecrets(bundled()).some(entry => entry.content === "another-long-enough-value")).toBe(false);
			expect(
				collectEnvSecrets(buildEnvSecretPattern([...BUNDLED_ENV_KEYWORDS, "SCANSEED"])).some(
					entry => entry.content === "another-long-enough-value",
				),
			).toBe(true);
		} finally {
			delete process.env.VEYYON_ENVKW_TEST_SCANSEED;
		}
	});

	/** A short value is not collected: the length floor is part of the guess. */
	it("does not collect a value under the length floor", () => {
		process.env.VEYYON_ENVKW_TEST_KEY = "short";
		try {
			expect(collectEnvSecrets(bundled()).some(entry => entry.content === "short")).toBe(false);
		} finally {
			delete process.env.VEYYON_ENVKW_TEST_KEY;
		}
	});

	/** The heuristic uses the same Unicode code-point boundary as the obfuscator it feeds. */
	it("counts astral environment values by code point", () => {
		const seven = "🔐".repeat(7);
		const eight = "🔐".repeat(8);
		process.env.VEYYON_ENVKW_ASTRAL_SHORT_TOKEN = seven;
		process.env.VEYYON_ENVKW_ASTRAL_EXACT_TOKEN = eight;
		try {
			const collected = collectEnvSecrets(/^VEYYON_ENVKW_ASTRAL_/);
			expect(collected.some(entry => entry.content === seven)).toBe(false);
			expect(collected.some(entry => entry.content === eight)).toBe(true);
		} finally {
			delete process.env.VEYYON_ENVKW_ASTRAL_SHORT_TOKEN;
			delete process.env.VEYYON_ENVKW_ASTRAL_EXACT_TOKEN;
		}
	});

	/** Caller regex scan state must be reset per name or adjacent matches are skipped under the global flag. */
	it("does not carry a global pattern's lastIndex between variables", () => {
		const first = "stateful-pattern-first-value";
		const second = "stateful-pattern-second-value";
		process.env.VEYYON_ENVKW_STATEFUL_ALPHA = first;
		process.env.VEYYON_ENVKW_STATEFUL_BETA = second;
		try {
			const pattern = /^VEYYON_ENVKW_STATEFUL_/g;
			const collected = collectEnvSecrets(pattern);
			expect(pattern.lastIndex).toBe(0);
			expect(collected.some(entry => entry.content === first)).toBe(true);
			expect(collected.some(entry => entry.content === second)).toBe(true);
		} finally {
			delete process.env.VEYYON_ENVKW_STATEFUL_ALPHA;
			delete process.env.VEYYON_ENVKW_STATEFUL_BETA;
		}
	});
});

function escapeForRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
