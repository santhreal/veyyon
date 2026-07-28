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
import { createAgentSession, type ExtensionFactory } from "@veyyon/coding-agent/sdk";
import { SecretVault } from "@veyyon/coding-agent/secrets/vault";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { TempDir } from "@veyyon/utils";
import { useIsolatedConfigRoot } from "../helpers/isolated-agent-dir";

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

interface RuntimeFixture {
	root: TempDir;
	projectA: string;
	projectB: string;
	vaultA: SecretVault;
	vaultB: SecretVault;
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
	return { root, projectA, projectB, vaultA, vaultB, settings, session };
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
});

describe("runtime replacement", () => {
	/**
	 * A vault can change while the feature is off. Enabling must load additions, later refreshes
	 * must drop removed names, and `/move` must replace rather than append project mappings.
	 */
	it("reconciles additions/removals and eliminates source-project mappings on move", async () => {
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
			expect(fixture.session.obfuscator?.obfuscate(PROJECT_A_VALUE)).toBe(PROJECT_A_VALUE);
			expect(fixture.session.obfuscator?.obfuscate(PROJECT_B_VALUE)).toBe("#B_TOKEN#");
			expect(fixture.session.obfuscator?.obfuscate(CONFIG_A_VALUE)).toBe(CONFIG_A_VALUE);
			expect(fixture.session.obfuscator?.obfuscate(CONFIG_B_VALUE)).not.toBe(CONFIG_B_VALUE);
		} finally {
			await disposeFixture(fixture);
		}
	});
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
			const options = fixture.session.prepareSimpleStreamOptions({ apiKey: "unused" });
			const outbound = await options.onPayload?.({ kind: "request" });

			expect(outbound).toEqual({ kind: "request", injected: "#A_TOKEN#" });
			expect(JSON.stringify(outbound)).not.toContain(PROJECT_A_VALUE);
		} finally {
			await disposeFixture(fixture);
		}
	});
});
