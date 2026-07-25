import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { resolveRetryKey } from "@veyyon/ai";
import { logger } from "@veyyon/utils";

/**
 * When an auth retry gives up, the REASON it gave up must survive (Law 10).
 *
 * The retry path reports `lastError` to the caller, and `lastError` is the
 * original 401. So every `catch { return undefined }` inside the retry threw
 * away the only description of what actually blocked recovery: a locked
 * credential store, a broker that could not be reached, a rotation with no
 * sibling credential to rotate to. All three presented to the user as the same
 * "authentication failed", and nothing in the logs distinguished them.
 *
 * The silence is what makes this a Law 10 violation rather than a design choice.
 * Swallowing the error and continuing is fine — a failed rotation genuinely
 * should not replace the auth error the caller needs to see — but it has to be
 * recorded on the way past.
 */
describe("An auth retry that gives up says why", () => {
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

	const authFailure = () => Object.assign(new Error("401 authentication_error"), { status: 401 });

	/**
	 * The core case. A resolver that throws is indistinguishable, from the
	 * caller's side, from a resolver that legitimately has nothing to hand back:
	 * both produce `undefined`. The log is the only thing that separates them.
	 */
	it("warns when the key resolver throws, and keeps returning undefined", async () => {
		const resolved = await resolveRetryKey(
			() => {
				throw new Error("SQLITE_BUSY: database is locked");
			},
			false,
			authFailure(),
		);

		// Behaviour is deliberately unchanged: the caller still sees "no key".
		expect(resolved).toBeUndefined();
		expect(warnings).toHaveLength(1);
		expect(warnings[0]?.message).toContain("could not resolve a replacement key");
		// Both errors are carried: the one that blocked recovery, and the one the
		// user will actually be shown. Reading either alone is misleading.
		expect(String(warnings[0]?.fields.resolveError)).toContain("SQLITE_BUSY");
		expect(String(warnings[0]?.fields.originalError)).toContain("401");
		expect(warnings[0]?.fields.lastChance).toBe(false);
	});

	/**
	 * Last-chance rotation is the attempt whose failure matters most, because
	 * nothing comes after it. The flag has to reach the log or the operator cannot
	 * tell a first-attempt refresh failure from the final give-up.
	 */
	it("records whether the failed resolve was the last chance", async () => {
		await resolveRetryKey(
			() => {
				throw new Error("no sibling credential available");
			},
			true,
			authFailure(),
		);

		expect(warnings).toHaveLength(1);
		expect(warnings[0]?.fields.lastChance).toBe(true);
	});

	/**
	 * A rejected promise is the shape this actually takes in production, since the
	 * resolver is async. A fix that only caught synchronous throws would pass the
	 * cases above and do nothing at all in the real path.
	 */
	it("warns when the resolver rejects asynchronously", async () => {
		const resolved = await resolveRetryKey(
			async () => {
				throw new Error("broker unreachable: ECONNREFUSED");
			},
			false,
			authFailure(),
		);

		expect(resolved).toBeUndefined();
		expect(warnings).toHaveLength(1);
		expect(String(warnings[0]?.fields.resolveError)).toContain("ECONNREFUSED");
	});

	/**
	 * A resolver with genuinely nothing to offer is NOT a failure, and must not
	 * warn. Without this the suite would pass against an implementation that
	 * warned on every empty resolve, which is the ordinary case on a single-account
	 * setup and would make the warning worthless.
	 */
	it("stays silent when the resolver simply has no key to give", async () => {
		const resolved = await resolveRetryKey(() => Promise.resolve(""), false, authFailure());

		expect(resolved).toBeUndefined();
		expect(warnings).toHaveLength(0);
	});

	/** The success path must be silent too. */
	it("stays silent when the resolver hands back a key", async () => {
		const resolved = await resolveRetryKey(() => Promise.resolve("sk-rotated"), false, authFailure());

		expect(resolved).toBe("sk-rotated");
		expect(warnings).toHaveLength(0);
	});
});
