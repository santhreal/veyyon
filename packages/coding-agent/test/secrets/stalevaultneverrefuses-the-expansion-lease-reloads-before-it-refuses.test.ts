/**
 * The expansion lease reloads before it refuses, and refuses only what it truly cannot answer.
 *
 * THE BUG THIS LOCKS OUT. The freshness guard on a `SecretRuntimeLease` used to be one synchronous
 * method that scheduled `refreshSecretRuntime` with `void`, threw away the promise, and then threw
 * unconditionally. Every stale revision therefore became a refusal even though the fix for it had
 * just been started and abandoned on the previous line. The lease now answers three separate
 * questions, and this suite pins each one: `isFreshForExpansion` (pure, never throws, never
 * schedules, so a render path can degrade instead of unwinding), `ensureFreshForExpansion` (awaits
 * the reload and proceeds), and the residual `assertFreshForExpansion` (synchronous callers, which
 * cannot await, get a scheduled reload plus an actionable refusal).
 *
 * WHAT BREAKS IF THIS REGRESSES. Either the recovery goes back to being fire-and-forget, so a stale
 * revision refuses work it could have completed, or the fail-closed path disappears and a rotated
 * or revoked credential gets spent from a snapshot that predates the rotation. Both are covered
 * here in both directions.
 *
 * WHY THE LEASE AND NOT THE SEAM. The sibling suite drives the real tool-call seam end to end. This
 * one drives the lease API directly, because the reload accounting (how many loads a refusal costs,
 * and that a payload with nothing to expand costs zero) is invisible from the seam and is exactly
 * what turns a churning fingerprint into a reload storm.
 *
 * NO VALUE IS EVER ASSERTED AGAINST A PRINTED FAILURE except through `deobfuscate`, whose whole
 * contract is that it returns the value; the credentials here are fixtures, not real.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { createAgentSession } from "@veyyon/coding-agent/sdk";
import { SecretVault } from "@veyyon/coding-agent/secrets/vault";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { TempDir } from "@veyyon/utils";
import { useIsolatedConfigRoot } from "../helpers/isolated-agent-dir";
import { useSpyTeardown } from "../helpers/spy-teardown";

const A_TOKEN_VALUE = "lease-lane-project-a-credential-1111";
const A_TOKEN_ROTATED = "lease-lane-project-a-rotated-22222222";
const B_TOKEN_VALUE = "lease-lane-project-b-credential-3333";

const getConfigRoot = useIsolatedConfigRoot();

let registryRoot: TempDir;
let authStorage: AuthStorage;
let modelRegistry: ModelRegistry;

beforeAll(async () => {
	registryRoot = TempDir.createSync("stale-lease-registry-");
	authStorage = await AuthStorage.create(registryRoot.join("auth.db"));
	modelRegistry = new ModelRegistry(authStorage, registryRoot.join("models.yml"));
});

afterAll(async () => {
	authStorage.close();
	await registryRoot.remove();
});

interface LeaseFixture {
	root: TempDir;
	projectA: string;
	projectB: string;
	/** An out-of-band handle on project A's vault, standing in for another process. */
	vaultA: SecretVault;
	settings: Settings;
	session: AgentSession;
}

async function createLeaseFixture(): Promise<LeaseFixture> {
	const root = TempDir.createSync("stale-lease-fixture-");
	const projectA = path.resolve(root.join("project-a"));
	const projectB = path.resolve(root.join("project-b"));
	const agentDir = path.resolve(root.join("agent"));
	await Promise.all([fs.mkdir(projectA, { recursive: true }), fs.mkdir(projectB, { recursive: true })]);
	const locations = (cwd: string) => ({
		globalConfigRoot: getConfigRoot(),
		profileDir: agentDir,
		projectDir: path.join(cwd, ".veyyon"),
	});
	const vaultA = new SecretVault(locations(projectA));
	const vaultB = new SecretVault(locations(projectB));
	await vaultA.add({ name: "A_TOKEN", value: A_TOKEN_VALUE, scope: "project" });
	await vaultB.add({ name: "B_TOKEN", value: B_TOKEN_VALUE, scope: "project" });
	const settings = Settings.isolated({ "secrets.enabled": true });
	const { session } = await createAgentSession({
		cwd: projectA,
		agentDir,
		sessionManager: SessionManager.inMemory(projectA),
		settings,
		modelRegistry,
		disableExtensionDiscovery: true,
		extensions: [],
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
		skipPythonPreflight: true,
	});
	return { root, projectA, projectB, vaultA, settings, session };
}

// The rows below install `SecretVault.prototype` spies, and one deliberately PARKS a load and holds
// it parked, because the whole assertion is that nothing schedules a second one. A row killed by the
// deadline never reaches its own `finally`, so without this the rest of the file runs against a live
// mock and against a gate nobody will ever open. `finally` blocks stay; this is the kill path only.
const teardown = useSpyTeardown();

/**
 * Make the live vault revision disagree with whatever every existing lease captured.
 *
 * `answer` is called for every `revision()` from here on, so a constant models one external write
 * followed by quiet, and a counter models a writer that never stops.
 */
