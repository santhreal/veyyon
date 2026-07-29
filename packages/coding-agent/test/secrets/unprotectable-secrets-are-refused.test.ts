/**
 * A declared secret that cannot be obfuscated must be refused, never quietly dropped.
 *
 * WHY THIS SUITE EXISTS. `SecretObfuscator`'s constructor used to `continue` past any
 * plain `obfuscate` entry shorter than eight characters:
 *
 *     if (entry.content.length < 8) {
 *         // Tone down short plain secret obfuscation to avoid false matches
 *         continue;
 *     }
 *
 * The entry got no mapping and no placeholder, so the value went to the model provider
 * verbatim while `secrets.yml` said it was protected and the session started clean. The
 * feature reported success and did the exact thing it exists to prevent. The same shape
 * sat in the regex branch, and `loadSecretsFile` turned an unreadable or malformed file
 * into an empty list, which starts a session that believes nothing was declared.
 *
 * The contract these tests hold:
 *
 *   1. A declared plain secret under the floor is REFUSED at the loader, with the remedy
 *      (`mode: replace`) in the message. Fail closed: security controls do not degrade.
 *   2. Anything the constructor cannot protect is REPORTED through `rejections()`, so no
 *      caller can build an obfuscator and remain unaware that a value is exposed.
 *   3. A short REGEX match is different in kind and is still skipped, because a match
 *      under the floor is a loose pattern reaching into prose rather than a secret. It is
 *      recorded once per pattern so the operator can tell the two apart, and `minLength`
 *      lets the author say a short match is real.
 *   4. Absence stays cheap: no file means nothing was declared, which is not an error.
 *
 * The tests assert the refusal AND that the value is absent from obfuscated output, since
 * a rejection that still leaked the value would satisfy the first check alone.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	canObfuscatePlainValue,
	describeSecretRejection,
	loadSecrets,
	MIN_OBFUSCATABLE_LENGTH,
	type SecretEntry,
	SecretObfuscator,
	type SecretRejection,
} from "@veyyon/coding-agent/secrets";

/** An eight-character value: exactly at the floor, so it must be protected. */
const AT_FLOOR = "abcd1234";
/** A seven-character value: one under the floor, so it must be refused. */
const UNDER_FLOOR = "abc1234";

/** A throwaway pair of secret roots, returned as the two paths `loadSecrets` reads. */
async function withSecretsDir(
	files: { project?: string; global?: string },
	body: (cwd: string, agentDir: string) => Promise<void>,
): Promise<void> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-secrets-"));
	try {
		const cwd = path.join(root, "project");
		const agentDir = path.join(root, "agent");
		await fs.mkdir(path.join(cwd, ".veyyon"), { recursive: true });
		await fs.mkdir(agentDir, { recursive: true });
		if (files.project !== undefined) {
			await fs.writeFile(path.join(cwd, ".veyyon", "secrets.yml"), files.project);
		}
		if (files.global !== undefined) {
			await fs.writeFile(path.join(agentDir, "secrets.yml"), files.global);
		}
		await body(cwd, agentDir);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}

describe("the length floor has one owner", () => {
	/**
	 * The floor is a named constant, not a literal repeated at each site.
	 *
	 * Three copies of `8` answered two different questions, so changing one left the
	 * others behind. This pins the value AND that the predicate agrees with it, which is
	 * what stops a call site from re-deriving the rule with its own comparison.
	 */
	it("agrees between the constant and the predicate at the boundary", () => {
		expect(MIN_OBFUSCATABLE_LENGTH).toBe(8);
		expect(AT_FLOOR).toHaveLength(MIN_OBFUSCATABLE_LENGTH);
		expect(UNDER_FLOOR).toHaveLength(MIN_OBFUSCATABLE_LENGTH - 1);

		expect(canObfuscatePlainValue(AT_FLOOR)).toBe(true);
		expect(canObfuscatePlainValue(UNDER_FLOOR)).toBe(false);
		expect(canObfuscatePlainValue("")).toBe(false);
	});
});

