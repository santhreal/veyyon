/**
 * Turning secret expansion off must never turn redaction off with it.
 *
 * THE DESIGN. A session holds two obfuscators, not one. `expansionObfuscator` turns a `#NAME#`
 * placeholder back into a credential and is revoked the moment expansion should stop: a
 * `secrets.enabled = false`, a `/secret rm`, a `/move` to a project whose vault does not hold the
 * value. `redactionObfuscator` outlives it on purpose, because the transcript still contains
 * whatever the model was shown, and a value the model saw as a placeholder must never travel back
 * out as plaintext just because expansion was switched off afterwards. `refreshSecretRuntime`
 * encodes this as `nextRedactor = next.obfuscator ?? redactionObfuscator`, and
 * `retainRedactionsFrom` carries the tombstones across every refresh, move, and disable.
 *
 * THE BUG. `AgentSession` set `#obfuscator = runtime.expansionObfuscator`, so `#obfuscator` is the
 * EXPANSION authority and is undefined exactly when expansion stops. Thirteen outbound seams read
 * it anyway, in the shape `this.#obfuscator?.obfuscate(text) ?? text` or
 * `obfuscateProviderContext(this.#obfuscator, ctx)`: the side-stream context, the handoff context,
 * compaction prompts and their summaries, message conversion for side requests, the MCP custom-tool
 * context, session-title generation, the legacy archive migration. Every one of them sent plaintext
 * once expansion ended, which is the precise leak the tombstone exists to prevent. One seam
 * (`canonicalizeProviderContext`) had it right and preferred the runtime lease, which is what made
 * the other twelve identifiable as copies of the wrong thing rather than a deliberate policy.
 *
 * The advisor was worse than stale-on-disable: it captured `obfuscator: this.#obfuscator` once at
 * construction, so a session that started with secrets off never redacted an advisor delta at all,
 * however many secrets were added afterwards.
 *
 * WHAT IS ASSERTED. The first half is behavior: after a disable and after a move, expansion is gone
 * and every redaction closure on the lease still hides the value. The second half locks the
 * unification at the source level, because most of the twelve seams are private and reachable only
 * through a live provider request. A structural assertion is what keeps a fourteenth copy of the
 * wrong expression from appearing next to the twelve that were removed.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { createAgentSession, type ExtensionFactory } from "@veyyon/coding-agent/sdk";
import { SecretVault } from "@veyyon/coding-agent/secrets/vault";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { TempDir } from "@veyyon/utils";
import { useIsolatedConfigRoot } from "../helpers/isolated-agent-dir";

const A_VALUE = "redaction-outlives-project-a-value-13579";
const B_VALUE = "redaction-outlives-project-b-value-97531";
const AGENT_SESSION_SOURCE = path.resolve(import.meta.dir, "../../src/session/agent-session.ts");
const getConfigRoot = useIsolatedConfigRoot();

let registryRoot: TempDir;
let authStorage: AuthStorage;
let modelRegistry: ModelRegistry;

beforeAll(async () => {
	registryRoot = TempDir.createSync("redaction-outlives-registry-");
	authStorage = await AuthStorage.create(registryRoot.join("auth.db"));
	modelRegistry = new ModelRegistry(authStorage, registryRoot.join("models.yml"));
});

afterAll(async () => {
	authStorage.close();
	await registryRoot.remove();
});

interface Fixture {
	root: TempDir;
	projectA: string;
	projectB: string;
	vaultA: SecretVault;
	settings: Settings;
	session: AgentSession;
}

async function createFixture(extension?: ExtensionFactory): Promise<Fixture> {
	const root = TempDir.createSync("redaction-outlives-");
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
	await vaultA.add({ name: "A_TOKEN", value: A_VALUE, scope: "project" });
	await vaultB.add({ name: "B_TOKEN", value: B_VALUE, scope: "project" });
	const settings = Settings.isolated();
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
	return { root, projectA, projectB, vaultA, settings, session };
}

async function dispose(fixture: Fixture): Promise<void> {
	await fixture.session.dispose();
	await fixture.root.remove();
}

describe("a lease whose expansion authority has been revoked", () => {
	/**
	 * The disable case, which is the one an operator triggers by hand.
	 *
	 * Every closure on the lease is checked rather than only `obfuscateText`, because the twelve
	 * broken seams were split across all four of them: text for prompts and titles, messages for
	 * side-request conversion, context for side streams and handoffs, payload for the final hook.
	 */
	it("keeps redacting through every closure after secrets.enabled goes false", async () => {
		const fixture = await createFixture();
		try {
			fixture.settings.set("secrets.enabled", true);
			await fixture.session.refreshSecrets();
			expect(fixture.session.obfuscator?.obfuscate(A_VALUE)).toBe("#A_TOKEN#");

			fixture.settings.set("secrets.enabled", false);
			await fixture.session.refreshSecrets();
			const lease = await fixture.session.leaseSecretRuntime();

			expect(lease.expansionObfuscator).toBeUndefined();
			expect(fixture.session.secretsEnabled).toBe(false);
			expect(lease.hasRedactions).toBe(true);
			expect(lease.redactionObfuscator?.obfuscate(A_VALUE)).not.toBe(A_VALUE);
			expect(lease.obfuscateText(`token=${A_VALUE}`)).not.toContain(A_VALUE);
			expect(JSON.stringify(lease.obfuscatePayload({ token: A_VALUE }))).not.toContain(A_VALUE);
			expect(
				JSON.stringify(lease.obfuscateMessages([{ role: "user", content: `token=${A_VALUE}`, timestamp: 1 }])),
			).not.toContain(A_VALUE);
			expect(fixture.session.obfuscateProviderText(`token=${A_VALUE}`)).not.toContain(A_VALUE);
		} finally {
			await dispose(fixture);
		}
	});

	/** Expansion really is gone, so this is a revocation and not a no-op that trivially passes. */
	it("no longer expands the placeholder it still redacts", async () => {
		const fixture = await createFixture();
		try {
			fixture.settings.set("secrets.enabled", true);
			await fixture.session.refreshSecrets();
			expect(fixture.session.obfuscator?.deobfuscate("#A_TOKEN#")).toBe(A_VALUE);

			fixture.settings.set("secrets.enabled", false);
			await fixture.session.refreshSecrets();
			const lease = await fixture.session.leaseSecretRuntime();

			expect(lease.expansionObfuscator?.deobfuscate("#A_TOKEN#")).toBeUndefined();
			expect(lease.obfuscateText(A_VALUE)).not.toBe(A_VALUE);
		} finally {
			await dispose(fixture);
		}
	});

	/**
	 * The move case, where the destination has its own vault.
	 *
	 * A cwd move replaces expansion authority wholesale, so the leaving project's value is exactly
	 * the kind that is still in the transcript with no live entry behind it.
	 */
	it("keeps redacting the source project's value after moving to another project", async () => {
		const fixture = await createFixture();
		try {
			fixture.settings.set("secrets.enabled", true);
			await fixture.session.refreshSecrets();
			await fixture.session.setCwd(fixture.projectB);
			const lease = await fixture.session.leaseSecretRuntime();

			expect(lease.cwd).toBe(fixture.projectB);
			expect(lease.expansionObfuscator?.hasNamedSecret("A_TOKEN")).toBe(false);
			expect(lease.obfuscateText(`token=${A_VALUE}`)).not.toContain(A_VALUE);
			expect(lease.obfuscateText(`token=${B_VALUE}`)).toBe("token=#B_TOKEN#");
			expect(fixture.session.obfuscateProviderText(A_VALUE)).not.toBe(A_VALUE);
		} finally {
			await dispose(fixture);
		}
	});

	/**
	 * A secret added mid-session must reach the seams too.
	 *
	 * This is the other direction of the same staleness, and the one the advisor got wrong by
	 * snapshotting the obfuscator at construction: a session that starts with nothing configured
	 * has an undefined authority, and a consumer that captures it once never redacts anything.
	 */
	it("picks up a value added after the session started", async () => {
		const fixture = await createFixture();
		try {
			expect(fixture.session.secretsEnabled).toBe(false);
			fixture.settings.set("secrets.enabled", true);
			await fixture.vaultA.add({ name: "LATE_TOKEN", value: "added-after-start-value-24680", scope: "project" });
			await fixture.session.refreshSecrets();

			const lease = await fixture.session.leaseSecretRuntime();
			expect(lease.obfuscateText("added-after-start-value-24680")).toBe("#LATE_TOKEN#");
			expect(fixture.session.obfuscateProviderText("added-after-start-value-24680")).toBe("#LATE_TOKEN#");
		} finally {
			await dispose(fixture);
		}
	});

	/**
	 * The exact outbound bytes, through the hook that runs last.
	 *
	 * `before_provider_request` is the final chance to put a credential back into a payload, and it
	 * has to be sanitized again on a runtime whose expansion is already revoked.
	 */
	it("redacts a value a provider hook injects after expansion was revoked", async () => {
		const inject: ExtensionFactory = api => {
			api.on("before_provider_request", event => ({
				...(event.payload as Record<string, unknown>),
				injected: A_VALUE,
			}));
		};
		const fixture = await createFixture(inject);
		try {
			fixture.settings.set("secrets.enabled", true);
			await fixture.session.refreshSecrets();
			fixture.settings.set("secrets.enabled", false);
			await fixture.session.refreshSecrets();

			const options = await fixture.session.prepareSimpleStreamOptions({ apiKey: "unused" });
			const outbound = await options.onPayload?.({ kind: "request" });

			expect(JSON.stringify(outbound)).not.toContain(A_VALUE);
			expect(outbound).toEqual({ kind: "request", injected: "#A_TOKEN#" });
		} finally {
			await dispose(fixture);
		}
	});
});

