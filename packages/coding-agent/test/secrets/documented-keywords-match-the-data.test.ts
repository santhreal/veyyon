/**
 * The keyword list in the docs is the keyword list in the data file.
 *
 * WHY THIS SUITE EXISTS, and it is not hypothetical: the drift had already happened. `PASSPHRASE`
 * was added to `env-keywords.yml` and to `docs/secrets.md`, and the handbook page kept a
 * nine-keyword prose list that omitted it. The same page's own worked-example table said
 * `GPG_PASSPHRASE` was detected three lines below the sentence implying it was not, so the
 * document contradicted itself and nothing failed.
 *
 * That kind of drift is invisible in review, because the doc reads fluently either way, and its
 * consequence is worse than a stale sentence. An operator reads the list to decide whether they
 * need to declare a variable in `secrets.yml`. A list that is short by one keyword makes them
 * declare something already covered, which is harmless, and a list that is LONG by one makes them
 * skip a declaration they needed, which sends a credential to the provider.
 *
 * So the doc lists are parsed out of the prose and compared against the bundled data. Any keyword
 * added to, or removed from, `env-keywords.yml` fails here until both documents are updated in the
 * same change.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { BUNDLED_ENV_KEYWORDS } from "@veyyon/coding-agent/secrets/env-keywords";

const REPO_ROOT = path.resolve(import.meta.dir, "../../../..");
const HANDBOOK_PAGE = path.join(REPO_ROOT, "docs/handbook/src/features/secrets.md");
const REFERENCE_PAGE = path.join(REPO_ROOT, "docs/secrets.md");

/**
 * Pull the backtick-quoted keywords out of the one sentence that lists them.
 *
 * Anchored on the phrase rather than on a line number, so reflowing the paragraph does not break
 * the check and moving the sentence does not silently stop checking anything: a page with no
 * matching sentence yields an empty list, which fails the comparison loudly.
 */
function documentedKeywords(filePath: string, anchor: string): string[] {
	const text = fs.readFileSync(filePath, "utf8");
	const line = text.split("\n").find(candidate => candidate.includes(anchor));
	if (line === undefined) return [];
	return [...line.matchAll(/`([A-Z][A-Z_]*)`/g)].map(match => match[1]);
}

describe("the handbook's keyword sentence", () => {
	/**
	 * Lists exactly the bundled keywords, in the data file's order.
	 *
	 * Order is asserted too, not out of pedantry: the data file groups `PASSWORD`, `PASS` and
	 * `PASSPHRASE` together because the boundary rule is what separates them, and a doc that
	 * scrambled them would lose the reason the three coexist.
	 */
	it("lists every bundled keyword, in order", () => {
		const documented = documentedKeywords(HANDBOOK_PAGE, "Veyyon treats an environment variable as secret when");

		expect(documented).toEqual([...BUNDLED_ENV_KEYWORDS]);
	});

	/** The sentence exists at all, so a rename cannot turn this suite into a no-op. */
	it("is still present on the page", () => {
		const text = fs.readFileSync(HANDBOOK_PAGE, "utf8");

		expect(text).toContain("Veyyon treats an environment variable as secret when");
	});

	/**
	 * `PASSPHRASE` specifically, called out because it is the keyword that drifted.
	 *
	 * A named regression test for a named bug. The list comparison above would catch it, and this
	 * one says out loud which failure the suite was written for.
	 */
	it("includes PASSPHRASE, the keyword that was missing", () => {
		const documented = documentedKeywords(HANDBOOK_PAGE, "Veyyon treats an environment variable as secret when");

		expect(documented).toContain("PASSPHRASE");
	});
});

describe("the reference page's keyword list", () => {
	/** The same comparison against `docs/secrets.md`, which is the other place the list appears. */
	it("lists every bundled keyword, in order", () => {
		const documented = documentedKeywords(REFERENCE_PAGE, "whose names match a keyword from");

		expect(documented).toEqual([...BUNDLED_ENV_KEYWORDS]);
	});
});

describe("the two pages", () => {
	/**
	 * Agree with each other, which is the property a reader actually depends on.
	 *
	 * Both are compared against the data above, so this is implied. It is asserted separately
	 * because it is the failure a reader experiences: two documents in one repository disagreeing
	 * about what is protected.
	 */
	it("list the same keywords", () => {
		const handbook = documentedKeywords(HANDBOOK_PAGE, "Veyyon treats an environment variable as secret when");
		const reference = documentedKeywords(REFERENCE_PAGE, "whose names match a keyword from");

		expect(handbook).toEqual(reference);
	});
});

describe("the worked examples in the handbook table", () => {
	/**
	 * Every variable the table calls detected really is, and every one it calls undetected is not.
	 *
	 * The table is the part of the page an operator actually reads before deciding whether to
	 * declare a variable, and it is hand-written prose about a regex. `GPG_PASSPHRASE` sat in the
	 * detected column while the sentence above omitted the keyword that matches it, so the table
	 * was right and the sentence was wrong, and neither was checked.
	 */
	it("classify the way the pattern does", async () => {
		const { buildEnvSecretPattern } = await import("@veyyon/coding-agent/secrets/env-keywords");
		const pattern = buildEnvSecretPattern([...BUNDLED_ENV_KEYWORDS]);

		const detected = ["DEPLOY_TOKEN", "API_KEY", "KEY_FILE", "GPG_PASSPHRASE", "APIKEY", "PRIVKEY"];
		const notDetected = ["TOKENIZER", "SECRETIVE_THING", "AUTHORIZED_USER", "PASSTHROUGH", "PWD"];

		for (const name of detected) expect(pattern.test(name)).toBe(true);
		for (const name of notDetected) expect(pattern.test(name)).toBe(false);
	});

	/** Those exact names are the ones the table shows, so the test cannot drift from the page. */
	it("are the names the page shows", () => {
		const text = fs.readFileSync(HANDBOOK_PAGE, "utf8");

		for (const name of [
			"DEPLOY_TOKEN",
			"API_KEY",
			"KEY_FILE",
			"GPG_PASSPHRASE",
			"APIKEY",
			"PRIVKEY",
			"TOKENIZER",
			"SECRETIVE_THING",
			"AUTHORIZED_USER",
			"PASSTHROUGH",
			"PWD",
		]) {
			expect(text).toContain(`\`${name}\``);
		}
	});
});