describe("a declared short secret is refused at the loader", () => {
	/**
	 * The reported bug, end to end: a seven-character declared secret must stop startup.
	 *
	 * `loadSecrets` throwing is the fail-closed half of the fix. Returning a filtered list
	 * is what let the session start while the value flowed to the provider.
	 */
	it("throws rather than returning a list with the entry dropped", async () => {
		await withSecretsDir({ project: `- type: plain\n  content: "${UNDER_FLOOR}"\n` }, async (cwd, agentDir) => {
			await expect(loadSecrets(cwd, agentDir)).rejects.toThrow(/cannot be obfuscated/);
		});
	});

	/**
	 * The message carries the fix, not just the complaint.
	 *
	 * An error that says "too short" and stops there leaves the operator with a broken
	 * session and no next step. `mode: replace` is the answer in every case, so the
	 * message has to name it.
	 */
	it("names the remedy and the minimum in the error", async () => {
		await withSecretsDir({ project: `- type: plain\n  content: "${UNDER_FLOOR}"\n` }, async (cwd, agentDir) => {
			const failure = await loadSecrets(cwd, agentDir).then(
				() => undefined,
				(error: unknown) => error,
			);

			expect(failure).toBeInstanceOf(Error);
			const message = (failure as Error).message;
			expect(message).toContain("mode: replace");
			expect(message).toContain(String(MIN_OBFUSCATABLE_LENGTH));
			// The value itself must not be echoed into a log line by the refusal.
			expect(message).not.toContain(UNDER_FLOOR);
		});
	});

	/**
	 * The refusal is about `obfuscate` mode only.
	 *
	 * `replace` is one-way and needs no reversible placeholder, so it has no floor. If
	 * this test failed, the remedy the error message recommends would itself be refused.
	 */
	it("accepts the same short value in replace mode", async () => {
		const yaml = `- type: plain\n  content: "${UNDER_FLOOR}"\n  mode: replace\n`;
		await withSecretsDir({ project: yaml }, async (cwd, agentDir) => {
			const entries = await loadSecrets(cwd, agentDir);

			expect(entries).toHaveLength(1);
			expect(entries[0]).toMatchObject({ type: "plain", origin: "config", content: UNDER_FLOOR, mode: "replace" });
		});
	});

	/** A value exactly at the floor is protected, so the boundary is inclusive. */
	it("accepts a value exactly at the floor", async () => {
		await withSecretsDir({ project: `- type: plain\n  content: "${AT_FLOOR}"\n` }, async (cwd, agentDir) => {
			const entries = await loadSecrets(cwd, agentDir);

			expect(entries).toHaveLength(1);
			expect(entries[0].content).toBe(AT_FLOOR);
		});
	});

	/**
	 * A short entry in the GLOBAL file is refused too.
	 *
	 * The check runs on the merged list, so neither location can smuggle one past. Worth
	 * its own case because the merge is where a per-file check would have been missed.
	 */
	it("refuses a short entry that came from the global file", async () => {
		await withSecretsDir({ global: `- type: plain\n  content: "${UNDER_FLOOR}"\n` }, async (cwd, agentDir) => {
			await expect(loadSecrets(cwd, agentDir)).rejects.toThrow(/cannot be obfuscated/);
		});
	});
});

describe("an unreadable secrets file is an error and a missing one is not", () => {
	/**
	 * No file means nothing was declared, which is the ordinary case and must stay cheap.
	 *
	 * The one branch that is allowed to answer "empty", and the reason absence gets its
	 * own test: if this regressed to throwing, every session without secrets would fail.
	 */
	it("returns nothing when neither file exists", async () => {
		await withSecretsDir({}, async (cwd, agentDir) => {
			expect(await loadSecrets(cwd, agentDir)).toEqual([]);
		});
	});

	/**
	 * A file that exists but does not parse must not be read as "no secrets declared".
	 *
	 * The old code warned and returned `[]`, so a stray tab in the YAML silently disabled
	 * every secret in the file. The operator's declarations were still on disk, which is
	 * exactly why silence is wrong here.
	 */
	it("throws on a file that is not valid YAML", async () => {
		await withSecretsDir({ project: "- type: plain\n content: broken\n\t- nope\n" }, async (cwd, agentDir) => {
			await expect(loadSecrets(cwd, agentDir)).rejects.toThrow(/not valid YAML|must be a YAML array/);
		});
	});

	/**
	 * A YAML document that parses but is not a list is also refused.
	 *
	 * A mapping is the natural mistake (`secrets: [...]` at the top level), and it used to
	 * warn and continue with nothing protected.
	 */
	it("throws on a YAML document that is not an array", async () => {
		await withSecretsDir({ project: "secrets:\n  - type: plain\n    content: abcd1234\n" }, async (cwd, agentDir) => {
			await expect(loadSecrets(cwd, agentDir)).rejects.toThrow(/must be a YAML array/);
		});
	});

	/** The refusal names the file, because two locations are read and only one is wrong. */
	it("names the offending path", async () => {
		await withSecretsDir({ project: "not: a list\n" }, async (cwd, agentDir) => {
			const failure = await loadSecrets(cwd, agentDir).then(
				() => undefined,
				(error: unknown) => error,
			);

			expect((failure as Error).message).toContain(path.join(cwd, ".veyyon", "secrets.yml"));
		});
	});
});

