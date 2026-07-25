/**
 * The pre-run credential verdict.
 *
 * WHY THIS SUITE EXISTS. Nothing checked the staged credential store before a
 * run, so a dead credential was discovered one container at a time: every trial
 * paid full container setup, failed to authenticate, and came back as a task
 * failure. The message the agent produced then blamed the model id rather than
 * the credential, and a burned 40-trial run was misread as an unservable model.
 * The response was an allowlist gate against a model that worked, later reverted.
 *
 * So the verdict's job is not only to catch a dead store, it is to be UNAMBIGUOUS
 * about which of three things happened. "One credential works", "every credential
 * that could be checked failed", and "nothing could be checked at all" are three
 * different claims, and reporting any of the last two as success is what let the
 * original failure hide.
 */
import { describe, expect, it } from "bun:test";
import { type CredentialProbe, decideAuthPreflight, describeAuthPreflightFailure } from "./auth-preflight";

const STAGED = "/bench/assets/auth-agent.db";

describe("decideAuthPreflight", () => {
	/** One usable credential is all the bench needs, and an operator running
	 * several accounts routinely has stale rows beside a live one. Demanding that
	 * every row pass would block runs that can actually succeed. */
	it("passes when a single credential serves a token, even beside failures", () => {
		const probes: CredentialProbe[] = [
			{ provider: "anthropic", ok: false, reason: "401" },
			{ provider: "google-antigravity", ok: true },
		];
		expect(decideAuthPreflight(probes)).toEqual({ kind: "ok", usable: 1 });
	});

	/** The count is reported so the operator can notice a pool that has quietly
	 * shrunk from four working accounts to one. */
	it("counts every usable credential, not just the first", () => {
		const probes: CredentialProbe[] = [
			{ provider: "a", ok: true },
			{ provider: "b", ok: true },
			{ provider: "c", ok: null },
		];
		expect(decideAuthPreflight(probes)).toEqual({ kind: "ok", usable: 2 });
	});

	/** An empty store is its own outcome. It is the state produced by staging a
	 * freshly created db, and it needs a different instruction (log in) than a
	 * store whose credentials have expired (log in AGAIN). */
	it("reports an empty store distinctly from a failing one", () => {
		expect(decideAuthPreflight([])).toEqual({ kind: "empty" });
	});

	/** THE regression. Every credential probed and every one failed, which is
	 * precisely the state that burned 40 trials while reporting a model error. */
	it("reports dead when every probed credential failed, carrying each reason", () => {
		const probes: CredentialProbe[] = [
			{ provider: "google-antigravity", ok: false, reason: "refresh token rejected" },
			{ provider: "anthropic", ok: false, reason: "401 Unauthorized" },
		];
		expect(decideAuthPreflight(probes)).toEqual({
			kind: "dead",
			failures: [
				{ provider: "google-antigravity", reason: "refresh token rejected" },
				{ provider: "anthropic", reason: "401 Unauthorized" },
			],
		});
	});

	/** The identity makes the message actionable when a pool holds several
	 * accounts on one provider: "anthropic failed" does not say which login to fix. */
	it("names the OAuth identity in a failure when one is known", () => {
		const verdict = decideAuthPreflight([{ provider: "anthropic", ok: false, reason: "401", email: "a@b.co" }]);
		expect(verdict).toEqual({ kind: "dead", failures: [{ provider: "anthropic (a@b.co)", reason: "401" }] });
	});

	/** A failure with no reason must still be reported as a failure. Dropping it
	 * for lack of a reason string would turn a dead store into an empty list and
	 * then into a pass. */
	it("keeps a reasonless failure rather than discarding it", () => {
		const verdict = decideAuthPreflight([{ provider: "anthropic", ok: false }]);
		expect(verdict).toEqual({ kind: "dead", failures: [{ provider: "anthropic", reason: "no reason reported" }] });
	});

	/**
	 * `ok: null` means the provider has no probe configured, so the credential is
	 * unverified, NOT verified-good. It gets its own outcome that the caller
	 * reports out loud before proceeding. Folding it into `ok` would be a silent
	 * fallback: the run would claim a credential check passed when none ran.
	 */
	it("reports unverifiable, not ok, when nothing could be probed", () => {
		const probes: CredentialProbe[] = [
			{ provider: "custom", ok: null },
			{ provider: "custom", ok: null },
			{ provider: "other", ok: null },
		];
		expect(decideAuthPreflight(probes)).toEqual({ kind: "unverifiable", providers: ["custom", "other"] });
	});

	/**
	 * A definite failure outranks an unverifiable row. Reporting `unverifiable`
	 * here would downgrade a known-broken store to merely unknown and let the run
	 * proceed into the failure the preflight exists to prevent.
	 */
	it("prefers a definite failure over an unverifiable sibling", () => {
		const probes: CredentialProbe[] = [
			{ provider: "custom", ok: null },
			{ provider: "anthropic", ok: false, reason: "401" },
		];
		expect(decideAuthPreflight(probes)).toEqual({
			kind: "dead",
			failures: [{ provider: "anthropic", reason: "401" }],
		});
	});
});

describe("describeAuthPreflightFailure", () => {
	/**
	 * The message must point at the credential. The previous failure path said
	 * `Model "<id>" not found` for a dead token, which is what sent a real
	 * investigation into model allowlists for a day.
	 */
	it("blames the credential and never the model", () => {
		const verdict = decideAuthPreflight([{ provider: "google-antigravity", ok: false, reason: "401" }]);
		const message = describeAuthPreflightFailure(verdict, STAGED);
		expect(message).toContain(STAGED);
		expect(message).toContain("cannot serve a token");
		expect(message).toContain("401");
		expect(message).not.toContain("--model");
		expect(message.toLowerCase()).not.toContain("not found");
		// It does steer away from the model id, because that is where the last
		// investigation went. It must do so without echoing the flag.
		expect(message).toContain("not at fault");
	});

	/** Every failing credential is listed. Printing only the first hides the
	 * second account an operator would otherwise fix in the same pass. */
	it("lists every failing credential", () => {
		const verdict = decideAuthPreflight([
			{ provider: "a", ok: false, reason: "expired" },
			{ provider: "b", ok: false, reason: "revoked" },
		]);
		const message = describeAuthPreflightFailure(verdict, STAGED);
		expect(message).toContain("a: expired");
		expect(message).toContain("b: revoked");
	});

	/** An empty store gets the first-login instruction, not the log-in-again one,
	 * and names the canonical path a login actually writes. */
	it("tells an operator with an empty store where a login lands", () => {
		const message = describeAuthPreflightFailure({ kind: "empty" }, STAGED);
		expect(message).toContain("no credentials");
		expect(message).toContain("~/.veyyon/shared-auth/agent.db");
	});

	/** The two proceeding verdicts have no failure to describe. An accidental
	 * message here would print an error before a run that is about to work. */
	it("produces nothing for verdicts that proceed", () => {
		expect(describeAuthPreflightFailure({ kind: "ok", usable: 1 }, STAGED)).toBe("");
		expect(describeAuthPreflightFailure({ kind: "unverifiable", providers: ["x"] }, STAGED)).toBe("");
	});
});
