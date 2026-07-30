/**
 * Live secret-runtime lifecycle boundaries.
 *
 * These are integration tests rather than obfuscator unit tests: they exercise the SDK-owned
 * loader and the AgentSession API used by `/secret` and `/move`. The assertions cover the
 * positive and negative toggle directions, the enabled/disabled boundary, add/remove
 * reconciliation, cross-project replacement, stale-name removal, and an adversarial mutable
 * provider hook. Exact outbound payloads are asserted so merely changing a status flag cannot
 * make the suite pass while the credential still leaves the process.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { SelectorController } from "@veyyon/coding-agent/modes/controllers/selector-controller";
import { createAgentSession, type ExtensionFactory } from "@veyyon/coding-agent/sdk";
import { SecretVault } from "@veyyon/coding-agent/secrets/vault";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { runSecretCommandForSurface } from "@veyyon/coding-agent/slash-commands/helpers/secret";
import { createPersistedSubagentReviverFactory } from "@veyyon/coding-agent/task/persisted-revive";
import { TempDir } from "@veyyon/utils";
import { useIsolatedConfigRoot } from "../helpers/isolated-agent-dir";
import { useSpyTeardown } from "../helpers/spy-teardown";

const PROJECT_A_VALUE = "project-a-secret-value-12345";
const PROJECT_B_VALUE = "project-b-secret-value-67890";
const ADDED_WHILE_OFF_VALUE = "added-while-disabled-value-24680";
const CONFIG_A_VALUE = "project-a-file-secret-13579";
const CONFIG_B_VALUE = "project-b-file-secret-97531";
const ENV_VALUE = "runtime-environment-secret-86420";
const ENV_NAME = "VEYYON_LIFECYCLE_SECRET";
const getConfigRoot = useIsolatedConfigRoot();

let registryRoot: TempDir;
let authStorage: AuthStorage;
let modelRegistry: ModelRegistry;

beforeAll(async () => {
	registryRoot = TempDir.createSync("secret-runtime-registry-");
	authStorage = await AuthStorage.create(registryRoot.join("auth.db"));
	modelRegistry = new ModelRegistry(authStorage, registryRoot.join("models.yml"));
});

afterAll(async () => {
	authStorage.close();
	await registryRoot.remove();
});

/**
 * Two rows below spy on `SecretVault.prototype.load` and deliberately park a load inside it, so the
 * mock and the parked waiter are shared by every LATER ROW IN THIS FILE. A deadline kill never reaches
 * their `finally`, so both undos are registered at creation instead; `helpers/spy-teardown` explains
 * what that prevents. Measured, not assumed: with the drain disabled, sabotage that hangs the first of
 * those rows also turns the second one red, because it inherits a live mock whose one-shot gate is
 * already spent. With the drain, only the sabotaged row fails. The blast radius stops at the file
 * boundary, since bun restores spies when a file finishes.
 *
 * The `finally` blocks stay: this is the backstop for the kill path, not a replacement for teardown.
 */
const teardown = useSpyTeardown();

interface RuntimeFixture {
	root: TempDir;
	projectA: string;
	projectB: string;
	vaultA: SecretVault;
	vaultB: SecretVault;
	agentDir: string;
	settings: Settings;
	session: AgentSession;
}

async function createRuntimeFixture(extension?: ExtensionFactory): Promise<RuntimeFixture> {
	const root = TempDir.createSync("secret-runtime-lifecycle-");
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
	await vaultA.add({ name: "A_TOKEN", value: PROJECT_A_VALUE, scope: "project" });
	await vaultB.add({ name: "B_TOKEN", value: PROJECT_B_VALUE, scope: "project" });
	await Promise.all([
		fs.writeFile(path.join(projectA, ".veyyon", "secrets.yml"), `- type: plain\n  content: ${CONFIG_A_VALUE}\n`),
		fs.writeFile(path.join(projectB, ".veyyon", "secrets.yml"), `- type: plain\n  content: ${CONFIG_B_VALUE}\n`),
	]);
	const settings = Settings.isolated();
	settings.set("secrets.auditLog", true);
	const { session } = await createAgentSession({
		cwd: projectA,
		agentDir,
		sessionManager: SessionManager.inMemory(projectA),
		settings,
		modelRegistry,
		disableExtensionDiscovery: true,
		extensions: extension ? [extension] : [],
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
		skipPythonPreflight: true,
	});
	return { root, projectA, projectB, vaultA, vaultB, agentDir, settings, session };
}