describe("the obfuscator reports what it could not protect", () => {
	/**
	 * The constructor is a second boundary, and SDK callers arrive through it directly.
	 *
	 * `loadSecrets` cannot refuse an entry it never saw. A caller building entries in code
	 * (or a future `/secret` command) reaches the constructor without passing the loader,
	 * so construction has to report rather than drop.
	 */
	it("rejects a short plain entry and says why", () => {
		const obfuscator = new SecretObfuscator([{ type: "plain", origin: "config", content: UNDER_FLOOR }]);

		expect(obfuscator.rejections()).toEqual([
			{ reason: "too-short-to-obfuscate", index: 0, length: UNDER_FLOOR.length },
		]);
		expect(describeSecretRejection(obfuscator.rejections()[0])).toContain("mode: replace");
	});

	/**
	 * A rejection carries the length, never the value.
	 *
	 * Rejections are logged at startup, so a rejection that embedded the secret would put
	 * it in the log file: the leak, relocated. This pins the shape rather than trusting it.
	 */
	it("carries no secret material in a rejection", () => {
		const obfuscator = new SecretObfuscator([{ type: "plain", origin: "config", content: UNDER_FLOOR }]);

		const serialised = JSON.stringify(obfuscator.rejections());
		expect(serialised).not.toContain(UNDER_FLOOR);
		expect(describeSecretRejection(obfuscator.rejections()[0])).not.toContain(UNDER_FLOOR);
	});

	/**
	 * A refused entry really is unprotected, which is why refusing loudly matters.
	 *
	 * The point of the whole change: this test documents the behaviour the operator was
	 * never told about. It asserts the leak so that anyone who later removes the loader's
	 * refusal sees, in a test name, what they are re-enabling.
	 */
	it("leaves a refused value untouched in obfuscated output", () => {
		const obfuscator = new SecretObfuscator([{ type: "plain", origin: "config", content: UNDER_FLOOR }]);

		expect(obfuscator.obfuscate(`token=${UNDER_FLOOR}`)).toBe(`token=${UNDER_FLOOR}`);
		expect(obfuscator.rejections()).toHaveLength(1);
	});

	/** An accepted value is replaced, so the floor is the only thing separating the two. */
	it("replaces a value at the floor with a placeholder", () => {
		const obfuscator = new SecretObfuscator([{ type: "plain", origin: "config", content: AT_FLOOR }]);

		const out = obfuscator.obfuscate(`token=${AT_FLOOR}`);
		expect(out).not.toContain(AT_FLOOR);
		expect(obfuscator.rejections()).toEqual([]);
		expect(obfuscator.deobfuscate(out)).toBe(`token=${AT_FLOOR}`);
	});

	/**
	 * An uncompilable pattern is reported instead of swallowed.
	 *
	 * The old `catch {}` justified itself with "validation happens at load time", true only
	 * for files. A pattern that does not compile protects nothing, and the caller has no
	 * other way to find out.
	 */
	it("rejects a regex that does not compile", () => {
		const obfuscator = new SecretObfuscator([{ type: "regex", origin: "config", content: "(unclosed" }]);

		expect(obfuscator.rejections()).toHaveLength(1);
		expect(obfuscator.rejections()[0].reason).toBe("invalid-pattern");
		expect(describeSecretRejection(obfuscator.rejections()[0])).toContain("does not compile");
	});

	/** Rejections are indexed by input position, so a message can point at the entry. */
	it("indexes rejections by their position in the input", () => {
		const entries: SecretEntry[] = [
			{ type: "plain", origin: "config", content: AT_FLOOR },
			{ type: "plain", origin: "config", content: UNDER_FLOOR },
			{ type: "regex", origin: "config", content: "(unclosed" },
		];
		const obfuscator = new SecretObfuscator(entries);

		expect(obfuscator.rejections().map(r => r.index)).toEqual([1, 2]);
	});
});

