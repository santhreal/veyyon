/**
 * WHY THIS EXISTS. `secrets.expiryWarnings` is a switch over an INTERRUPTION: the session raises an
 * expiry warning at a turn boundary without being asked, and there was no way to decline it. A
 * setting that is declared in a defaults table and never reaches behaviour is a dead flag, so this
 * suite drives the real `createAgentSession` over a real vault and reads the real notice sink.
 *
 * THE CLASS, not the incident. There are TWO unprompted expiry warnings in a session: the startup
 * sweep over the loaded vault (`expiryWarnings`) and the obfuscator's mid-session `onExpiry`, which
 * fires when a placeholder lapses while the session is running. Gating one and leaving the other is
 * the same defect with a different trigger, and it is the exact mistake this file was written after
 * catching. Both arms are asserted here: the startup sweep through the session, and the `onExpiry`
 * option the session hands the obfuscator.
 *
 * WHAT IT DELIBERATELY DOES NOT SILENCE, asserted as its own row. `/secret list` prints a STATUS
 * column and the status-line chip shows the vault. Those were asked for -- by opening the list, by
 * looking at the line -- and answering a question with silence is a different feature from not
 * interrupting. A setting that swallowed those too would pass a naive "warnings are off" test.
 *
 * WHAT IT DOES NOT CATCH. It says nothing about how the notice is painted, and nothing about the
 * `onRejection` warning beside `onExpiry`, which reports a value the redactor could not process --
 * a failure, not a lapse, and not this setting's business.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { createAgentSession } from "@veyyon/coding-agent/sdk";
import { renderSecretList } from "@veyyon/coding-agent/secrets/secret-command";
import { resolveVaultLocations, SecretVault } from "@veyyon/coding-agent/secrets/vault";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import { OperatorNotices } from "@veyyon/coding-agent/session/operator-notices";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { TempDir } from "@veyyon/utils";
import { useIsolatedConfigRoot } from "../helpers/isolated-agent-dir";

// Keeps the vault key and any global vault out of the real ~/.veyyon.
const configRoot = useIsolatedConfigRoot();

const NAME = "NEAR_EXPIRY_TOKEN";
const VALUE = "ghp_a_credential_that_is_about_to_lapse";
/** One hour, so an entry seeded 95% through it is past the 0.9 threshold and never lapses mid-test. */
const LIFETIME_MS = 60 * 60 * 1000;
/** The sentence only the obfuscator's mid-session `onExpiry` writes, never the startup sweep. */
const LAPSED_MID_SESSION = "has expired and its in-memory expansion has been revoked";

let registryRoot: TempDir;
let authStorage: AuthStorage;
let modelRegistry: ModelRegistry;

beforeAll(async () => {
	registryRoot = TempDir.createSync("expiry-warning-switch-registry-");
	authStorage = await AuthStorage.create(registryRoot.join("auth.db"));
	modelRegistry = new ModelRegistry(authStorage, registryRoot.join("models.yml"));
});

afterAll(async () => {
	authStorage.close();
	await registryRoot.remove();
});

interface Arm {
	/** Every notice the session raised, as text. */
	notices: string[];
	/** Whether the secret runtime was built at all, so an absent warning cannot be a skipped vault. */
	protectionLive: boolean;
	/** Whether the placeholder was still expanding at the moment the arm was read. */
	stillLive: boolean;
}

/**
 * Boot a real session over a vault holding one secret that expires at a chosen moment.
 *
 * The entry is seeded through a vault on a BACKDATED clock rather than by sleeping: `add` stamps
 * `createdAt` from the clock it was given, so a vault built in the past writes an entry already
 * part-way through its life by the time the session reads it on the real clock. `expiresAt` lands
 * exactly `expiresInMs` from now, which is what lets the mid-session arm wait for a known deadline
 * instead of guessing a sleep.
 */
