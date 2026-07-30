/**
 * A session must start when its vault cannot be read, because the repair is a command inside it.
 *
 * WHY THIS EXISTS, and why it is a separate file from the command-level suite. The sibling
 * `a-broken-vault-is-repairable-without-a-tui.test.ts` drives `runSecretCommand` directly, which is
 * the layer that renders the diagnosis and performs the discard. Every row in it passed while the
 * product was still unusable, because the failure was one level up: `loadSecretRuntime` in `sdk.ts`
 * called `vault.load()` while assembling the session, the throw escaped, and the session never
 * existed. Nothing could be dispatched into it. The full-screen interface happened to survive on a
 * different path, so the bug read as "headless only" and a command-level suite could not see it.
 *
 * That is the shape worth remembering: the command was correct, reachable in tests, and unreachable
 * in production. This file asserts the reachability, so a future refactor that moves the vault read
 * back into the startup path fails here rather than in an operator's terminal.
 *
 * WHAT IS ASSERTED. A real SDK session over a project whose vault file is unreadable resolves; the
 * operator is told, by a notice that names the path and the repair; and the notice does not leak the
 * credential. The break is a truncated file rather than a deleted key, deliberately: the key lives
 * in the file-level isolated config root shared with the rest of this file, and truncation produces
 * the same hard failure class without reaching for it.
 *
 * THE OTHER SIDE OF THIS BOUNDARY IS NOT HERE, and the first version of the fix got it wrong. One
 * loader serves both session startup and the mid-session reload the expansion lease runs before it
 * expands a live `#NAME#`. Absorbing the failure for every caller made that reload succeed with an
 * empty runtime, turning a fail-closed refusal into an expansion against a vault nobody could read.
 * The loader now takes an explicit `onUnreadableVault`, and only startup passes "degrade". The
 * reload direction is owned by `stalevaultneverrefuses-the-expansion-lease-reloads-before-it-
 * refuses.test.ts`, which is what went red; do not restate it here, and do not widen the catch
 * without running that file.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { createAgentSession } from "@veyyon/coding-agent/sdk";
import { resolveVaultLocations, SecretVault, vaultPathFor } from "@veyyon/coding-agent/secrets/vault";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import { OperatorNotices } from "@veyyon/coding-agent/session/operator-notices";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { TempDir } from "@veyyon/utils";
import { useIsolatedConfigRoot } from "../helpers/isolated-agent-dir";

// Redirects the config root, so the vault key and any global vault stay out of the real ~/.veyyon.
const configRoot = useIsolatedConfigRoot();

const VALUE = "ghp_a_real_looking_project_credential";

let registryRoot: TempDir;
let authStorage: AuthStorage;
let modelRegistry: ModelRegistry;

beforeAll(async () => {
	registryRoot = TempDir.createSync("vault-startup-registry-");
	authStorage = await AuthStorage.create(registryRoot.join("auth.db"));
	modelRegistry = new ModelRegistry(authStorage, registryRoot.join("models.yml"));
});

afterAll(async () => {
	authStorage.close();
	await registryRoot.remove();
});

describe("an SDK session over a project whose vault cannot be read", () => {
	it("starts anyway, and says which file to repair", async () => {
		const root = TempDir.createSync("vault-startup-");
		try {
			const project = path.resolve(root.join("project"));
			const agentDir = path.resolve(root.join("agent"));
			await fs.mkdir(project, { recursive: true });

			// Seal a real project secret, then truncate the file it went into.
			const locations = resolveVaultLocations({ globalConfigRoot: configRoot(), agentDir, cwd: project });
			const vault = new SecretVault(locations);
			await vault.add({ name: "PROJECT_TOKEN", value: VALUE, scope: "project", ttl: null });
			const vaultFile = vaultPathFor(locations, "project");
			const sealed = await Bun.file(vaultFile).text();
			await Bun.write(vaultFile, sealed.slice(0, Math.floor(sealed.length / 2)));
			// The precondition the whole suite rests on: this vault really is unreadable.
			await expect(new SecretVault(locations).load()).rejects.toThrow();

			const notices = new OperatorNotices();
			// Before the fix this call threw, and there was no session to run `/secret discard` in.
			const { session } = await createAgentSession({
				cwd: project,
				agentDir,
				sessionManager: SessionManager.inMemory(project),
				operatorNotices: notices,
				// WITHOUT this the row is VACUOUS. `secrets.enabled` is off by default, the secret
				// runtime is never built, and no vault is ever read, so the session starts for a reason
				// that has nothing to do with the fix. It passed that way once; hence this comment.
				settings: Settings.isolated({ "secrets.enabled": true }),
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
				const reported = notices.all().filter(notice => notice.text.includes(vaultFile));

				expect(reported).toHaveLength(1);
				const text = reported[0]?.text ?? "";
				// Names the scope, the file, and the repair.
				expect(text).toContain("project");
				expect(text).toContain("/secret discard --scope project");
				// MOVES rather than deletes: the file still holds a real credential under a live key.
				expect(text).toContain("aside");
				// Says the repair is reachable here, which is the whole point of starting degraded.
				expect(text).toContain("not only in the full-screen interface");
				// A degraded start must not silently behave like a working one.
				expect(text).toContain("refused rather than sent as literal text");
				// ... and must not leak what it failed to read.
				expect(text).not.toContain(VALUE);
			} finally {
				await session.dispose();
			}
		} finally {
			await root.remove();
		}
	});

	/**
	 * The other half of the contract. Starting despite the failure must not mean starting as though
	 * the scope were empty: an unreadable scope's placeholders have to refuse rather than expand to
	 * nothing, which is what "treated as empty" would silently do to a prompt already in flight.
	 */
	it("does not treat the unreadable scope as an empty one", async () => {
		const root = TempDir.createSync("vault-startup-empty-");
		try {
			const project = path.resolve(root.join("project"));
			const agentDir = path.resolve(root.join("agent"));
			await fs.mkdir(project, { recursive: true });
			const locations = resolveVaultLocations({ globalConfigRoot: configRoot(), agentDir, cwd: project });
			const vault = new SecretVault(locations);
			await vault.add({ name: "PROJECT_TOKEN", value: VALUE, scope: "project", ttl: null });
			const vaultFile = vaultPathFor(locations, "project");
			const sealed = await Bun.file(vaultFile).text();
			await Bun.write(vaultFile, sealed.slice(0, Math.floor(sealed.length / 2)));

			const probe = new SecretVault(locations);
			await expect(probe.load()).rejects.toThrow();
			const marked = await probe.noteFailedLoad(new Error("unreadable"));

			// Marked unreadable, which is what the spend seam and the list both key off.
			expect(marked).toContain("project");
			expect(probe.unreadableScopes()).toContain("project");
			// A scope with no file on disk is not marked, because there is nothing to discard.
			expect(marked).not.toContain("global");
		} finally {
			await root.remove();
		}
	});
});