describe("every rejection reaches the caller as it happens", () => {
	/**
	 * A rejection raised during obfuscation must notify, not just accumulate.
	 *
	 * THE BUG THIS LOCKS OUT was in the first version of the fix: rejections were pushed to
	 * an array that the startup path read exactly once, straight after construction. A
	 * pattern that over-matches is only discovered when it touches a message, which is
	 * always later, so those rejections were recorded and never read by anyone. The array
	 * grew in silence, which is the failure mode the whole change exists to remove. Reading
	 * `rejections()` alone would still pass, so this asserts the callback fired.
	 */
	it("notifies for a rejection that only appears while obfuscating", () => {
		const seen: SecretRejection[] = [];
		const obfuscator = new SecretObfuscator([{ type: "regex", origin: "config", content: "\\b[a-z]{3}\\b" }], {
			onRejection: rejection => seen.push(rejection),
		});

		// Nothing is wrong at construction: the pattern compiles.
		expect(seen).toEqual([]);

		obfuscator.obfuscate("the esp was fine");

		expect(seen).toHaveLength(1);
		expect(seen[0].reason).toBe("too-short-to-obfuscate");
		expect(seen[0].detail).toContain("minLength");
	});

	/** A construction-time rejection notifies too, so both paths use the one channel. */
	it("notifies for a rejection found at construction", () => {
		const seen: SecretRejection[] = [];
		new SecretObfuscator([{ type: "plain", origin: "config", content: UNDER_FLOOR }], {
			onRejection: rejection => seen.push(rejection),
		});

		expect(seen).toHaveLength(1);
		expect(seen[0]).toEqual({ reason: "too-short-to-obfuscate", index: 0, length: UNDER_FLOOR.length });
	});

	/**
	 * The callback and the array agree, so neither is a second source of truth.
	 *
	 * Both surfaces exist (the callback for reporting, the array for tests and for a caller
	 * that wants the summary), and they must never disagree about what was refused.
	 */
	it("reports the same rejections through the callback and the accessor", () => {
		const seen: SecretRejection[] = [];
		const obfuscator = new SecretObfuscator(
			[
				{ type: "plain", origin: "config", content: UNDER_FLOOR },
				{ type: "regex", origin: "config", content: "(unclosed" },
			],
			{ onRejection: rejection => seen.push(rejection) },
		);

		expect(seen).toEqual([...obfuscator.rejections()]);
		expect(seen).toHaveLength(2);
	});

	/** The callback stays optional, so existing single-argument callers keep working. */
	it("works with no options at all", () => {
		const obfuscator = new SecretObfuscator([{ type: "plain", origin: "config", content: AT_FLOOR }]);

		expect(obfuscator.obfuscate(`t=${AT_FLOOR}`)).not.toContain(AT_FLOOR);
		expect(obfuscator.rejections()).toEqual([]);
	});
});

describe("a broken pattern in a file refuses startup", () => {
	/**
	 * An uncompilable regex is a lost protection, so it fails closed like a short secret.
	 *
	 * It used to `logger.warn` and drop the entry. No console transport is attached in an
	 * interactive session (`packages/utils/src/logger.ts:219` defaults to `{ file: true }`),
	 * so that warning went to a file the operator does not open, and a declared class of
	 * secret silently went uncovered.
	 */
	it("throws and quotes the pattern", async () => {
		await withSecretsDir({ project: '- type: regex\n  content: "(unclosed"\n' }, async (cwd, agentDir) => {
			const failure = await loadSecrets(cwd, agentDir).then(
				() => undefined,
				(error: unknown) => error,
			);

			expect(failure).toBeInstanceOf(Error);
			// Patterns are not secret, so quoting it is the fastest way to the fix.
			expect((failure as Error).message).toContain("(unclosed");
			expect((failure as Error).message).toContain("does not compile");
		});
	});

	/** A pattern that compiles is unaffected, so the refusal is about breakage only. */
	it("accepts a pattern that compiles", async () => {
		await withSecretsDir({ project: '- type: regex\n  content: "AKIA[0-9A-Z]{16}"\n' }, async (cwd, agentDir) => {
			const entries = await loadSecrets(cwd, agentDir);

			expect(entries).toHaveLength(1);
			expect(entries[0]).toMatchObject({ type: "regex", origin: "config", content: "AKIA[0-9A-Z]{16}" });
		});
	});
});