function overrideVaultRevision(answer: () => string): { restore: () => void } {
	const spy = teardown.spy(SecretVault.prototype, "revision").mockImplementation(answer);
	return { restore: () => spy.mockRestore() };
}

describe("a lease whose captured vault revision has been overtaken", () => {
	/**
	 * `isFreshForExpansion` is the question a render path asks, so it has to be total: an answer for
	 * every input, no throw, and no work scheduled behind the caller's back. The payload-aware form is
	 * the whole point. Text with nothing to expand is fresh by definition, because `deobfuscate` would
	 * return it unchanged whatever the vault did. Regression guarded: making the predicate
	 * session-wide again, or letting it reload as a side effect of being asked.
	 */
	it("answers freshness per payload, without reloading anything", async () => {
		const fixture = await createLeaseFixture();
		const revision = overrideVaultRevision(() => "an-external-writer-moved-it");
		const loadSpy = teardown.spy(SecretVault.prototype, "load");
		try {
			const lease = await fixture.session.leaseSecretRuntime();
			// The lease just reloaded to reach the overridden revision, so it starts fresh.
			expect(lease.isFreshForExpansion()).toBe(true);

			let tick = 0;
			revision.restore();
			const churn = overrideVaultRevision(() => `churn-${++tick}`);
			try {
				loadSpy.mockClear();
				expect(lease.isFreshForExpansion()).toBe(false);
				expect(lease.isFreshForExpansion("#A_TOKEN#")).toBe(false);
				expect(lease.isFreshForExpansion("nothing to expand in here")).toBe(true);
				expect(lease.isFreshForExpansion("#A_TOKEN_THAT_WAS_NEVER_STORED#")).toBe(true);
				expect(lease.isFreshForExpansion("")).toBe(true);
				expect(loadSpy).not.toHaveBeenCalled();
			} finally {
				churn.restore();
			}
		} finally {
			loadSpy.mockRestore();
			revision.restore();
			await fixture.session.dispose();
			await fixture.root.remove();
		}
	});

	/**
	 * The recovery itself. A rotation the session never saw is the case the guard exists for, and the
	 * right answer is to re-read the vault and carry on, not to refuse. The reloaded runtime is
	 * installed on the session too, so the caller that awaited is looking at the current values by the
	 * time it resumes. Regression guarded: going back to `void refreshSecretRuntime(...)` and throwing
	 * anyway, which is what shipped.
	 */
	it("reloads a rotated vault and resolves instead of refusing", async () => {
		const fixture = await createLeaseFixture();
		let revision = overrideVaultRevision(() => "before-the-rotation");
		try {
			const lease = await fixture.session.leaseSecretRuntime();
			expect(lease.expansionObfuscator?.deobfuscate("#A_TOKEN#")).toBe(A_TOKEN_VALUE);

			await fixture.vaultA.add({ name: "A_TOKEN", value: A_TOKEN_ROTATED, scope: "project" });
			revision.restore();
			revision = overrideVaultRevision(() => "after-the-rotation");

			expect(lease.isFreshForExpansion("#A_TOKEN#")).toBe(false);
			await lease.ensureFreshForExpansion("#A_TOKEN#");

			expect(fixture.session.obfuscator?.deobfuscate("#A_TOKEN#")).toBe(A_TOKEN_ROTATED);
			const reloaded = await fixture.session.leaseSecretRuntime();
			expect(reloaded.isFreshForExpansion("#A_TOKEN#")).toBe(true);
			expect(reloaded.expansionObfuscator?.deobfuscate("#A_TOKEN#")).toBe(A_TOKEN_ROTATED);
		} finally {
			revision.restore();
			await fixture.session.dispose();
			await fixture.root.remove();
		}
	});

	/**
	 * The cheap path has to stay cheap. A stale revision plus a payload with nothing to expand must
	 * cost zero reloads, because that is the shape of almost every call a session makes and a
	 * fingerprint that moves on its own would otherwise turn each one into a vault read. Regression
	 * guarded: refreshing on staleness alone, before asking whether the payload needs anything.
	 */
	it("does not reload at all for a payload with no live placeholder", async () => {
		const fixture = await createLeaseFixture();
		const revision = overrideVaultRevision(() => "an-external-writer-moved-it");
		const loadSpy = teardown.spy(SecretVault.prototype, "load");
		try {
			const lease = await fixture.session.leaseSecretRuntime();
			let tick = 0;
			revision.restore();
			const churn = overrideVaultRevision(() => `churn-${++tick}`);
			try {
				loadSpy.mockClear();
				await lease.ensureFreshForExpansion('echo "$HOME"; echo ---; ls -la "$HOME"');
				await lease.ensureFreshForExpansion("#A_TOKEN_THAT_WAS_NEVER_STORED#");
				expect(loadSpy).not.toHaveBeenCalled();
			} finally {
				churn.restore();
			}
		} finally {
			loadSpy.mockRestore();
			revision.restore();
			await fixture.session.dispose();
			await fixture.root.remove();
		}
	});

	/**
	 * The genuine fail-closed. The payload really does carry a live placeholder, the reload really was
	 * attempted, and it really did fail, so nothing can say the snapshot's value is still the vault's
	 * value. It must refuse, name the reload failure rather than blaming another session, and tell the
	 * operator what to do next. Regression guarded: deleting the fail-closed path, and the original
	 * message that reported a failed reload as "the vault changed in another session or process".
	 */
	it("refuses a live placeholder when the reload itself fails, and says why", async () => {
		const fixture = await createLeaseFixture();
		const revision = overrideVaultRevision(() => "an-external-writer-moved-it");
		try {
			const lease = await fixture.session.leaseSecretRuntime();
			let tick = 0;
			revision.restore();
			const churn = overrideVaultRevision(() => `churn-${++tick}`);
			const loadSpy = teardown.spy(SecretVault.prototype, "load").mockImplementation(async () => {
				throw new Error("vault file is unreadable");
			});
			try {
				const refusal = lease.ensureFreshForExpansion("token=#A_TOKEN#");
				await expect(refusal).rejects.toThrow("Secret expansion was refused");
				await expect(refusal).rejects.toThrow("vault file is unreadable");
				await expect(refusal).rejects.toThrow("/secret list");
				await expect(refusal).rejects.not.toThrow("changed in another session or process");
				// One attempt, not a storm: a revision that never settles must not be retried in a loop.
				expect(loadSpy).toHaveBeenCalledTimes(1);
			} finally {
				loadSpy.mockRestore();
				churn.restore();
			}
		} finally {
			revision.restore();
			await fixture.session.dispose();
			await fixture.root.remove();
		}
	});

	/**
	 * The same refusal when the reload succeeds but cannot win. Nothing threw, the vault loaded fine,
	 * and the revision had already moved again by the time the new lease captured it. That is not a
	 * reload failure and the message must not pretend otherwise, but it is still a case where no
	 * current value can be proven, so it still refuses after exactly one attempt.
	 */
	it("refuses a live placeholder when no reload can reach a revision that stays current", async () => {
		const fixture = await createLeaseFixture();
		const revision = overrideVaultRevision(() => "an-external-writer-moved-it");
		try {
			const lease = await fixture.session.leaseSecretRuntime();
			let tick = 0;
			revision.restore();
			const churn = overrideVaultRevision(() => `churn-${++tick}`);
			const loadSpy = teardown.spy(SecretVault.prototype, "load");
			try {
				loadSpy.mockClear();
				await expect(lease.ensureFreshForExpansion("token=#A_TOKEN#")).rejects.toThrow(
					"Secret expansion was refused",
				);
				expect(loadSpy).toHaveBeenCalledTimes(1);
			} finally {
				loadSpy.mockRestore();
				churn.restore();
			}
		} finally {
			revision.restore();
			await fixture.session.dispose();
			await fixture.root.remove();
		}
	});

	/**
	 * The rule that predates this lane and has to survive it. One admitted request keeps the lease it
	 * was admitted with, so a lease can outlive the cwd it belongs to. Reloading THAT directory would
	 * supersede the destination's own in-flight refresh and hand the session the vault it just left.
	 * The lease must therefore wait for the move rather than schedule anything, and then refuse,
	 * because the project it is pinned to is no longer the one being loaded. Regression guarded:
	 * "always refresh on stale" trampling a cwd transition.
	 */
	it("never schedules a reload for a directory the session has already left", async () => {
		const fixture = await createLeaseFixture();
		const sourceLease = await fixture.session.leaseSecretRuntime();
		// Only now, so the source lease captured a real fingerprint the live one disagrees with.
		const revision = overrideVaultRevision(() => "an-external-writer-moved-it");
		const originalLoad = SecretVault.prototype.load;
		// Both gates come from the registry: a deadline kill opens them, so a killed row cannot leave
		// this file's remaining rows parked on a load that nobody will ever release.
		const destinationLoadStarted = teardown.gate();
		const releaseDestinationLoad = teardown.gate();
		let blockNextLoad = true;
		const loadSpy = teardown.spy(SecretVault.prototype, "load").mockImplementation(async function (
			this: SecretVault,
		) {
			if (blockNextLoad) {
				blockNextLoad = false;
				destinationLoadStarted.open();
				await releaseDestinationLoad.reached;
			}
			return originalLoad.call(this);
		});

		try {
			const moving = fixture.session.setCwd(fixture.projectB);
			await destinationLoadStarted.reached;
			expect(loadSpy).toHaveBeenCalledTimes(1);

			// Settled immediately, so the rejection is never unhandled while the move finishes.
			const refusal = sourceLease.ensureFreshForExpansion("token=#A_TOKEN#").then(
				() => "it resolved instead of refusing",
				(error: unknown) => String(error),
			);
			// The refusal is pending on the destination's load, not racing it with a second one.
			expect(loadSpy).toHaveBeenCalledTimes(1);

			releaseDestinationLoad.open();
			await moving;
			expect(await refusal).toContain("a directory the session has already left");
			expect(loadSpy).toHaveBeenCalledTimes(1);
		} finally {
			releaseDestinationLoad.open();
			loadSpy.mockRestore();
			revision.restore();
			await fixture.session.dispose();
			await fixture.root.remove();
		}
	});
});