/**
 * Store a secret and then make the vault file look like another process wrote it.
 *
 * A `SecretVault` built inside THIS process is deliberately no longer an external writer: the
 * revision fingerprint ignores changes this process made, so a session does not read its own
 * `/secret add` as tampering and refuse to spend the credential it just stored. These tests are
 * about the OTHER case, a vault mutated behind the session's back, so the write has to look like
 * one. Rewriting the file's own bytes in place does exactly that and leaves the content valid, so
 * the reload still finds the secret the add stored.
 *
 * Deliberately a real filesystem write rather than a stub over `revision()`: stubbing the
 * fingerprint would keep these tests passing even if the fingerprint stopped detecting anything.
 */
async function addSecretAndForgeAnExternalWrite(fixture: RuntimeFixture, projectDir: string): Promise<void> {
	await fixture.vaultA.add({ name: "LATE_TOKEN", value: ADDED_WHILE_OFF_VALUE, scope: "project" });
	const vaultPath = path.join(projectDir, ".veyyon", "vault.json");
	await fs.writeFile(vaultPath, await fs.readFile(vaultPath));
}

async function disposeFixture(fixture: RuntimeFixture): Promise<void> {
	await fixture.session.dispose();
	await fixture.root.remove();
}

describe("live secret runtime toggles", () => {
	/** Off-to-on is the boundary that used to require restarting the process. */
	it("loads configured entries immediately when protection is enabled", async () => {
		const fixture = await createRuntimeFixture();
		const previousEnv = process.env[ENV_NAME];
		try {
			expect(fixture.session.secretsEnabled).toBe(false);
			expect(fixture.session.obfuscator).toBeUndefined();
			process.env[ENV_NAME] = ENV_VALUE;

			fixture.settings.set("secrets.enabled", true);
			await fixture.session.refreshSecrets();

			expect(fixture.session.secretsEnabled).toBe(true);
			expect(fixture.session.obfuscator?.obfuscate(PROJECT_A_VALUE)).toBe("#A_TOKEN#");
			expect(fixture.session.obfuscator?.obfuscate(CONFIG_A_VALUE)).not.toBe(CONFIG_A_VALUE);
			expect(fixture.session.obfuscator?.obfuscate(ENV_VALUE)).not.toBe(ENV_VALUE);

			delete process.env[ENV_NAME];
			await fixture.session.refreshSecrets();
			expect(fixture.session.obfuscator?.obfuscate(ENV_VALUE)).not.toBe(ENV_VALUE);
		} finally {
			if (previousEnv === undefined) delete process.env[ENV_NAME];
			else process.env[ENV_NAME] = previousEnv;
			await disposeFixture(fixture);
		}
	});

	/** On-to-off must remove the active transform, including an enabled-but-empty runtime distinction. */
	it("disables expansion and redaction immediately when protection is turned off", async () => {
		const fixture = await createRuntimeFixture();
		try {
			fixture.settings.set("secrets.enabled", true);
			await fixture.session.refreshSecrets();
			expect(fixture.session.secretsEnabled).toBe(true);

			fixture.settings.set("secrets.enabled", false);
			await fixture.session.refreshSecrets();

			expect(fixture.session.secretsEnabled).toBe(false);
			expect(fixture.session.obfuscator).toBeUndefined();
		} finally {
			await disposeFixture(fixture);
		}
	});
	it("applies settings-selector changes to the authoritative runtime", async () => {
		const fixture = await createRuntimeFixture();
		try {
			const controller = new SelectorController({
				session: fixture.session,
				showError: (message: string) => {
					throw new Error(message);
				},
			} as never);
			const refresh = fixture.session.refreshSecrets.bind(fixture.session);
			const apply = async (enabled: boolean): Promise<void> => {
				const completed = Promise.withResolvers<void>();
				fixture.session.refreshSecrets = async options => {
					try {
						await refresh(options);
						completed.resolve();
					} catch (error) {
						completed.reject(error);
						throw error;
					}
				};
				fixture.settings.set("secrets.enabled", enabled);
				controller.handleSettingChange("secrets.enabled", enabled);
				await completed.promise;
			};

			await apply(true);
			expect(fixture.session.secretsEnabled).toBe(true);
			expect(fixture.session.obfuscator?.deobfuscate("#A_TOKEN#")).toBe(PROJECT_A_VALUE);

			await apply(false);
			expect(fixture.session.secretsEnabled).toBe(false);
			expect(fixture.session.obfuscator).toBeUndefined();
		} finally {
			await disposeFixture(fixture);
		}
	});
});

