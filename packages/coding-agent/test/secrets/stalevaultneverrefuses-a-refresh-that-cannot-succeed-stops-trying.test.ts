/**
 * TERMINATION of the stale-vault refresh guard. Locks out two OPPOSITE bugs reachable from the same
 * input, neither of which the "refresh and continue" fix distinguishes on its own.
 *
 * The guard's job is to treat a stale vault revision as a cache miss: reload, then proceed. That is
 * right when the vault changed because a peer wrote it a moment ago. It says nothing about a change
 * the reload can never reconcile, a vault file deleted or genuinely unreadable, where the reload
 * runs and STILL does not produce a runtime that can resolve the text. Two ways to get that wrong:
 *
 *   1. RETRY WITHOUT LIMIT. Keep reloading until the revision settles. It never settles, so the
 *      await never returns. `ensureFreshForExpansion` is awaited on a RENDER path
 *      (`#awaitSecretExpansionRefreshForRender`), which makes an unbounded retry a hung TUI: the
 *      exact failure this whole effort exists to remove, reintroduced by the fix for it.
 *   2. SETTLE INTO STALE. Decide the reload is hopeless and keep using the obfuscator loaded before
 *      the change, forever. That is a silent fail-open, and it arrives LATE: every test proving the
 *      refresh correct still passes, because the refresh does happen, once, and then stops mattering.
 *
 * The correct third answer is bounded: attempt the reload EXACTLY ONCE per call, adopt whatever it
 * produced, and never resolve a placeholder the fresh runtime cannot back. This suite pins the
 * count, not a duration, so it cannot pass by being slow, and it pins the permanent and the
 * momentary case together, because a fix that bounds the permanent case by giving up immediately
 * would break the momentary self-recovery that the render path depends on.
 *
 * If this regresses: either the TUI hangs on a deleted vault, or a spend silently proceeds against
 * credentials the vault no longer vouches for.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { unregisterCustomApis } from "@veyyon/ai/api-registry";
import { createMockModel, registerMockApi } from "@veyyon/ai/providers/mock";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { createAgentSession } from "@veyyon/coding-agent/sdk";
import { resolveVaultLocations, SecretVault, type VaultLocations } from "@veyyon/coding-agent/secrets/vault";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { TempDir } from "@veyyon/utils";
import { type } from "arktype";
import { useSpyTeardown } from "../helpers/spy-teardown";
import { makeScopeUnreadable, writeScopeEntriesExternally } from "./stalevaultneverrefuses-corrupt-vault-fixture";

// Every row installs a `SecretVault.prototype.load` spy to count reloads, and a row killed by the
// deadline never reaches its own `finally`. Registering the restore at creation keeps the rest of
// this file from running against a live counting mock.
const teardown = useSpyTeardown();

const MOCK_API_SOURCE = "refresh-that-cannot-succeed";
const DOOMED_NAME = "TERMINATION_LANE_TOKEN";
const DOOMED_VALUE = "ghp_terminationlanecredential00042";
const BYSTANDER_NAME = "TERMINATION_LANE_BYSTANDER";
const BYSTANDER_VALUE = "ghp_terminationlanebystander00042";

interface Fixture {
	session: AgentSession;
	locations: VaultLocations;
	/** `vault.load()` calls since the last {@link Fixture.resetLoadCount}. */
	loadCount: () => number;
	resetLoadCount: () => void;
	/** Every `tool_execution_end` text block, so a refusal is readable as itself. */
	toolResultTexts: string[];
	/** Whether the scripted tool ran, and with what it was handed. */
	observed: { note: string }[];
	dispose: () => Promise<void>;
}

/**
 * A session holding one live vault secret, plus a counter on the one `vault.load()` that a runtime
 * reload performs. Spies the prototype rather than a module binding, so a refresh that constructs
 * its own `SecretVault` is still counted.
 */