describe("a short regex match is a loose pattern, not an unprotected secret", () => {
	/**
	 * Skipping a short match is CORRECT, and this test says why in its name.
	 *
	 * `\w+` matching `esp` inside ordinary prose is the case the original comment meant.
	 * Obfuscating it would blank out fragments of unrelated words, so the skip stays. The
	 * distinction from a declared plain secret is the whole design of this change.
	 */
	it("leaves a short match alone rather than shredding prose", () => {
		const obfuscator = new SecretObfuscator([{ type: "regex", origin: "config", content: "\\b[a-z]{3}\\b" }]);

		expect(obfuscator.obfuscate("the esp was fine")).toBe("the esp was fine");
	});

	/**
	 * The skip is recorded once per pattern, so an over-matching pattern is visible.
	 *
	 * Once, not per match: a loose pattern fires constantly and a rejection per match would
	 * flood the log and bury everything else. The operator needs to learn the fact, not
	 * count occurrences.
	 */
	it("records the over-match a single time per pattern", () => {
		const obfuscator = new SecretObfuscator([{ type: "regex", origin: "config", content: "\\b[a-z]{3}\\b" }]);

		obfuscator.obfuscate("the esp was fine");
		obfuscator.obfuscate("and the cat sat too");

		expect(obfuscator.rejections()).toHaveLength(1);
		expect(obfuscator.rejections()[0].detail).toContain("minLength");
	});

	/**
	 * `minLength` lets the author declare that short matches are real.
	 *
	 * A six-character one-time code is a legitimate pattern. Without this the floor is a
	 * magic number the operator cannot reach, which is the hardcoded-constant problem in a
	 * different costume.
	 */
	it("obfuscates a short match when the entry lowers its floor", () => {
		const obfuscator = new SecretObfuscator([
			{ type: "regex", origin: "config", content: "\\b[0-9]{6}\\b", minLength: 6 },
		]);

		const out = obfuscator.obfuscate("code 481516 now");
		expect(out).not.toContain("481516");
		expect(obfuscator.rejections()).toEqual([]);
		expect(obfuscator.deobfuscate(out)).toBe("code 481516 now");
	});

	/** `replace` mode has no floor at all, on the regex path as on the plain path. */
	it("replaces a short match in replace mode without any floor", () => {
		const obfuscator = new SecretObfuscator([
			{ type: "regex", origin: "config", content: "\\b[0-9]{3}\\b", mode: "replace", replacement: "***" },
		]);

		expect(obfuscator.obfuscate("pin 123 ok")).toBe("pin *** ok");
		expect(obfuscator.rejections()).toEqual([]);
	});

	/**
	 * `minLength` on a plain entry is refused rather than ignored.
	 *
	 * Plain entries match literally, so the field cannot do anything for them. Accepting
	 * and ignoring it would let an operator write `minLength: 3` beside a three-character
	 * plain secret and believe it is now covered.
	 */
	it("refuses minLength on a plain entry, since it cannot apply", async () => {
		const yaml = `- type: plain\n  content: "${UNDER_FLOOR}"\n  minLength: 3\n`;
		await withSecretsDir({ project: yaml }, async (cwd, agentDir) => {
			// REFUSES, and this assertion changed when the loader stopped skipping. It used to expect
			// an empty load, because validation warned into a log file nobody reads and dropped the
			// entry. That is the failure the refusal exists to prevent: the operator wrote a value
			// into `secrets.yml`, the session started, and the value went to the provider in plain
			// text. See `malformed-declarations-are-refused.test.ts` for the whole class.
			await expect(loadSecrets(cwd, agentDir)).rejects.toThrow(/minLength, which applies to regex entries only/);
		});
	});
});