describe("runtime replacement", () => {
	/**
	 * Must revoke removed names and source-project expansion authority while retaining
	 * redaction-only tombstones for values that may still exist in transcript history.
	 * This drives a real session through encrypted vault writes and a project move, so
	 * cold hosted runners need more than Bun's five-second unit-test default.
	 */
	it("reconciles additions/removals and revokes source-project expansion authority on move", async () => {
		const fixture = await createRuntimeFixture();
		try {
			await fixture.vaultA.add({ name: "LATE_TOKEN", value: ADDED_WHILE_OFF_VALUE, scope: "project" });
			await fixture.session.refreshSecrets();
			expect(fixture.session.secretsEnabled).toBe(false);

			fixture.settings.set("secrets.enabled", true);
			await fixture.session.refreshSecrets();
			expect(fixture.session.obfuscator?.obfuscate(ADDED_WHILE_OFF_VALUE)).toBe("#LATE_TOKEN#");

			await fixture.vaultA.remove("LATE_TOKEN");
			await fixture.session.refreshSecrets();
			expect(fixture.session.obfuscator?.hasNamedSecret("LATE_TOKEN")).toBe(false);
			expect(fixture.session.obfuscator?.obfuscate(ADDED_WHILE_OFF_VALUE)).not.toBe(ADDED_WHILE_OFF_VALUE);

			await fixture.session.setCwd(fixture.projectB);
			expect(fixture.session.obfuscator?.hasNamedSecret("A_TOKEN")).toBe(false);
			expect(fixture.session.obfuscator?.obfuscate(PROJECT_A_VALUE)).not.toBe(PROJECT_A_VALUE);
			expect(fixture.session.obfuscator?.obfuscate(PROJECT_B_VALUE)).toBe("#B_TOKEN#");
			expect(fixture.session.obfuscator?.obfuscate(CONFIG_A_VALUE)).not.toBe(CONFIG_A_VALUE);
			expect(fixture.session.obfuscator?.obfuscate(CONFIG_B_VALUE)).not.toBe(CONFIG_B_VALUE);
		} finally {
			await disposeFixture(fixture);
		}
	}, 20_000);
	/**
	 * A vault revision check is the provider-admission fast path: unchanged
	 * revisions must keep the exact immutable authority, while one external
	 * mutation must atomically replace it before the next request is admitted.
	 */
	it("reuses an unchanged lease and refreshes exactly when the vault revision changes", async () => {
		const fixture = await createRuntimeFixture();
		try {
			fixture.settings.set("secrets.enabled", true);
			await fixture.session.refreshSecrets({ refreshPrompt: false });
			const initial = await fixture.session.leaseSecretRuntime();

			expect(await fixture.session.leaseSecretRuntime()).toBe(initial);
			await addSecretAndForgeAnExternalWrite(fixture, fixture.projectA);

			const refreshed = await fixture.session.leaseSecretRuntime();
			expect(refreshed).not.toBe(initial);
			expect(refreshed.revision).toBeGreaterThan(initial.revision);
			expect(refreshed.expansionObfuscator?.deobfuscate("#LATE_TOKEN#")).toBe(ADDED_WHILE_OFF_VALUE);
			expect(await fixture.session.leaseSecretRuntime()).toBe(refreshed);
		} finally {
			await disposeFixture(fixture);
		}
	});

	/**
	 * Provider admission must wait behind a refresh without exposing its candidate,
	 * and a completion carrying an older lease must not overwrite the committed
	 * authority after the refresh wins.
	 */
	it("keeps prior authority during refresh and rejects a stale lease completion", async () => {
		const fixture = await createRuntimeFixture();
		const originalLoad = SecretVault.prototype.load;
		const loadStarted = teardown.gate();
		const releaseLoad = teardown.gate();
		let blockNextLoad = true;
		const loadSpy = teardown.spy(SecretVault.prototype, "load").mockImplementation(async function (
			this: SecretVault,
		) {
			if (blockNextLoad) {
				blockNextLoad = false;
				loadStarted.open();
				await releaseLoad.reached;
			}
			return originalLoad.call(this);
		});
		try {
			const prior = await fixture.session.leaseSecretRuntime();
			expect(prior.expansionObfuscator).toBeUndefined();
			fixture.settings.set("secrets.enabled", true);

			const refresh = fixture.session.refreshSecrets({ refreshPrompt: false });
			await loadStarted.reached;
			expect(fixture.session.obfuscator).toBeUndefined();

			let admitted = false;
			const admission = fixture.session.leaseSecretRuntime().then(runtime => {
				admitted = true;
				return runtime;
			});
			await Promise.resolve();
			expect(admitted).toBe(false);

			releaseLoad.open();
			await refresh;
			const current = await admission;
			expect(current.revision).toBeGreaterThan(prior.revision);
			expect(current.expansionObfuscator?.deobfuscate("#A_TOKEN#")).toBe(PROJECT_A_VALUE);

			fixture.session.installSecretRuntime(prior);
			expect(await fixture.session.leaseSecretRuntime()).toBe(current);
			expect(fixture.session.obfuscator?.deobfuscate("#A_TOKEN#")).toBe(PROJECT_A_VALUE);
		} finally {
			loadSpy.mockRestore();
			releaseLoad.open();
			await disposeFixture(fixture);
		}
	});

	/**
	 * An already-admitted request may retain the source-project lease while a cwd
	 * move loads the destination. If that old vault changes, its freshness check
	 * must refuse expansion without superseding the destination refresh.
	 */
	it("does not let a stale source lease cancel an in-flight cwd refresh", async () => {
		const fixture = await createRuntimeFixture();
		try {
			fixture.settings.set("secrets.enabled", true);
			await fixture.session.refreshSecrets({ refreshPrompt: false });
			const sourceLease = await fixture.session.leaseSecretRuntime();
			await addSecretAndForgeAnExternalWrite(fixture, fixture.projectA);

			const originalLoad = SecretVault.prototype.load;
			const destinationLoadStarted = teardown.gate();
			const releaseDestinationLoad = teardown.gate();
			let blockNextLoad = true;
			const guardedLoadSpy = teardown.spy(SecretVault.prototype, "load").mockImplementation(async function (
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
				expect(() => sourceLease.assertFreshForExpansion()).toThrow(
					"Secret expansion was refused because the vault changed",
				);
				expect(guardedLoadSpy).toHaveBeenCalledTimes(1);

				releaseDestinationLoad.open();
				await moving;
				const destinationLease = await fixture.session.leaseSecretRuntime();
				expect(destinationLease.cwd).toBe(fixture.projectB);
				expect(destinationLease.expansionObfuscator?.deobfuscate("#B_TOKEN#")).toBe(PROJECT_B_VALUE);
				expect(guardedLoadSpy).toHaveBeenCalledTimes(1);
			} finally {
				guardedLoadSpy.mockRestore();
				releaseDestinationLoad.open();
			}
		} finally {
			await disposeFixture(fixture);
		}
	});

	it("revokes a mutated name if runtime reconciliation fails", async () => {
		const fixture = await createRuntimeFixture();
		try {
			fixture.settings.set("secrets.enabled", true);
			await fixture.session.refreshSecrets();
			await fs.writeFile(path.join(fixture.projectA, ".veyyon", "secrets.yml"), "not: an array\n");

			await expect(
				runSecretCommandForSurface("rm A_TOKEN", {
					session: fixture.session,
					sessionManager: fixture.session.sessionManager,
					settings: fixture.settings,
					cwd: fixture.projectA,
					globalConfigRoot: getConfigRoot(),
					agentDir: fixture.agentDir,
				}),
			).rejects.toThrow("must be a YAML array");

			expect((await fixture.vaultA.load()).some(entry => entry.name === "A_TOKEN")).toBe(false);
			expect(fixture.session.obfuscator?.hasNamedSecret("A_TOKEN")).toBe(false);
			expect(fixture.session.obfuscator?.deobfuscate("#A_TOKEN#")).toBe("#A_TOKEN#");
			expect(fixture.session.obfuscator?.obfuscate(PROJECT_A_VALUE)).not.toBe(PROJECT_A_VALUE);
		} finally {
			await disposeFixture(fixture);
		}
	});

	it("rolls a failed cwd re-scope back and permits a corrected retry", async () => {
		const fixture = await createRuntimeFixture();
		try {
			fixture.settings.set("secrets.enabled", true);
			await fixture.session.refreshSecrets();
			await fs.writeFile(path.join(fixture.projectB, ".veyyon", "secrets.yml"), "not: an array\n");

			await expect(fixture.session.setCwd(fixture.projectB)).rejects.toThrow("must be a YAML array");
			expect(fixture.session.sessionManager.getCwd()).toBe(fixture.projectA);
			expect(fixture.session.obfuscator?.deobfuscate("#A_TOKEN#")).toBe(PROJECT_A_VALUE);
			expect(fixture.session.obfuscator?.hasNamedSecret("B_TOKEN")).toBe(false);

			await fs.writeFile(
				path.join(fixture.projectB, ".veyyon", "secrets.yml"),
				`- type: plain\n  content: ${CONFIG_B_VALUE}\n`,
			);
			await fixture.session.setCwd(fixture.projectB);
			expect(fixture.session.sessionManager.getCwd()).toBe(fixture.projectB);
			expect(fixture.session.obfuscator?.hasNamedSecret("A_TOKEN")).toBe(false);
			expect(fixture.session.obfuscator?.deobfuscate("#B_TOKEN#")).toBe(PROJECT_B_VALUE);
		} finally {
			await disposeFixture(fixture);
		}
	});

	it("re-peeks a reusable reviver so a live A→B move survives the next revive", async () => {
		const fixture = await createRuntimeFixture();
		let revived: AgentSession | undefined;
		try {
			fixture.settings.set("secrets.enabled", true);
			await fixture.session.refreshSecrets();

			const childManager = SessionManager.create(
				fixture.projectA,
				path.resolve(fixture.root.path(), "persisted-child"),
			);
			childManager.appendSessionInit({
				systemPrompt: "Persisted child",
				task: "Check lifecycle scope",
				tools: ["yield"],
				spawns: "",
			});
			childManager.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: "ready" }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "fixture",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			} as never);
			await childManager.ensureOnDisk();
			await childManager.flush();
			const sessionFile = childManager.getSessionFile();
			expect(sessionFile).toBeString();
			await childManager.close();
			const persisted = await SessionManager.peekSessionInit(sessionFile!);
			expect(persisted?.init?.systemPrompt).toBe("Persisted child");
			expect(persisted?.cwd).toBe(fixture.projectA);
			expect((await fs.stat(persisted!.cwd)).isDirectory()).toBe(true);

			const factory = createPersistedSubagentReviverFactory({
				session: fixture.session,
				authStorage,
				modelRegistry,
				settings: fixture.settings,
				enableLsp: false,
			});
			const revive = await factory({
				id: "Lifecycle-Revived",
				displayName: "Lifecycle Revived",
				kind: "sub",
				parentId: "Main",
				status: "parked",
				session: null,
				sessionFile: sessionFile!,
				createdAt: Date.now(),
				lastActivity: Date.now(),
			});
			expect(revive).toBeFunction();
			await fixture.session.setCwd(fixture.projectB);
			expect(fixture.session.obfuscator?.hasNamedSecret("B_TOKEN")).toBe(true);
			expect(await fs.readFile(sessionFile!, "utf8")).toContain('"type":"session_init"');
			expect((await SessionManager.peekSessionInit(sessionFile!))?.init?.systemPrompt).toBe("Persisted child");

			revived = await revive!();

			expect(revived.sessionManager.getCwd()).toBe(fixture.projectA);
			expect(revived.obfuscator?.hasNamedSecret("A_TOKEN")).toBe(true);
			expect(revived.obfuscator?.hasNamedSecret("B_TOKEN")).toBe(false);
			expect(revived.obfuscator?.deobfuscate("#A_TOKEN#")).toBe(PROJECT_A_VALUE);

			// Same-cwd is the negative twin: an explicit no-op move must retain A
			// rather than deriving policy from the parent, which is already in B.
			await revived.setCwd(fixture.projectA);
			expect(revived.sessionManager.getCwd()).toBe(fixture.projectA);
			expect(revived.obfuscator?.hasNamedSecret("A_TOKEN")).toBe(true);

			// Move the live child independently. setCwd rewrites its own persisted
			// header; the parent's cwd and runtime remain B throughout.
			await revived.setCwd(fixture.projectB);
			expect(revived.sessionManager.getCwd()).toBe(fixture.projectB);
			expect(revived.obfuscator?.hasNamedSecret("A_TOKEN")).toBe(false);
			expect(revived.obfuscator?.hasNamedSecret("B_TOKEN")).toBe(true);
			await revived.dispose();
			revived = undefined;

			// Reuse the SAME closure. A factory-time A peek would regress this to A;
			// the invocation-time peek/open must restore the rewritten B header.
			revived = await revive!();
			expect(revived.sessionManager.getCwd()).toBe(fixture.projectB);
			expect(revived.obfuscator?.hasNamedSecret("A_TOKEN")).toBe(false);
			expect(revived.obfuscator?.deobfuscate("#B_TOKEN#")).toBe(PROJECT_B_VALUE);
		} finally {
			await revived?.dispose();
			await disposeFixture(fixture);
		}
	}, 20_000);
});

describe("the final mutable provider hook boundary", () => {
	/** A before-provider hook is untrusted to preserve an earlier transform; its replacement is sanitized again. */
	it("redacts a registered value injected by a before-provider hook from the exact outbound payload", async () => {
		const injectSecret: ExtensionFactory = api => {
			api.on("before_provider_request", event => ({
				...(event.payload as Record<string, unknown>),
				injected: PROJECT_A_VALUE,
			}));
		};
		const fixture = await createRuntimeFixture(injectSecret);
		try {
			fixture.settings.set("secrets.enabled", true);
			await fixture.session.refreshSecrets();
			const options = await fixture.session.prepareSimpleStreamOptions({ apiKey: "unused" });
			const outbound = await options.onPayload?.({ kind: "request" });

			expect(outbound).toEqual({ kind: "request", injected: "#A_TOKEN#" });
			expect(JSON.stringify(outbound)).not.toContain(PROJECT_A_VALUE);
		} finally {
			await disposeFixture(fixture);
		}
	});
});