async function boot(options: {
	expiryWarnings: boolean;
	lifetimeMs: number;
	expiresInMs: number;
	/** Runs after boot, before the notices are read, with the session's own obfuscator. */
	afterBoot?: (probe: () => boolean, expiresAt: number) => Promise<void>;
}): Promise<Arm> {
	const root = TempDir.createSync("expiry-warning-switch-");
	try {
		const project = path.resolve(root.join("project"));
		const agentDir = path.resolve(root.join("agent"));
		await fs.mkdir(project, { recursive: true });
		const locations = resolveVaultLocations({ globalConfigRoot: configRoot(), agentDir, cwd: project });
		const expiresAt = Date.now() + options.expiresInMs;
		const seedVault = new SecretVault(locations, () => expiresAt - options.lifetimeMs);
		await seedVault.add({ name: NAME, value: VALUE, scope: "project", ttl: options.lifetimeMs });

		const notices = new OperatorNotices();
		const { session } = await createAgentSession({
			cwd: project,
			agentDir,
			sessionManager: SessionManager.inMemory(project),
			operatorNotices: notices,
			// `secrets.enabled` is off by default, and without it the secret runtime is never built,
			// no vault is read, and BOTH arms would pass for a reason that has nothing to do with the
			// setting under test.
			settings: Settings.isolated({
				"secrets.enabled": true,
				"secrets.expiryWarnings": options.expiryWarnings,
			}),
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
		try {
			// `hasNamedSecret` is the production sweep: it drops anything past its deadline and calls
			// the `onExpiry` the SESSION installed, which is the gate under test. Reading it through
			// the session's own obfuscator is what makes this end to end rather than a re-creation.
			const probe = () => session.obfuscator?.hasNamedSecret(NAME) ?? false;
			await options.afterBoot?.(probe, expiresAt);
			return {
				notices: notices.all().map(notice => notice.text),
				protectionLive: session.obfuscator !== undefined,
				stillLive: probe(),
			};
		} finally {
			await session.dispose();
		}
	} finally {
		await root.remove();
	}
}

/** Boot with the entry 95% through an hour: warned at startup, alive for the whole test. */
function bootWithNearlyExpiredSecret(expiryWarnings: boolean): Promise<Arm> {
	return boot({ expiryWarnings, lifetimeMs: LIFETIME_MS, expiresInMs: Math.floor(LIFETIME_MS * 0.05) });
}

/** Boot with the entry alive, then hold until it lapses under the running session. */
function bootAndOutliveTheSecret(expiryWarnings: boolean): Promise<Arm> {
	return boot({
		expiryWarnings,
		lifetimeMs: 60_000,
		expiresInMs: 4_000,
		afterBoot: async (probe, expiresAt) => {
			// The precondition: it really was expanding while the session ran, so a later absence is
			// a lapse and not a vault that was never read.
			expect(probe()).toBe(true);
			const remaining = expiresAt - Date.now();
			if (remaining > 0) await sleep(remaining + 50);
			// Crossing the deadline is not enough on its own: something has to ask, and this is the
			// ordinary question a session asks before spending a placeholder.
			expect(probe()).toBe(false);
		},
	});
}

describe("the unprompted expiry warning", () => {
	it("interrupts by default, naming the placeholder that is about to lapse", async () => {
		const arm = await bootWithNearlyExpiredSecret(true);

		expect(arm.protectionLive).toBe(true);
		const warned = arm.notices.filter(text => text.includes(`#${NAME}#`));
		expect(warned).toHaveLength(1);
		expect(warned[0]).toContain("expires soon");
		// The value is what the warning is about and must never be in it.
		expect(warned[0]).not.toContain(VALUE);
		// The warning was about a credential that is still spendable, which is what makes it worth
		// raising at all: a warning about a dead placeholder would be a different bug.
		expect(arm.stillLive).toBe(true);
	});

	it("says nothing when it is switched off, over a vault that is still protected", async () => {
		const arm = await bootWithNearlyExpiredSecret(false);

		// The load-bearing half. An absent warning proves the setting only if the secret runtime was
		// built and the vault was read: a session that quietly skipped both would look identical.
		expect(arm.protectionLive).toBe(true);
		expect(arm.notices.filter(text => text.includes(NAME))).toEqual([]);
		expect(arm.notices.filter(text => text.includes("expires soon"))).toEqual([]);
	});

	/**
	 * THE SECOND TRIGGER, and the reason this file exists in this shape. A session that outlives a
	 * credential revokes it in place and says so, through `onExpiry` rather than the startup sweep.
	 * Gating only the sweep left the session still interrupting about expiry with the warnings
	 * switched off, so the setting would have been half a setting.
	 */
	it("also covers a secret that lapses while the session is running", async () => {
		const arm = await bootAndOutliveTheSecret(true);

		expect(arm.stillLive).toBe(false);
		const lapsed = arm.notices.filter(text => text.includes(LAPSED_MID_SESSION));
		expect(lapsed).toHaveLength(1);
		expect(lapsed[0]).toContain(`#${NAME}#`);
		expect(lapsed[0]).not.toContain(VALUE);
	}, 30_000);

	it("is silent about a mid-session lapse too, while still revoking it", async () => {
		const arm = await bootAndOutliveTheSecret(false);

		// Revocation is a security property and is NOT what this setting governs: the placeholder
		// must stop expanding whether or not anyone is told. Asserting both together is what stops
		// the setting from being implemented by not expiring the secret.
		expect(arm.stillLive).toBe(false);
		expect(arm.notices.filter(text => text.includes(LAPSED_MID_SESSION))).toEqual([]);
		expect(arm.notices.filter(text => text.includes(NAME))).toEqual([]);
	}, 30_000);

	it("is the default, so a fresh install is warned", () => {
		expect(Settings.isolated().get("secrets.expiryWarnings")).toBe(true);
	});
});

describe("what switching the warning off does not switch off", () => {
	/**
	 * The list was asked for. Gating it would answer a direct question with silence, which is a
	 * different feature from not interrupting -- and it is the tempting simplification, since one
	 * flag over every mention of expiry is less code than one flag over the unprompted ones.
	 */
	it("leaves the STATUS column in /secret list, which the operator opened on purpose", () => {
		const seededAt = Date.now() - Math.floor(LIFETIME_MS * 0.95);
		const rendered = renderSecretList(
			[
				{
					name: NAME,
					value: VALUE,
					scope: "project",
					createdAt: seededAt,
					expiresAt: seededAt + LIFETIME_MS,
				},
			],
			{ now: Date.now() },
		);

		expect(rendered).toContain(NAME);
		expect(rendered).toContain("expires soon");
		expect(rendered).not.toContain(VALUE);
	});
});