describe("no outbound seam reads the expansion authority", () => {
	/**
	 * The structural lock, which is what a ONE PLACE fix needs to stay fixed.
	 *
	 * Most of the twelve seams are private and run only inside a live provider request, so a
	 * behavioral test cannot reach them without standing up a provider per seam. What can be pinned
	 * exactly is that the wrong expression is gone: `#obfuscator` is the expansion authority, so any
	 * REDACTION-direction use of it is the bug. Deobfuscation is the opposite direction and is
	 * supposed to read `#obfuscator`, so the patterns below name only outbound shapes.
	 */
	const source = (): Promise<string> => fs.readFile(AGENT_SESSION_SOURCE, "utf8");

	/** Every line that redacts through `#obfuscator`, trimmed, so a failure prints lines not a file. */
	async function outboundExpansionAuthorityLines(): Promise<string[]> {
		const patterns = [
			"this.#obfuscator?.obfuscate(",
			"obfuscateProviderContext(this.#obfuscator",
			"obfuscateMessages(this.#obfuscator",
			"obfuscator: this.#obfuscator,",
		];
		return (await source())
			.split("\n")
			.map(line => line.trim())
			.filter(line => patterns.some(pattern => line.includes(pattern)));
	}

	/**
	 * An exact allowlist rather than plain absence, because the owners contain the fallback.
	 *
	 * Each owner ends in `... : <the raw obfuscator>` for the case where no runtime lease has been
	 * installed at all, which is a session constructed without secret support rather than one whose
	 * expansion was revoked. Those four lines are the whole legitimate population. Anything else
	 * matching is a thirteenth seam reading the expansion authority to redact, which is the bug.
	 */
	it("reads the expansion authority only inside the four owner fallbacks", async () => {
		expect(await outboundExpansionAuthorityLines()).toEqual([
			": obfuscateProviderContext(this.#obfuscator, next);",
			"return this.#secretRuntime?.obfuscateText(text) ?? this.#obfuscator?.obfuscate(text) ?? text;",
			"return runtime ? runtime.obfuscateContext(context) : obfuscateProviderContext(this.#obfuscator, context);",
			"return this.#obfuscator ? obfuscateMessages(this.#obfuscator, messages) : messages;",
		]);
	});

	/** The advisor must never hold a snapshot again; it is the one consumer that outlives every refresh. */
	it("hands the advisor no snapshot of the obfuscator", async () => {
		const lines = await outboundExpansionAuthorityLines();
		expect(lines.filter(line => line.includes("obfuscator: this.#obfuscator,"))).toEqual([]);
	});

	/**
	 * The owners have to exist, or the assertions above pass by deleting redaction outright.
	 *
	 * This is the half that makes the absence meaningful: the outbound helpers are named, present,
	 * and read the runtime lease first.
	 */
	it("routes outbound redaction through the named owners", async () => {
		const text = await source();
		expect(text).toContain("#hasProviderRedactions");
		expect(text).toContain("#obfuscateContextForProvider");
		expect(text).toContain("#obfuscateMessagesForProvider");
		// PUBLIC, not `#private`: `/share`, the speech enhancer and the auto-title generator all need
		// to hold the live redactor, and every one of them was reaching for `session.obfuscator`
		// (the expansion authority) because there was nothing public to reach for instead.
		expect(text).toContain("get providerRedactor(): SecretObfuscator | undefined {");
		expect(text).toContain("return this.#secretRuntime?.redactionObfuscator ?? this.#obfuscator;");
	});

	/** Expansion still reads the expansion authority, so the fix did not blur the two directions. */
	it("still reads the expansion authority when expanding", async () => {
		const text = await source();
		expect(text).toContain("this.#obfuscator.deobfuscate(");
		expect(text).toContain("deobfuscateAssistantContent(this.#obfuscator");
	});
});
