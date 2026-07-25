import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type AuthCredentialStore, AuthStorage, SqliteAuthCredentialStore } from "@veyyon/ai/auth-storage";
import { removeWithRetries } from "../../utils/src/temp";

/**
 * A login torn down by a failed refresh must be reportable as exactly that.
 *
 * A refresh token that a provider rotates is single-use. If the process is
 * killed between the provider issuing the rotated token and the client writing
 * it down, the token on disk is dead and no client can recover it: it was never
 * received. The next run refreshes with the dead token, gets `invalid_grant`,
 * and disables the row. That much is unavoidable.
 *
 * What is NOT unavoidable is how it looks to the user. `listAuthCredentials`
 * hides disabled rows, which is correct for resolution and wrong for reporting:
 * `hasAuth` then returns false, and the person whose working login was thrown
 * away sees the identical message as someone who never signed in. They are told
 * to log in, with nothing saying that the login they had is gone or why. That
 * is the silent logout in its final form, and it is the half of the residual
 * SIGKILL case that IS fixable.
 *
 * `disabledCredentialCause` is the reader that can see it. These tests pin both
 * directions, because reporting the wrong disables is its own bug: a logout or
 * an account switch also disables a row, and announcing those back to the user
 * as a failure would be alarming and false.
 */
describe("reporting why a provider's credential was disabled", () => {
	let tempDir = "";
	let store: AuthCredentialStore | null = null;
	let authStorage: AuthStorage | null = null;
	const provider = "unit-disabled-cause";

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-disabled-cause-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		authStorage = new AuthStorage(store);
	});

	afterEach(async () => {
		store?.close();
		store = null;
		authStorage = null;
		if (tempDir) {
			await removeWithRetries(tempDir);
			tempDir = "";
		}
	});

	/** Store one OAuth credential and return its row id. */
	async function seedCredential(): Promise<number> {
		if (!authStorage || !store) throw new Error("test setup failed");
		await authStorage.set(provider, [
			{ type: "oauth", access: "access", refresh: "refresh", expires: Date.now() + 60_000 },
		]);
		const row = store.listAuthCredentials(provider)[0];
		if (!row) throw new Error("seeded credential did not land");
		return row.id;
	}

	/**
	 * The core case: the row is gone from every active view, and the cause is
	 * still recoverable so the user can be told what happened.
	 */
	test("reports the cause after a failed refresh disabled the only credential", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");
		const id = await seedCredential();

		// The real disable path, so the in-memory view drops the row exactly the
		// way it does in a live session.
		authStorage.disableCredentialById(id, "oauth refresh failed: HTTP 400 invalid_grant");

		// The condition that makes this invisible everywhere else: the row is gone
		// from the active list AND from `hasAuth`, so nothing downstream can tell
		// this apart from a user who never signed in.
		expect(store.listAuthCredentials(provider)).toHaveLength(0);
		expect(authStorage.hasAuth(provider)).toBe(false);

		expect(authStorage.disabledCredentialCause(provider)).toBe("oauth refresh failed: HTTP 400 invalid_grant");
	});

	/**
	 * The provider's own words must survive. "Something went wrong" cannot tell a
	 * spent refresh token apart from a lapsed subscription, and those need
	 * completely different actions from the user.
	 */
	test("carries the provider's verbatim rejection, not a generic label", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");
		const id = await seedCredential();

		store.deleteAuthCredential(id, "oauth refresh failed: 402 payment required (subscription lapsed)");

		expect(authStorage.disabledCredentialCause(provider)).toContain("402 payment required");
		expect(authStorage.disabledCredentialCause(provider)).toContain("subscription lapsed");
	});

	/**
	 * A deliberate logout must NOT be reported back as a failure. The user knows
	 * they logged out; telling them their credential "was disabled after a token
	 * refresh failed" would be both alarming and untrue.
	 */
	test("stays quiet about a deliberate logout", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");
		const id = await seedCredential();

		store.deleteAuthCredential(id, "logged out");

		expect(authStorage.disabledCredentialCause(provider)).toBeUndefined();
	});

	/**
	 * Nor about an account switch. Signing in again supersedes the old row, and
	 * the user's next action already succeeded, so there is nothing to report.
	 */
	test("stays quiet about a credential superseded by a newer login", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");
		const id = await seedCredential();

		store.deleteAuthCredential(id, "replaced by newer credential");

		expect(authStorage.disabledCredentialCause(provider)).toBeUndefined();
	});

	/**
	 * Only the most recent disable matters. An account that was removed and added
	 * back leaves older disabled rows behind, and naming a cause the user already
	 * resolved sends them chasing a problem that is over.
	 */
	test("reports the most recent disable, not an older resolved one", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");

		const first = await seedCredential();
		store.deleteAuthCredential(first, "oauth refresh failed: an old failure the user already fixed");

		await authStorage.set(provider, [
			{ type: "oauth", access: "second", refresh: "second-refresh", expires: Date.now() + 60_000 },
		]);
		const second = store.listAuthCredentials(provider)[0];
		if (!second) throw new Error("second credential did not land");
		store.deleteAuthCredential(second.id, "oauth refresh failed: the failure happening now");

		expect(authStorage.disabledCredentialCause(provider)).toContain("the failure happening now");
	});

	/**
	 * A logout AFTER a refresh failure means the user has moved on. Reporting the
	 * older refresh failure would resurrect a stale complaint, which is the same
	 * ordering bug as above with the two causes swapped.
	 */
	test("stays quiet when a logout followed an earlier refresh failure", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");

		const first = await seedCredential();
		store.deleteAuthCredential(first, "oauth refresh failed: an earlier failure");

		await authStorage.set(provider, [
			{ type: "oauth", access: "second", refresh: "second-refresh", expires: Date.now() + 60_000 },
		]);
		const second = store.listAuthCredentials(provider)[0];
		if (!second) throw new Error("second credential did not land");
		store.deleteAuthCredential(second.id, "logged out");

		expect(authStorage.disabledCredentialCause(provider)).toBeUndefined();
	});

	/**
	 * A provider that was never signed in to has nothing to report. Without this
	 * twin the suite would pass against a reader that invented a cause for every
	 * provider, turning a first run into a scary error.
	 */
	test("reports nothing for a provider with no credential at all", () => {
		if (!authStorage) throw new Error("test setup failed");

		expect(authStorage.disabledCredentialCause("never-signed-in")).toBeUndefined();
	});

	/**
	 * A healthy, active credential reports nothing either. This is the case every
	 * running session is in, so a false positive here would show the error on
	 * every turn.
	 */
	test("reports nothing while the credential is active", async () => {
		if (!authStorage) throw new Error("test setup failed");
		await seedCredential();

		expect(authStorage.hasAuth(provider)).toBe(true);
		expect(authStorage.disabledCredentialCause(provider)).toBeUndefined();
	});

	/**
	 * The reader is scoped per provider. A failure on one provider must not be
	 * reported against another the user is happily signed in to.
	 */
	test("does not report one provider's failure against another", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");
		const id = await seedCredential();
		store.deleteAuthCredential(id, "oauth refresh failed: HTTP 400 invalid_grant");

		await authStorage.set("other-provider", [
			{ type: "oauth", access: "fine", refresh: "fine-refresh", expires: Date.now() + 60_000 },
		]);

		expect(authStorage.disabledCredentialCause("other-provider")).toBeUndefined();
		expect(authStorage.disabledCredentialCause(provider)).toContain("invalid_grant");
	});
});
