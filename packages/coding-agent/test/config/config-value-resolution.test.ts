/**
 * The grammar and policy that the sync and async config-value resolvers share.
 *
 * Two resolvers exist because one path must be synchronous (the model registry
 * builds eagerly in a sync constructor) and the other asynchronous (the API-key
 * path must not block the TUI). They used to hand-roll the same `!command` / env
 * / literal grammar and disagree on its edges: one trimmed the command after the
 * `!` and the other did not, and only one backed off a failing command. Same
 * name, same documented contract, different behaviour depending on which path a
 * value happened to reach, which is the same-name-divergence that ONE PLACE
 * calls a latent bug rather than a style nit.
 *
 * The grammar and the caching/back-off/report policy now live here, once. This
 * suite pins the behaviour both resolvers inherit, so the parse and policy can
 * never quietly diverge again. The reporting text itself is covered by
 * `config-value-command-failures.test.ts`; here we prove WHEN the report fires.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import {
	commandFailureReason,
	createCommandResolutionPolicy,
	describeConfigEnvReference,
	isConfigValueCommand,
	parseConfigValueCommand,
	resolveConfigEnvReference,
} from "@veyyon/coding-agent/config/config-value-resolution";
import { logger } from "@veyyon/utils";

describe("the shared config-value grammar", () => {
	describe("isConfigValueCommand", () => {
		it("recognises a !command", () => {
			expect(isConfigValueCommand("!op read op://v/k")).toBe(true);
		});

		it("rejects a bare value and undefined", () => {
			expect(isConfigValueCommand("MY_ENV")).toBe(false);
			expect(isConfigValueCommand(undefined)).toBe(false);
		});
	});

	describe("parseConfigValueCommand", () => {
		it("returns null for a non-command so the caller falls through to env/literal", () => {
			expect(parseConfigValueCommand("MY_ENV")).toBeNull();
		});

		it("strips the leading ! and trims, so both resolvers run the identical command", () => {
			// THE divergence H1-88 names: one resolver trimmed after the `!` and the
			// other did not, so `!  op read x` ran `  op read x` on one path and
			// `op read x` on the other. Trimming here makes the two identical.
			expect(parseConfigValueCommand("!  op read op://v/k  ")).toBe("op read op://v/k");
			expect(parseConfigValueCommand("!op read op://v/k")).toBe("op read op://v/k");
		});
	});

	describe("resolveConfigEnvReference", () => {
		const KEY = "VEYYON_TEST_SHARED_RESOLUTION";

		afterEach(() => {
			delete process.env[KEY];
		});

		it("returns the environment variable when it is set", () => {
			process.env[KEY] = "from-env";

			expect(resolveConfigEnvReference(KEY)).toEqual({ ok: true, value: "from-env" });
		});

		it("keeps a value outside the environment-name shape as the value itself", () => {
			// A real key is not shaped like a variable name, and failing those closed
			// would break working configs to fix a typo they cannot make.
			expect(resolveConfigEnvReference("sk-literal-value")).toEqual({ ok: true, value: "sk-literal-value" });
			expect(resolveConfigEnvReference("sk_live_51abc")).toEqual({ ok: true, value: "sk_live_51abc" });
		});

		it("fails closed for an environment name that is not set", () => {
			expect(resolveConfigEnvReference(KEY)).toEqual({ ok: false, variable: KEY, explicit: false, empty: false });
		});

		it("fails closed for an environment name that is set but empty", () => {
			// An exported-but-empty variable is the CI failure this exists to catch: it
			// is not a usable secret and it is not a literal either.
			process.env[KEY] = "";

			expect(resolveConfigEnvReference(KEY)).toEqual({ ok: false, variable: KEY, explicit: false, empty: true });
		});

		it.each([`\${${KEY}}`, `$${KEY}`])("resolves the explicit reference %p", spelling => {
			process.env[KEY] = "from-env";

			expect(resolveConfigEnvReference(spelling)).toEqual({ ok: true, value: "from-env" });
		});

		it.each([`\${${KEY}}`, `$${KEY}`])("fails closed for the unset explicit reference %p", spelling => {
			expect(resolveConfigEnvReference(spelling)).toEqual({
				ok: false,
				variable: KEY,
				explicit: true,
				empty: false,
			});
		});

		it("takes a lower-case explicit reference, which the bare form does not read", () => {
			process.env.veyyon_test_lower_ref = "from-lower-env";
			try {
				// biome-ignore lint/suspicious/noTemplateCurlyInString: the config grammar's own spelling, not an interpolation
				expect(resolveConfigEnvReference("${veyyon_test_lower_ref}")).toEqual({
					ok: true,
					value: "from-lower-env",
				});
				expect(resolveConfigEnvReference("veyyon_test_lower_ref")).toEqual({
					ok: true,
					value: "from-lower-env",
				});
			} finally {
				delete process.env.veyyon_test_lower_ref;
			}
		});

		it("sends a literal: value verbatim, even when a variable of that name is set", () => {
			process.env[KEY] = "from-env";

			expect(resolveConfigEnvReference(`literal:${KEY}`)).toEqual({ ok: true, value: KEY });
			expect(resolveConfigEnvReference("literal:$NOT_A_REFERENCE")).toEqual({ ok: true, value: "$NOT_A_REFERENCE" });
		});

		it("keeps a value that only looks like a reference as a literal", () => {
			// `$` followed by something that is not a variable name is text, so a
			// password of that shape is still transmitted as written.
			expect(resolveConfigEnvReference("$ecret-p4ss")).toEqual({ ok: true, value: "$ecret-p4ss" });
			// biome-ignore lint/suspicious/noTemplateCurlyInString: the config grammar's own spelling, not an interpolation
			expect(resolveConfigEnvReference("${A} ${B}")).toEqual({ ok: true, value: "${A} ${B}" });
		});
	});

	describe("describeConfigEnvReference", () => {
		it("names the variable a value refers to, and nothing else", () => {
			// biome-ignore lint/suspicious/noTemplateCurlyInString: the config grammar's own spelling, not an interpolation
			expect(describeConfigEnvReference("${GITHUB_TOKN}")).toEqual({ variable: "GITHUB_TOKN", explicit: true });
			expect(describeConfigEnvReference("GITHUB_TOKN")).toEqual({ variable: "GITHUB_TOKN", explicit: false });
			// A literal, an escaped literal and a command refer to no variable, so a
			// caller that must fail closed on a reference leaves all three alone.
			expect(describeConfigEnvReference("sk-literal-value")).toBeNull();
			expect(describeConfigEnvReference("literal:GITHUB_TOKN")).toBeNull();
			expect(describeConfigEnvReference("!op read op://vault/key")).toBeNull();
		});
	});

	describe("the failure-reason vocabulary", () => {
		it("phrases each failure the same way for both resolvers", () => {
			// Both paths derive a reason from what happened; wording it here once is
			// what stops the same failure being described two different ways.
			expect(commandFailureReason.timedOut(10_000)).toBe("it did not finish within 10000ms and was killed");
			expect(commandFailureReason.exited(1)).toBe("it exited with code 1");
			expect(commandFailureReason.exited("unknown")).toBe("it exited with code unknown");
			expect(commandFailureReason.emptyOutput).toBe("it succeeded but wrote nothing to stdout");
			expect(commandFailureReason.spawnFailed("boom")).toBe("it could not be run: boom");
		});
	});
});

describe("the shared command-resolution policy", () => {
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

	const reports = (): number =>
		warnings.filter(w => w.message === "A configured command produced no value, so the setting it resolves is unset")
			.length;

	it("caches a success and returns it without re-running", () => {
		const policy = createCommandResolutionPolicy();
		expect(policy.getCached("cmd")).toBeUndefined();

		policy.recordSuccess("cmd", "secret");

		expect(policy.getCached("cmd")).toBe("secret");
	});

	it("backs off a failed command so it is not retried within the window", () => {
		// The behaviour the async resolver GAINED in the unification: a command that
		// just failed is skipped rather than re-run on the next request.
		const policy = createCommandResolutionPolicy(30_000);

		expect(policy.isBackedOff("cmd")).toBe(false);
		policy.recordFailure("cmd", undefined, "it exited with code 1");

		expect(policy.isBackedOff("cmd")).toBe(true);
	});

	it("reports a failing streak exactly once, not on every failure", () => {
		// A credential command that fails on every lookup must be explained once,
		// not fill the log. Repeated failures update the timer silently.
		const policy = createCommandResolutionPolicy(30_000);

		policy.recordFailure("cmd", undefined, "it exited with code 1");
		policy.recordFailure("cmd", undefined, "it exited with code 1");
		policy.recordFailure("cmd", undefined, "it exited with code 1");

		expect(reports()).toBe(1);
	});

	it("reports again after a success resets the streak", () => {
		// A failure, a recovery, then a NEW failure is worth knowing about: the
		// recovery clears the back-off, so the next failure counts as fresh. This is
		// the one behaviour that differs from a permanent report-once, and it is the
		// more informative choice.
		const policy = createCommandResolutionPolicy(30_000);

		policy.recordFailure("cmd", undefined, "it exited with code 1");
		expect(reports()).toBe(1);

		policy.recordSuccess("cmd", "secret");
		expect(policy.isBackedOff("cmd")).toBe(false);

		policy.recordFailure("cmd", undefined, "it exited with code 1");
		expect(reports()).toBe(2);
	});

	it("clears all state so a reused process starts clean", () => {
		const policy = createCommandResolutionPolicy();
		policy.recordSuccess("cmd", "secret");
		policy.recordFailure("other", undefined, "it exited with code 1");

		policy.clear();

		expect(policy.getCached("cmd")).toBeUndefined();
		expect(policy.isBackedOff("other")).toBe(false);
	});

	it("keys cache and back-off per command, so one failure does not poison another", () => {
		const policy = createCommandResolutionPolicy();
		policy.recordSuccess("good", "secret");
		policy.recordFailure("bad", undefined, "it exited with code 1");

		expect(policy.getCached("good")).toBe("secret");
		expect(policy.isBackedOff("good")).toBe(false);
		expect(policy.isBackedOff("bad")).toBe(true);
	});
});
