/**
 * Regression: a `!command` config value that resolves to nothing must say so.
 *
 * A config value starting with `!` runs a shell command and uses its stdout,
 * which is how an API key or an auth header is fetched from a password manager
 * or a keychain (`!op read op://vault/key`). TWO separate resolvers existed and
 * both discarded every failure: a non-zero exit, a timeout, a spawn error and
 * empty output all collapsed to a bare `undefined`.
 *
 * The cost of that silence is not theoretical. The value is missing, so the
 * request goes out unauthenticated and the operator sees an authentication
 * error from the provider, with nothing anywhere connecting it to the command
 * that failed (Law 10).
 *
 * Two implementations of one behaviour is the usual duplication, so the report
 * has a single owner and these tests pin that both resolvers reach it.
 *
 * What each resolver can say differs, and that difference is deliberate rather
 * than an oversight, so it is pinned here too. Stdout carries the secret and
 * must never reach a log. The `model-registry` resolver runs commands through
 * `execSync` with separate pipes, so it can report stderr, which is where
 * `op: not signed in` and `command not found` appear. This resolver runs them
 * through `executeShell`, which merges the two streams with no way to tell them
 * apart, so it reports no output at all and sends the reader to run the command
 * themselves. Reporting merged output here would risk writing the credential
 * into a log file, which is worse than the silence being fixed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { reportUnresolvedConfigValue } from "@veyyon/coding-agent/config/config-value-resolution";
import {
	clearConfigValueCache,
	resolveConfigValue,
	resolveHeaders,
} from "@veyyon/coding-agent/config/resolve-config-value";
import { logger } from "@veyyon/utils";

/** A shell command that exits non-zero after writing a diagnostic to stderr. */
const FAILS_LOUDLY = `!${process.execPath} -e "process.stderr.write('op: not signed in'); process.exit(3)"`;
/** A shell command that succeeds and writes nothing, the more confusing failure. */
const SUCCEEDS_SILENTLY = "!true";
/** A shell command that resolves to a real value. */
const SUCCEEDS = `!${process.execPath} -e "process.stdout.write('sk-live-secret-value')"`;

