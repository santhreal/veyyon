/**
 * A `secrets.yml` refusal has a total size ceiling, not just per-field good intentions.
 *
 * WHAT WAS WRONG. `loadSecretsFile` collects EVERY problem in the file before throwing, which is the
 * right decision for an operator with three typos, and then interpolated all of them into one
 * message with no cap on the count and no cap on any single complaint. Two inputs measured against
 * the code before this fix:
 *
 *   - one entry, `type: regex`, whose pattern is 50,001 characters and does not compile:
 *     the refusal was 50,393 characters, because the uncompilable pattern is quoted back whole.
 *   - 5,000 entries with an unrecognised `type`: the refusal was 479,069 characters across 5,001
 *     lines, each line individually short and none of them bounding the total.
 *
 * This is the shape that shipped in this repository as a 50,437-character validation error: a
 * per-field limit that never composes into a ceiling. The refusal is fatal and printed to a
 * terminal, so its size is the operator's problem, and a half-megabyte one is unreadable in exactly
 * the situation it exists to explain.
 *
 * THE CEILINGS ARE ASSERTED AS LITERALS. Importing the constants the implementation caps with would
 * make this suite restate the implementation and pass at any value, including one raised back to
 * unbounded.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { loadSecrets } from "@veyyon/coding-agent/secrets/index";

/** Run `loadSecrets` over a profile-scoped `secrets.yml` holding exactly `body`. */
async function refusalFor(body: string): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-secrets-yml-"));
	const agentDir = path.join(root, "agent");
	try {
		await fs.mkdir(agentDir, { recursive: true });
		await fs.writeFile(path.join(agentDir, "secrets.yml"), body, "utf8");
		const loaded = await loadSecrets(path.join(root, "project"), agentDir).then(
			() => undefined,
			(error: unknown) => error,
		);
		if (loaded === undefined) throw new Error("Expected loadSecrets to refuse this file.");
		return (loaded as Error).message;
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}

describe("one hostile entry", () => {
	/**
	 * The pattern is quoted because a pattern is not a credential and the operator has to see what
	 * failed to compile. It is quoted BOUNDED, and the sentence that follows it survives the cut, so
	 * the remedy is not what gets truncated away.
	 */
	it("quotes a bounded prefix of an uncompilable pattern, not the whole thing", async () => {
		const pattern = `(${"a".repeat(50_000)}`;
		const message = await refusalFor(`- type: regex\n  content: ${JSON.stringify(pattern)}\n`);

		expect(message.length).toBeLessThan(2_000);
		expect(message).not.toContain(pattern);
		expect(message).toContain(`Pattern: (${"a".repeat(118)}…`);
		expect(message).toContain("unprotected until it is fixed or removed.");
	});
});

describe("a file full of malformed entries", () => {
	/**
	 * The count is capped and the remainder is COUNTED rather than dropped. Silently printing the
	 * first twenty would tell an operator with 5,000 typos that they have twenty.
	 */
	it("prints a bounded number of complaints and says how many it withheld", async () => {
		const message = await refusalFor(Array.from({ length: 5_000 }, () => "- type: bogus\n  content: x\n").join(""));

		expect(message.length).toBeLessThan(10_000);
		expect(message).toContain("Refusing to start: 5000 entries in ");
		expect(message.split("\n").filter(line => line.startsWith("  - ")).length).toBe(20);
		expect(message).toContain("and 4980 more entries not listed here.");
	});
});

describe("a file full of unprotectable secrets", () => {
	/**
	 * The other unbounded composition, on the path that refuses a declared secret too short to
	 * obfuscate. One complaint per entry, no cap, and this one is built from values.
	 *
	 * The values are asserted ABSENT by their exact bytes. `describeSecretRejection` is built to
	 * carry a length and an index instead of the value, and that property is the reason this refusal
	 * can be printed at all, so it is pinned here rather than assumed from the shape of the code.
	 */
	it("stays bounded and never quotes a value", async () => {
		const values = Array.from({ length: 5_000 }, (_unused, index) => `sk${index}`);
		const message = await refusalFor(values.map(value => `- type: plain\n  content: "${value}"\n`).join(""));

		expect(message.length).toBeLessThan(10_000);
		expect(message).toContain("declared secret(s) cannot be obfuscated");
		expect(message.split("\n").filter(line => line.startsWith("  - ")).length).toBe(20);
		expect(message).toContain("and 4980 more entries not listed here.");
		for (const value of values) {
			expect(message).not.toContain(`content: ${value}`);
			expect(message).not.toContain(`"${value}"`);
		}
	});
});