async function fixture(scriptedNote?: string): Promise<Fixture> {
	const tempDir = TempDir.createSync("veyyon-termination-lane-");
	// Distinct directories per scope: one file may not stand for two authenticated scopes.
	const globalConfigRoot = tempDir.join("global");
	const agentDir = tempDir.join("profile");
	const cwd = tempDir.join("project");
	for (const dir of [globalConfigRoot, agentDir, cwd]) fs.mkdirSync(dir, { recursive: true });

	const locations = resolveVaultLocations({ globalConfigRoot, agentDir, cwd });
	const seed = new SecretVault(locations);
	await seed.add({ name: DOOMED_NAME, value: DOOMED_VALUE, scope: "profile", ttl: null });

	const authStorage = await AuthStorage.create(path.join(agentDir, "auth.db"));
	authStorage.setRuntimeApiKey("mock", "mock-key");
	registerMockApi(MOCK_API_SOURCE);

	const observed: { note: string }[] = [];
	const toolResultTexts: string[] = [];
	const { session } = await createAgentSession({
		cwd,
		agentDir,
		globalConfigRoot,
		authStorage,
		modelRegistry: new ModelRegistry(authStorage, path.join(agentDir, "models.yml")),
		sessionManager: SessionManager.inMemory(cwd),
		settings: Settings.isolated({
			"secrets.enabled": true,
			// No approval prompt, so only the codec can refuse the call.
			"tools.approvalMode": "yolo",
			"secrets.auditLog": false,
			"compaction.enabled": false,
		}),
		model: createMockModel({
			responses:
				scriptedNote === undefined
					? [{ content: ["done"] }]
					: [
							{ content: [{ type: "toolCall", name: "spend_probe", arguments: { note: scriptedNote } }] },
							{ content: ["done"] },
						],
		}),
		disableExtensionDiscovery: true,
		extensions: [
			pi => {
				pi.registerTool({
					name: "spend_probe",
					label: "Spend Probe",
					description: "Records the argument it was handed.",
					parameters: type({ note: "string" }),
					approval: "read",
					async execute(_toolCallId, params) {
						observed.push({ note: params.note });
						return { content: [{ type: "text", text: "probed" }] };
					},
				});
			},
		],
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
	session.subscribe(event => {
		if (event.type !== "tool_execution_end") return;
		for (const block of event.result.content) {
			if (block.type === "text") toolResultTexts.push(block.text);
		}
	});

	// Installed AFTER construction, so the session's own startup load is never counted. Left calling
	// through rather than given an implementation: counting is the whole job, and a reimplementation
	// that forwards to the captured original would have to capture it BEFORE the spy replaces the
	// property or recurse into itself.
	const spy = teardown.spy(SecretVault.prototype, "load");

	return {
		session,
		locations,
		loadCount: () => spy.mock.calls.length,
		resetLoadCount: () => spy.mockClear(),
		toolResultTexts,
		observed,
		dispose: async () => {
			spy.mockRestore();
			await session.dispose();
			unregisterCustomApis(MOCK_API_SOURCE);
			authStorage.close();
			tempDir.removeSync();
		},
	};
}

describe("a stale-vault refresh that cannot succeed", () => {
	it("attempts the reload exactly once per call when the vault is permanently unreadable", async () => {
		const h = await fixture();
		try {
			const lease = await h.session.leaseSecretRuntime();
			const carrying = lease.obfuscateText(`deploy with ${DOOMED_VALUE}`);
			// Precondition, or the rest measures nothing: this text really does carry a placeholder
			// that this lease can still resolve, so the guard has something to be stale about.
			expect(lease.expansionObfuscator?.containsLivePlaceholder(carrying)).toBe(true);
			expect(carrying).not.toContain(DOOMED_VALUE);

			// PERMANENT, not momentary: the file clears every provenance and integrity check and its
			// decrypted payload will not parse, so every reload from here reaches the same wall.
			await makeScopeUnreadable(h.locations, "profile");
			h.resetLoadCount();

			await lease.ensureFreshForExpansion(carrying);

			// The bound. One reload attempted, so recovery was genuinely tried; not two, so nothing is
			// looping in wait of a revision that will never settle.
			//
			// WHAT THIS COUNT DOES AND DOES NOT CATCH, since the difference decides whether a future
			// reader trusts it. It catches a retry that actually re-reads the vault, which is the
			// shape a "just try again" patch takes: adding one more `refreshSecretRuntime` await here
			// turns this into 2 and the repeated-ask row into 10. It does NOT catch a spin that
			// re-evaluates freshness without reloading, because there is nothing to count; that shape
			// fails by exhausting the deadline instead, loudly, in the row that provokes it.
			expect(h.loadCount()).toBe(1);
		} finally {
			await h.dispose();
		}
	});

	it("does not settle into resolving a placeholder the fresh vault no longer backs", async () => {
		const h = await fixture();
		try {
			const lease = await h.session.leaseSecretRuntime();
			const carrying = lease.obfuscateText(`deploy with ${DOOMED_VALUE}`);
			await makeScopeUnreadable(h.locations, "profile");

			await lease.ensureFreshForExpansion(carrying);

			// The opposite failure from the row above, and the one that arrives late: having stopped
			// retrying, the guard must not fall back on the obfuscator it loaded BEFORE the change.
			// The credential is no longer vouched for by any readable scope, so nothing may expand it.
			const fresh = await h.session.leaseSecretRuntime();
			expect(fresh.expansionObfuscator?.containsLivePlaceholder(carrying)).toBe(false);
			expect(fresh.expansionObfuscator?.deobfuscate(carrying) ?? carrying).not.toContain(DOOMED_VALUE);
		} finally {
			await h.dispose();
		}
	});

	it("still recovers when the change was momentary rather than permanent", async () => {
		const h = await fixture();
		try {
			const lease = await h.session.leaseSecretRuntime();
			const carrying = lease.obfuscateText(`deploy with ${DOOMED_VALUE}`);

			// MOMENTARY: another process wrote the vault, which bumps the revision and makes this
			// lease stale, but the scope stays readable and still holds the secret. This is the case
			// the render path relies on self-recovering, so a fix that bounded the row above by
			// giving up immediately would break exactly here.
			//
			// Same scope and same FILE the permanent row corrupts, through the same raw external
			// write, so the two rows differ in exactly one variable: whether the payload parses.
			// `SecretVault.add` is not interchangeable here. A write through the vault API is
			// re-anchored as this process's own, deliberately, so the revision never moves and the
			// guard is never reached; the row then passes for the wrong reason, having measured a
			// lease that was never stale.
			await writeScopeEntriesExternally(h.locations, "profile", [
				{ name: DOOMED_NAME, value: DOOMED_VALUE, expiresAt: null },
				{ name: BYSTANDER_NAME, value: BYSTANDER_VALUE, expiresAt: null },
			]);
			h.resetLoadCount();

			await lease.ensureFreshForExpansion(carrying);

			// One attempt sufficed, and it reconciled rather than refused.
			expect(h.loadCount()).toBe(1);
			const fresh = await h.session.leaseSecretRuntime();
			expect(fresh.expansionObfuscator?.deobfuscate(carrying)).toContain(DOOMED_VALUE);
		} finally {
			await h.dispose();
		}
	});

	it("does not escalate its reload count when asked repeatedly in the unreachable state", async () => {
		const h = await fixture();
		try {
			const lease = await h.session.leaseSecretRuntime();
			const carrying = lease.obfuscateText(`deploy with ${DOOMED_VALUE}`);
			await makeScopeUnreadable(h.locations, "profile");
			h.resetLoadCount();

			// A render path calls this per repaint, so "bounded per call" has to mean a constant, not
			// an amount that grows with how often the operator has looked at the screen.
			for (let attempt = 0; attempt < 5; attempt++) await lease.ensureFreshForExpansion(carrying);

			// At most one reload per ask, and the later asks are frequently free: once the fresh
			// runtime can no longer resolve this text, there is nothing left to be stale about.
			expect(h.loadCount()).toBeLessThanOrEqual(5);
			expect(h.loadCount()).toBeGreaterThan(0);
		} finally {
			await h.dispose();
		}
	});

	it("refuses the spend instead of handing a tool a placeholder no vault can resolve", async () => {
		// End to end, in the shape the operator actually hit: the vault went bad UNDER a running
		// session. The rows above prove the guard terminates; this proves terminating did not turn
		// into shipping an unresolved `#NAME#` to a command as though it were a credential.
		const h = await fixture(`deploy with #${DOOMED_NAME}#`);
		try {
			await makeScopeUnreadable(h.locations, "profile");

			await h.session.prompt("call the probe");
			await h.session.waitForIdle();

			expect(h.observed).toEqual([]);
			expect(h.toolResultTexts.join("\n")).toContain("refused");
			expect(h.toolResultTexts.join("\n")).not.toContain(DOOMED_VALUE);
		} finally {
			await h.dispose();
		}
	});
});