describe("reportUnresolvedConfigValue", () => {
	let warnings: Array<{ message: string; fields: Record<string, unknown> }>;

	beforeEach(() => {
		warnings = [];
		vi.spyOn(logger, "warn").mockImplementation((message: string, fields?: Record<string, unknown>) => {
			warnings.push({ message, fields: fields ?? {} });
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("says the setting is unset, which is the consequence, not just that a command failed", () => {
		// "Command failed" describes the mechanism. What the reader needs to connect
		// to their authentication error is that the value is now missing.
		reportUnresolvedConfigValue({ command: "op read op://v/k", reason: "it exited with code 1" });

		expect(warnings).toHaveLength(1);
		expect(warnings[0]?.message).toBe("A configured command produced no value, so the setting it resolves is unset");
	});

	it("reports the command, so the reader knows which one to run themselves", () => {
		reportUnresolvedConfigValue({ command: "op read op://v/k", reason: "it exited with code 1" });

		expect(warnings[0]?.fields.command).toBe("op read op://v/k");
	});

	it("reports the command's stderr, which is the only thing that explains the failure", () => {
		reportUnresolvedConfigValue({
			command: "op read op://v/k",
			reason: "it exited with code 1",
			stderr: "  op: not signed in\n",
		});

		expect(warnings[0]?.fields.stderr).toBe("op: not signed in");
	});

	it("omits the stderr field entirely when the command wrote nothing there", () => {
		// A field that is always present, often empty, teaches the reader to skip it.
		reportUnresolvedConfigValue({ command: "c", reason: "r", stderr: "   \n  " });

		expect(warnings[0]?.fields).not.toHaveProperty("stderr");
	});

	it("truncates a flood of stderr rather than putting all of it in the log", () => {
		// A failing command can write an unbounded amount. The report exists to
		// explain the failure, not to archive the command's output.
		reportUnresolvedConfigValue({ command: "c", reason: "r", stderr: "e".repeat(50_000) });

		expect(String(warnings[0]?.fields.stderr).length).toBeLessThanOrEqual(501);
	});

	it("names what the value was for when the caller knows", () => {
		// A config can resolve several values with the same command. Without this
		// the report cannot say which of them is now missing.
		reportUnresolvedConfigValue({ command: "c", describedAs: 'header "X-Api-Key"', reason: "r" });

		expect(warnings[0]?.fields.setting).toBe('header "X-Api-Key"');
	});

	it("omits the setting field when the caller has no name for it", () => {
		reportUnresolvedConfigValue({ command: "c", reason: "r" });

		expect(warnings[0]?.fields).not.toHaveProperty("setting");
	});

	it("tells the operator what to do and what the symptom will look like", () => {
		// The failure is invisible at the point it happens; it surfaces later as a
		// provider auth error, so the message has to connect the two.
		reportUnresolvedConfigValue({ command: "c", reason: "r" });

		expect(String(warnings[0]?.fields.fix)).toContain("Run the command yourself");
		expect(String(warnings[0]?.fields.fix)).toContain("authentication error");
	});

	it("reports at warn, not debug, because a configured capability is actually lost", () => {
		// The original silence is one demotion away from returning.
		const debug = vi.spyOn(logger, "debug").mockImplementation(() => {});

		reportUnresolvedConfigValue({ command: "c", reason: "r" });

		expect(warnings).toHaveLength(1);
		expect(debug).not.toHaveBeenCalled();
	});
});

describe("resolveConfigValue reports why a credential command produced nothing", () => {
	let warnings: Array<{ message: string; fields: Record<string, unknown> }>;

	beforeEach(() => {
		clearConfigValueCache();
		warnings = [];
		vi.spyOn(logger, "warn").mockImplementation((message: string, fields?: Record<string, unknown>) => {
			warnings.push({ message, fields: fields ?? {} });
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		clearConfigValueCache();
	});

	const reports = (): Array<Record<string, unknown>> =>
		warnings
			.filter(w => w.message === "A configured command produced no value, so the setting it resolves is unset")
			.map(w => w.fields);

	it("still returns undefined, so callers behave exactly as before", async () => {
		// The fix adds a report. It must not change what the resolver returns, or
		// every caller's missing-value handling changes with it.
		await expect(resolveConfigValue(FAILS_LOUDLY)).resolves.toBeUndefined();
	});

	it("reports a non-zero exit with the actual exit code", async () => {
		await resolveConfigValue(FAILS_LOUDLY);

		expect(reports()).toHaveLength(1);
		expect(String(reports()[0]?.reason)).toContain("exited with code 3");
	});

	it("never reports the command output on this resolver, because it may be the secret", async () => {
		// `executeShell` merges stdout and stderr with no way to separate them, so
		// there is no safe diagnostic to include here: reporting the captured
		// output would put the credential in a log file. The reader is sent to run
		// the command themselves instead, where they see the real stderr.
		await resolveConfigValue(FAILS_LOUDLY);

		expect(reports()[0]).not.toHaveProperty("stderr");
		expect(String(reports()[0]?.fix)).toContain("Run the command yourself");
	});

	it("distinguishes a command that succeeded but printed nothing", async () => {
		// Different cause, different fix: the command works, it just does not put
		// the value on stdout. Collapsing it into "failed" sends the reader looking
		// for a failure that is not there.
		await resolveConfigValue(SUCCEEDS_SILENTLY);

		expect(reports()).toHaveLength(1);
		expect(String(reports()[0]?.reason)).toContain("wrote nothing to stdout");
	});

	it("says nothing when the command resolves a value", async () => {
		// Anti-vacuity: a report on the working path would make every assertion
		// above pass for the wrong reason.
		await expect(resolveConfigValue(SUCCEEDS)).resolves.toBe("sk-live-secret-value");
		expect(reports()).toEqual([]);
	});

	it("never puts the command's stdout in the log, because that is the secret", async () => {
		// The whole point of `!op read ...` is that the value does not sit in a
		// config file. Logging it would move it into a log file instead.
		await resolveConfigValue(SUCCEEDS);
		await resolveConfigValue(SUCCEEDS_SILENTLY);

		expect(JSON.stringify(warnings)).not.toContain("sk-live-secret-value");
	});

	it("reports a failing command once, not on every request that needs it", async () => {
		// This resolver re-runs a failing command every time it is asked. Reporting
		// each attempt would bury the log, which is how a loud channel stops being
		// read.
		await resolveConfigValue(FAILS_LOUDLY);
		await resolveConfigValue(FAILS_LOUDLY);
		await resolveConfigValue(FAILS_LOUDLY);

		expect(reports()).toHaveLength(1);
	});

	it("reports again after the cache is cleared, so a later failure is not hidden", async () => {
		// The de-duplication must not turn into permanent silence across a config
		// reload, which is exactly when the reader wants to know it is still broken.
		await resolveConfigValue(FAILS_LOUDLY);
		clearConfigValueCache();
		await resolveConfigValue(FAILS_LOUDLY);

		expect(reports()).toHaveLength(2);
	});

	it("names which header is missing when a header value fails to resolve", async () => {
		// A dropped header produces a 401 that looks like a bad key. Naming the
		// header is what turns that into something the operator can act on.
		await resolveHeaders({ "X-Api-Key": FAILS_LOUDLY });

		expect(reports()[0]?.setting).toBe('header "X-Api-Key"');
	});

	it("keeps dropping the unresolved header, so behaviour is unchanged", async () => {
		// Sending the literal `!command` text as a header value would be worse than
		// omitting it. The fix reports the drop, it does not stop it.
		await expect(resolveHeaders({ "X-Api-Key": FAILS_LOUDLY })).resolves.toBeUndefined();
	});

	it("resolves the headers that do work while reporting the one that does not", async () => {
		const resolved = await resolveHeaders({ Good: SUCCEEDS, Bad: FAILS_LOUDLY });

		expect(resolved).toEqual({ Good: "sk-live-secret-value" });
		expect(reports()).toHaveLength(1);
		expect(reports()[0]?.setting).toBe('header "Bad"');
	});

	it("leaves a plain environment-variable value alone", async () => {
		// Only `!` values run commands. A literal or env lookup has no failure to
		// report, and reporting one would be noise on the common path.
		process.env.VEYYON_TEST_CONFIG_VALUE = "from-env";

		await expect(resolveConfigValue("VEYYON_TEST_CONFIG_VALUE")).resolves.toBe("from-env");
		expect(reports()).toEqual([]);

		delete process.env.VEYYON_TEST_CONFIG_VALUE;
	});
});

/**
 * The owner being correct is not enough: both resolvers have to reach it.
 *
 * The original defect was a bare `catch` in each of two files, and nothing
 * about a well-tested reporter stops one of them coming back. The two resolvers
 * now share a single caching/back-off/report policy (`configCommandPolicy`) in
 * `config-value-resolution.ts`, and a failure reaches the report only by way of
 * `recordFailure`, so these scans pin that BOTH resolvers route through the
 * shared policy and NEITHER keeps its own report. The `model-registry` resolver
 * is module-private and only reachable through a fully constructed
 * `ModelRegistry`, so it is guarded by reading the source rather than by
 * exporting it purely for a test and widening the public surface for no
 * production caller. A source scan is weaker than a behavioural test and is used
 * here only because the alternative is worse.
 */
describe("both config-value resolvers route a failed command through the shared policy", () => {
	const OWNER = path.resolve(import.meta.dir, "../../src/config/config-value-resolution.ts");
	const RESOLVERS = [
		{ name: "resolve-config-value", path: path.resolve(import.meta.dir, "../../src/config/resolve-config-value.ts") },
		{ name: "model-registry", path: path.resolve(import.meta.dir, "../../src/config/model-registry.ts") },
	];

	for (const resolver of RESOLVERS) {
		it(`${resolver.name} records a failure through the shared policy`, () => {
			const source = fs.readFileSync(resolver.path, "utf8");

			expect(source).toContain("configCommandPolicy.recordFailure(");
			expect(source).toContain('from "./config-value-resolution"');
		});

		it(`${resolver.name} does not call the reporter directly, so the report has one caller`, () => {
			// `reportUnresolvedConfigValue` is now invoked ONLY inside the shared
			// policy's `recordFailure`. A resolver calling it directly again would be
			// a second path to the report and the start of the drift the policy ends.
			const source = fs.readFileSync(resolver.path, "utf8");

			expect(source).not.toContain("reportUnresolvedConfigValue(");
		});

		it(`${resolver.name} does not reintroduce its own copy of the report text`, () => {
			// A second `logger.warn` with this wording would mean the two resolvers
			// had drifted apart again, which is the state the owner exists to end.
			const source = fs.readFileSync(resolver.path, "utf8");

			expect(source).not.toContain("so the setting it resolves is unset");
		});
	}

	it("the report has exactly one caller, in the owner", () => {
		// The whole point of the shared policy: `reportUnresolvedConfigValue` is
		// called from one place. If a second call appears anywhere, the ONE PLACE
		// guarantee is gone.
		const owner = fs.readFileSync(OWNER, "utf8");
		const callSites = owner.split("reportUnresolvedConfigValue(").length - 1;

		// One definition (`export function reportUnresolvedConfigValue(`) plus one
		// call inside `recordFailure`.
		expect(callSites).toBe(2);
	});

	it("model-registry no longer swallows the command failure with a bare catch", () => {
		// The exact shape of the original defect, in the function that had it.
		const source = fs.readFileSync(RESOLVERS[1].path, "utf8");
		const resolver = source.slice(
			source.indexOf("function resolveCommandConfig"),
			source.indexOf("function resolveCommandConfig") + 2_000,
		);

		expect(resolver).not.toContain("} catch {");
		expect(resolver).toContain("configCommandPolicy.recordFailure(");
	});

	it("model-registry pipes stderr separately, which is what makes its report possible", () => {
		// `execSync` inherits stderr by default, in which case there is nothing to
		// report. The explicit stdio triple is load-bearing, not incidental.
		const source = fs.readFileSync(RESOLVERS[1].path, "utf8");

		expect(source).toContain('stdio: ["ignore", "pipe", "pipe"]');
	});

	it("reads real resolver sources, so a passing scan means something", () => {
		// Anti-vacuity. A moved or renamed file would otherwise make every scan
		// above pass against an empty string.
		for (const resolver of [...RESOLVERS, { name: "owner", path: OWNER }]) {
			const source = fs.readFileSync(resolver.path, "utf8");
			expect(source.length).toBeGreaterThan(1_000);
		}
	});
});
