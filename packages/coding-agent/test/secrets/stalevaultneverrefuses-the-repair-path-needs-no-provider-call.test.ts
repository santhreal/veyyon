/**
 * The `/secret` repair path completes with a vault scope unreadable, and never calls the provider.
 *
 * WHY THIS EXISTS AS ITS OWN SUITE. It is the load-bearing precondition for the planned egress gate:
 * while any vault scope is unreadable, that scope's secrets are absent from the obfuscator, so a
 * pasted credential gets no substitution and would reach the provider in plaintext. The corrupt
 * bytes are unrecoverable, so the only lever is refusing to proceed, and the reason refusing PROVIDER
 * CALLS is acceptable rather than a lockout is that the repair needs no provider call. That claim is
 * the whole justification, so it is measured here instead of assumed.
 *
 * If this suite ever fails, the egress gate as designed would lock the operator out of the repair for
 * their own vault: refusing provider calls would refuse the only way to fix the thing being refused.
 * A failure here is a signal to narrow the gate or add an acknowledgement step, NOT to relax this
 * test. The proof is a model whose handler throws and counts: if `/secret` needs a turn, the count is
 * non-zero and the throw surfaces.
 *
 * THE OTHER HALF. `/secret list` has to work while the scope is unreadable too. The operator cannot
 * repair what they cannot inspect, and the notice tells them to move or delete a specific file, so
 * the command that names what is stored must survive the state that makes it necessary.
 *
 * NO VALUE IS EVER ASSERTED ON. Stored-ness is checked by name, never by comparing a credential.
 */
import { describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { unregisterCustomApis } from "@veyyon/ai/api-registry";
import { createMockModel, registerMockApi } from "@veyyon/ai/providers/mock";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { createAgentSession } from "@veyyon/coding-agent/sdk";
import * as obfuscatorModule from "@veyyon/coding-agent/secrets/obfuscator";
import { resolveVaultLocations, SecretVault, vaultPathFor } from "@veyyon/coding-agent/secrets/vault";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { runSecretCommandForSurface } from "@veyyon/coding-agent/slash-commands/helpers/secret";
import { TempDir } from "@veyyon/utils";
import { makeScopeUnreadable } from "./stalevaultneverrefuses-corrupt-vault-fixture";

const MOCK_API_SOURCE = "repair-path-needs-no-provider";

const SEEDED_NAME = "REPAIR_LANE_SEEDED";
const SEEDED_VALUE = "ghp_repairlaneseededcredential0001";
const REPAIRED_NAME = "REPAIR_LANE_REPAIRED";
const REPAIRED_VALUE = "ghp_repairlanerepairedcredential02";
const REPAIRED_ENV_VAR = "REPAIR_LANE_SOURCE_VAR";

// The corruption comes from the shared fixture: raw invalid JSON now refuses at startup, which is
// the security suite's contract, so this must not borrow that input.

interface Harness {
	/** Run one `/secret` invocation exactly as the TUI surface would. */
	secret: (args: string) => Promise<string>;
	/** How many times the model was asked for a turn. Must stay zero. */
	modelCalls: () => number;
	/**
	 * How many times the OUTBOUND provider redaction seam was traversed. Must stay zero.
	 *
	 * `transformProviderContext` in `sdk.ts` delegates to `obfuscateProviderContext`, and it is the
	 * seam the egress gate will refuse at. Counting it here answers the placement question BEFORE
	 * the gate exists: if slash-command dispatch traversed it, a gate there would swallow the very
	 * repair command that clears the refusal.
	 */
	providerRedactions: () => number;
	/** Drive a genuine provider turn, used only to prove the seam counter can reach one. */
	prompt: (text: string) => Promise<void>;
	locations: ReturnType<typeof resolveVaultLocations>;
	dispose: () => Promise<void>;
}

/**
 * A live session whose profile vault scope is corrupt, and whose model throws if it is ever asked
 * for a turn. `promptForValue` is absent, which selects the noninteractive surface, so the only
 * accepted way to supply a value is `from-env`: the form that never puts a credential in argv.
 */
async function harness(): Promise<Harness> {
	const tempDir = TempDir.createSync("veyyon-repair-path-lane-");
	const globalConfigRoot = tempDir.join("global");
	const agentDir = tempDir.join("profile");
	const cwd = tempDir.join("project");
	for (const dir of [globalConfigRoot, agentDir, cwd]) fs.mkdirSync(dir, { recursive: true });

	const locations = resolveVaultLocations({ globalConfigRoot, agentDir, cwd });
	const vault = new SecretVault(locations);
	await vault.add({ name: SEEDED_NAME, value: SEEDED_VALUE, scope: "global", ttl: null });
	// A real write first, so the corrupt file is genuinely a vault path that no longer parses.
	await vault.add({
		name: "REPAIR_LANE_DOOMED",
		value: "ghp_repairlanedoomedcredential003",
		scope: "profile",
		ttl: null,
	});
	await makeScopeUnreadable(locations, "profile");

	const authStorage = await AuthStorage.create(path.join(agentDir, "auth.db"));
	authStorage.setRuntimeApiKey("mock", "mock-key");
	registerMockApi(MOCK_API_SOURCE);
	let modelCalls = 0;
	// Installed BEFORE the session, so a redaction during construction would be counted too.
	const realObfuscateProviderContext = obfuscatorModule.obfuscateProviderContext;
	let providerRedactions = 0;
	const redactionSpy = spyOn(obfuscatorModule, "obfuscateProviderContext").mockImplementation(
		(obfuscator, context) => {
			providerRedactions += 1;
			return realObfuscateProviderContext(obfuscator, context);
		},
	);
	const settings = Settings.isolated({
		"secrets.enabled": true,
		"secrets.auditLog": false,
		"compaction.enabled": false,
	});
	const sessionManager = SessionManager.inMemory(cwd);
	const { session } = await createAgentSession({
		cwd,
		agentDir,
		globalConfigRoot,
		authStorage,
		modelRegistry: new ModelRegistry(authStorage, path.join(agentDir, "models.yml")),
		sessionManager,
		settings,
		model: createMockModel({
			responses: [],
			handler: () => {
				modelCalls += 1;
				throw new Error("The repair path asked for a model turn, which it must never need.");
			},
		}),
		disableExtensionDiscovery: true,
		extensions: [],
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
		skipPythonPreflight: true,
		rules: [],
		workspaceTree: { rootPath: cwd, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
	});

	return {
		locations,
		modelCalls: () => modelCalls,
		providerRedactions: () => providerRedactions,
		// Braced deliberately: `session.prompt` resolves to a boolean, and returning it through a
		// concise arrow would widen this harness handle's contract from "run a turn" to "report
		// something about the turn", which no row here reads.
		prompt: async text => {
			await session.prompt(text);
		},
		secret: async args => {
			const outcome = await runSecretCommandForSurface(args, {
				session,
				sessionManager,
				settings,
				cwd,
				globalConfigRoot,
				agentDir,
			});
			return outcome.message;
		},
		dispose: async () => {
			await session.dispose();
			redactionSpy.mockRestore();
			unregisterCustomApis(MOCK_API_SOURCE);
			authStorage.close();
			tempDir.removeSync();
			delete process.env[REPAIRED_ENV_VAR];
		},
	};
}

describe("the /secret repair path while a vault scope cannot be read", () => {
	it("lists what is stored, so the operator can see what they are repairing", async () => {
		const h = await harness();
		try {
			const message = await h.secret("list");

			// The surviving scope's entry must still be named. An operator who cannot inspect the
			// vault cannot act on a notice telling them which file to move.
			expect(message).toContain(SEEDED_NAME);
			expect(h.modelCalls()).toBe(0);
		} finally {
			await h.dispose();
		}
	});

	it("stores a replacement after the unreadable file is removed, with no model turn", async () => {
		const h = await harness();
		try {
			// Exactly the repair the notice prescribes: move or delete that one file, then re-add.
			fs.rmSync(vaultPathFor(h.locations, "profile"));
			process.env[REPAIRED_ENV_VAR] = REPAIRED_VALUE;

			const message = await h.secret(`from-env ${REPAIRED_ENV_VAR} ${REPAIRED_NAME}`);

			expect(message).toContain(REPAIRED_NAME);
			// Read back through a fresh vault: the repair has to survive the process, not just report.
			const reloaded = await new SecretVault(h.locations).load();
			expect(reloaded.map(entry => entry.name).sort()).toEqual([REPAIRED_NAME, SEEDED_NAME].sort());
			expect(h.modelCalls()).toBe(0);
		} finally {
			await h.dispose();
		}
	});

	it("accepts the repair even while the file is still corrupt, without a model turn", async () => {
		const h = await harness();
		try {
			process.env[REPAIRED_ENV_VAR] = REPAIRED_VALUE;

			// The global scope is readable, so storing there must work even before the profile file is
			// dealt with. This is what makes the planned egress gate survivable: the operator is never
			// required to fix the vault before they are allowed to touch the vault.
			const message = await h.secret(`from-env ${REPAIRED_ENV_VAR} ${REPAIRED_NAME} global`);

			expect(message).toContain(REPAIRED_NAME);
			expect(h.modelCalls()).toBe(0);
		} finally {
			await h.dispose();
		}
	});

	it("refuses an inline credential on this surface instead of storing it", async () => {
		const h = await harness();
		try {
			// The noninteractive surface cannot mask, so it must not accept a value in argv where it
			// would persist in command history. Adversarial row: the repair path staying provider-free
			// must not come at the cost of the rule that keeps values out of the scrollback.
			await expect(h.secret(`add ${REPAIRED_NAME} hunter2_inline_credential_value`)).rejects.toThrow(
				/\/secret from-env/,
			);
			expect(h.modelCalls()).toBe(0);
		} finally {
			await h.dispose();
		}
	});

	it("never traverses the outbound provider redaction seam, so a gate there cannot eat the repair", async () => {
		const h = await harness();
		try {
			process.env[REPAIRED_ENV_VAR] = REPAIRED_VALUE;
			await h.secret("list");
			await h.secret(`from-env ${REPAIRED_ENV_VAR} ${REPAIRED_NAME} global`);

			// THE PLACEMENT PROOF. The egress gate refuses at the outbound provider seam, which is
			// `transformProviderContext` in `sdk.ts` delegating to `obfuscateProviderContext`. If a
			// slash command traversed that seam, a gate there would refuse the repair command that
			// clears the refusal: a lockout with a friendlier message, and the deadlock the
			// non-throwing boot exists to avoid, reintroduced one layer up. Zero here is what makes
			// the placement safe, and it is measured rather than read off the dispatch path.
			expect(h.providerRedactions()).toBe(0);
			expect(h.modelCalls()).toBe(0);
		} finally {
			await h.dispose();
		}
	});

	it("counts the outbound seam when a real turn runs, so the zero above is falsifiable", async () => {
		const h = await harness();
		try {
			// THE INSTRUMENT'S OWN CONTROL. The row above proves a negative by counting, which is
			// worthless if the counter cannot reach one. A prompt is a genuine provider path, so it
			// MUST traverse the seam. The session absorbs the model's failure into an error event
			// rather than rejecting, which is why this awaits the turn and asserts on the counters
			// rather than on a throw. If either reports zero, the spy has come unwired and the
			// placement proof above is vacuous rather than passing.
			await h.prompt("say hi");

			expect(h.providerRedactions()).toBeGreaterThan(0);
			expect(h.modelCalls()).toBeGreaterThan(0);
		} finally {
			await h.dispose();
		}
	});
});
