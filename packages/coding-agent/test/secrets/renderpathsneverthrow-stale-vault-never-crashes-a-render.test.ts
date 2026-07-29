/**
 * A changed secret vault must never take a live session down.
 *
 * THE CRASH THIS LOCKS OUT: the expansion freshness guard used to throw whenever the captured
 * vault revision no longer matched the vault on disk, and eight of its call sites in
 * `AgentSession` are display or render paths, not tool calls: `displayAssistantContent` (reached
 * by the streamed `message_end` handler), `displayToolIntent`, `buildDisplaySessionContext`
 * (which the constructor itself calls, and every post-compaction state rebuild),
 * `buildTranscriptSessionContext` (every TUI repaint), the provider-delta display decoder, the
 * ephemeral turn's final message, and the transcript rebuild behind `navigateTree`. An exception
 * raised there does not fail one operation. It unwinds whatever was rendering and the session is
 * gone: the reported symptom was a TUI that refused every command after another process touched
 * the vault.
 *
 * If any of this regresses: a `/secret` write from a second veyyon window, an editor saving the
 * vault, or a rotation script running in CI is enough to kill the running session mid-turn. A
 * placeholder rendered literally is cosmetic; a throw here is a dead TUI.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentMessage } from "@veyyon/agent-core";
import type { AssistantMessage } from "@veyyon/ai";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { createAgentSession } from "@veyyon/coding-agent/sdk";
import { attachSecretsNoticeSink } from "@veyyon/coding-agent/secrets/notices";
import { MAX_SECRET_VALUE_BYTES, SecretObfuscator } from "@veyyon/coding-agent/secrets/obfuscator";
import { SecretVault, type VaultLocations, vaultPathFor } from "@veyyon/coding-agent/secrets/vault";
import type { AgentSession, SecretRuntimeLease } from "@veyyon/coding-agent/session/agent-session";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { TempDir } from "@veyyon/utils";
import { useIsolatedConfigRoot } from "../helpers/isolated-agent-dir";

const STORED_NAME = "RENDER_TOKEN";
const STORED_PLACEHOLDER = `#${STORED_NAME}#`;
const STORED_VALUE = "render-path-secret-value-13579";
const SECOND_VALUE = "written-by-another-process-24680";
/**
 * The VEHICLE for every row that observes expansion, and it cannot be the vault secret.
 *
 * A vault-backed credential is withheld from every display path on purpose, so it can never be
 * used to watch a stale revision stop an expansion: it does not expand when fresh either. A
 * `secrets.yml` REGEX entry is the one origin/type pair that stays display-restorable, so it is
 * what makes "stale renders the placeholder, fresh renders the value" observable at all.
 *
 * The entry is a PATTERN over a numeric tail rather than one literal, so a row can mint a value the
 * runtime has never seen. That matters for the recovery row: a value that already flowed is carried
 * into a refreshed runtime as redact-only and cannot be observed expanding again, so proving that
 * recovery reopened expansion needs a value minted after the refresh. See that row for detail.
 */
const RESTORABLE_PATTERN = "config-regex-restorable-value-[0-9]+";
const RESTORABLE_VALUE = "config-regex-restorable-value-24680";
const RESTORABLE_VALUE_AFTER_REFRESH = "config-regex-restorable-value-97531";
const getConfigRoot = useIsolatedConfigRoot();

let registryRoot: TempDir;
let authStorage: AuthStorage;
let modelRegistry: ModelRegistry;

beforeAll(async () => {
	registryRoot = TempDir.createSync("renderpaths-registry-");
	authStorage = await AuthStorage.create(registryRoot.join("auth.db"));
	modelRegistry = new ModelRegistry(authStorage, registryRoot.join("models.yml"));
});

afterAll(async () => {
	authStorage.close();
	await registryRoot.remove();
});

interface RenderFixture {
	root: TempDir;
	project: string;
	locations: VaultLocations;
	/** Same files the session reads, for capturing a revision and writing as another process would. */
	vault: SecretVault;
	settings: Settings;
	session: AgentSession;
}

/**
 * @param options.storeSecret Write a secret into the project vault before the session is
 *   built. Turn it OFF to get the "protection on, vault absent" startup shape.
 * @param options.enableBeforeConstruction Turn protection on BEFORE `createAgentSession`, so
 *   the constructor's own render (`buildDisplaySessionContext` for the MCP-selection read) runs
 *   with a live obfuscator rather than after a later refresh.
 */
async function createRenderFixture(
	options: { storeSecret?: boolean; enableBeforeConstruction?: boolean } = {},
): Promise<RenderFixture> {
	const { storeSecret = true, enableBeforeConstruction = false } = options;
	const root = TempDir.createSync("renderpaths-never-throw-");
	const project = path.resolve(root.join("project"));
	const agentDir = path.resolve(root.join("agent"));
	await fs.mkdir(path.join(project, ".veyyon"), { recursive: true });
	await Bun.write(path.join(project, ".veyyon", "secrets.yml"), `- type: regex\n  content: "${RESTORABLE_PATTERN}"\n`);
	const locations: VaultLocations = {
		globalConfigRoot: getConfigRoot(),
		profileDir: agentDir,
		projectDir: path.join(project, ".veyyon"),
	};
	const vault = new SecretVault(locations);
	if (storeSecret) await vault.add({ name: STORED_NAME, value: STORED_VALUE, scope: "project" });
	const settings = Settings.isolated();
	if (enableBeforeConstruction) settings.set("secrets.enabled", true);
	const { session } = await createAgentSession({
		cwd: project,
		agentDir,
		sessionManager: SessionManager.inMemory(project),
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
	return { root, project, locations, vault, settings, session };
}

async function disposeRenderFixture(fixture: RenderFixture): Promise<void> {
	await fixture.session.dispose();
	await fixture.root.remove();
}

/**
 * Enable protection, load both secrets, and mint the restorable placeholder.
 *
 * Returns the placeholder the config regex mints for {@link RESTORABLE_VALUE}. A regex mapping
 * only exists once the value has been redacted at least once, which is exactly how it arises in a
 * session: text went out, so the map learned the value. Asserts BOTH secrets loaded, so no row can
 * pass by quietly having no secret at all, and asserts the two are distinguishable, so a row that
 * means to observe withholding cannot accidentally observe the restorable one.
 */
async function enableSecrets(fixture: RenderFixture): Promise<string> {
	fixture.settings.set("secrets.enabled", true);
	await fixture.session.refreshSecrets({ refreshPrompt: false });
	expect(fixture.session.obfuscator?.obfuscate(STORED_VALUE)).toBe(STORED_PLACEHOLDER);
	const restorablePlaceholder = fixture.session.obfuscator?.obfuscate(RESTORABLE_VALUE) ?? "";
	expect(restorablePlaceholder).not.toBe(RESTORABLE_VALUE);
	expect(restorablePlaceholder).not.toBe(STORED_PLACEHOLDER);
	return restorablePlaceholder;
}

/**
 * Change the vault the way a second veyyon window or a rotation script does: a real content
 * write, then a file write this process did not make through the vault writer, which is what the
 * revision fingerprint is built to notice. Asserts the fingerprint actually moved, so a test can
 * never quietly pass against a session that was still fresh.
 */
async function mutateVaultAsAnotherProcess(fixture: RenderFixture): Promise<void> {
	const captured = fixture.vault.revision();
	await fixture.vault.add({ name: "SECOND_TOKEN", value: SECOND_VALUE, scope: "project" });
	const vaultPath = vaultPathFor(fixture.locations, "project");
	await fs.writeFile(vaultPath, await fs.readFile(vaultPath));
	expect(fixture.vault.revision()).not.toBe(captured);
}

const usage: AssistantMessage["usage"] = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistantSaying(text: string, timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "test",
		provider: "test",
		model: "test",
		usage,
		stopReason: "stop",
		timestamp,
	};
}

function assistantTextOf(messages: readonly AgentMessage[]): string {
	const parts: string[] = [];
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const block of message.content) {
			if (block.type === "text") parts.push(block.text);
		}
	}
	return parts.join("\n");
}

function contentTextOf(content: AssistantMessage["content"]): string {
	return content
		.filter((block): block is Extract<AssistantMessage["content"][number], { type: "text" }> => block.type === "text")
		.map(block => block.text)
		.join("\n");
}

interface InstalledRuntimeProbe {
	freshnessChecks: () => number;
	refreshAwaits: () => number;
}

/**
 * Install a runtime lease that implements the freshness contract over a real obfuscator, and
 * count every consultation.
 *
 * `assertFreshForExpansion` throws unconditionally on purpose: it is the SPEND guard, and no
 * render or display path may ever reach it. A render that calls it fails the test instead of
 * quietly changing behavior.
 */
function installRuntime(
	session: AgentSession,
	obfuscator: SecretObfuscator,
	options: { fresh: boolean; refreshFails?: boolean },
): InstalledRuntimeProbe {
	let freshnessChecks = 0;
	let refreshAwaits = 0;
	const lease: SecretRuntimeLease = {
		// Above the revision the SDK installed at construction, so this lease wins and a
		// background refresh cannot replace it mid-test.
		revision: 1000,
		cwd: session.sessionManager.getCwd(),
		expansionObfuscator: obfuscator,
		redactionObfuscator: obfuscator,
		hasRedactions: obfuscator.hasSecrets(),
		obfuscateText: text => obfuscator.obfuscate(text),
		obfuscateMessages: messages => messages,
		obfuscateContext: context => context,
		obfuscatePayload: payload => payload,
		isFreshForExpansion: () => {
			freshnessChecks++;
			return options.fresh;
		},
		ensureFreshForExpansion: async () => {
			refreshAwaits++;
			if (options.refreshFails) throw new Error("the vault could not be re-read");
		},
		assertFreshForExpansion: () => {
			throw new Error("a render path reached the fail-closed spend guard");
		},
	};
	session.installSecretRuntime(lease);
	return { freshnessChecks: () => freshnessChecks, refreshAwaits: () => refreshAwaits };
}

describe("a stale secret vault never crashes a render", () => {
	/**
	 * The exact reported reproduction, end to end through the SDK's own runtime lease: a secret
	 * stored, the vault changed by another process, then an assistant message and a transcript
	 * rebuild. Before the fix the `message_end` handler threw out of the agent event dispatch and
	 * the session stopped answering; the placeholder must simply stay literal instead.
	 */
	it("delivers an assistant message and rebuilds the transcript after another process changed the vault", async () => {
		const fixture = await createRenderFixture();
		const notices: string[] = [];
		const detach = attachSecretsNoticeSink(message => notices.push(message));
		try {
			const restorable = await enableSecrets(fixture);
			fixture.session.sessionManager.appendMessage(assistantSaying(`the token is ${restorable}`, 1));

			// Control: while the captured revision is current, the same render expands.
			expect(assistantTextOf(fixture.session.buildTranscriptSessionContext().messages)).toContain(RESTORABLE_VALUE);

			await mutateVaultAsAnotherProcess(fixture);

			const delivered = Promise.withResolvers<AssistantMessage>();
			const unsubscribe = fixture.session.subscribe(event => {
				if (event.type === "message_end" && event.message.role === "assistant" && event.message.timestamp === 2) {
					delivered.resolve(event.message);
				}
			});
			const streamed = assistantSaying(`the token is still ${restorable}`, 2);
			fixture.session.agent.emitExternalEvent({ type: "message_end", message: streamed });
			const displayed = await delivered.promise;
			unsubscribe();

			// The render completed and the placeholder survived literally.
			expect(contentTextOf(displayed.content)).toBe(`the token is still ${restorable}`);
			expect(contentTextOf(displayed.content)).not.toContain(RESTORABLE_VALUE);

			// So does the transcript rebuild the TUI repaints from.
			const transcript = fixture.session.buildTranscriptSessionContext();
			expect(assistantTextOf(transcript.messages)).toContain(restorable);
			expect(assistantTextOf(transcript.messages)).not.toContain(RESTORABLE_VALUE);

			// The operator was told, through the secrets notice sink, without the value in it.
			expect(notices.some(notice => notice.includes("unexpanded"))).toBe(true);
			expect(notices.every(notice => !notice.includes(RESTORABLE_VALUE))).toBe(true);
		} finally {
			detach();
			await disposeRenderFixture(fixture);
		}
	});

	/**
	 * Same stale state, driven through the render contract directly rather than the SDK's lease,
	 * so the guarantee is pinned even if the SDK's freshness implementation changes: every
	 * synchronous display entry point returns, and returns the literal placeholder.
	 *
	 * Each of these used to throw. `buildDisplaySessionContext` is the worst of them: the
	 * AgentSession constructor calls it, so a stale vault could fail session creation outright.
	 */
	it("returns the literal placeholder from every synchronous display path", async () => {
		const fixture = await createRenderFixture();
		try {
			// A DISPLAY-RESTORABLE mapping (`config` + `regex`), because staleness is only observable
			// through one: a vault-backed credential is withheld whether the captured revision is
			// current or not, so every assertion below would pass for the wrong reason.
			const obfuscator = new SecretObfuscator([{ type: "regex", origin: "config", content: STORED_VALUE }]);
			const placeholder = obfuscator.obfuscate(STORED_VALUE);
			expect(placeholder).not.toBe(STORED_VALUE);
			fixture.session.sessionManager.appendMessage(assistantSaying(`the token is ${placeholder}`, 1));

			// Positive control: a fresh runtime expands on every one of these paths.
			installRuntime(fixture.session, obfuscator, { fresh: true });
			expect(contentTextOf(fixture.session.displayAssistantContent([{ type: "text", text: placeholder }]))).toBe(
				STORED_VALUE,
			);
			expect(fixture.session.displayToolIntent(`reading ${placeholder}`)).toBe(`reading ${STORED_VALUE}`);
			expect(assistantTextOf(fixture.session.buildDisplaySessionContext().messages)).toContain(STORED_VALUE);
			expect(assistantTextOf(fixture.session.buildTranscriptSessionContext().messages)).toContain(STORED_VALUE);

			// Stale: every path still returns, with the placeholder intact.
			const probe = installRuntime(fixture.session, obfuscator, { fresh: false });
			expect(contentTextOf(fixture.session.displayAssistantContent([{ type: "text", text: placeholder }]))).toBe(
				placeholder,
			);
			expect(fixture.session.displayToolIntent(`reading ${placeholder}`)).toBe(`reading ${placeholder}`);
			expect(assistantTextOf(fixture.session.buildDisplaySessionContext().messages)).toBe(
				`the token is ${placeholder}`,
			);
			expect(assistantTextOf(fixture.session.buildTranscriptSessionContext().messages)).toBe(
				`the token is ${placeholder}`,
			);
			expect(probe.freshnessChecks()).toBeGreaterThan(0);
		} finally {
			await disposeRenderFixture(fixture);
		}
	});

	/**
	 * The reported false refusal: `echo "$HOME"; echo ---; ls -la "$HOME"` carries no placeholder
	 * at all and was still refused, because every call site gated on "this session has a secret"
	 * rather than "this text has something to expand".
	 *
	 * A payload with nothing to expand must not consult the vault revision even once. Beyond the
	 * false refusal, the freshness probe reads the vault files off disk, so consulting it per
	 * transcript string would put a syscall behind every repainted line.
	 */
	it("never consults freshness for text that carries no live placeholder", async () => {
		const fixture = await createRenderFixture();
		try {
			const obfuscator = new SecretObfuscator([
				{ type: "plain", origin: "config", content: STORED_VALUE, name: STORED_NAME },
			]);
			fixture.session.sessionManager.appendMessage(
				assistantSaying('echo "$HOME"; echo ---; ls -la "$HOME"\nan unrelated #NOT_A_SECRET# token', 1),
			);
			const probe = installRuntime(fixture.session, obfuscator, { fresh: false });

			expect(fixture.session.displayToolIntent('echo "$HOME"')).toBe('echo "$HOME"');
			expect(
				contentTextOf(fixture.session.displayAssistantContent([{ type: "text", text: "nothing to expand" }])),
			).toBe("nothing to expand");
			const transcript = fixture.session.buildTranscriptSessionContext();
			expect(assistantTextOf(transcript.messages)).toContain('ls -la "$HOME"');
			expect(assistantTextOf(transcript.messages)).toContain("#NOT_A_SECRET#");
			expect(fixture.session.buildDisplaySessionContext()).toBeDefined();

			expect(probe.freshnessChecks()).toBe(0);
			expect(probe.refreshAwaits()).toBe(0);
		} finally {
			await disposeRenderFixture(fixture);
		}
	});

	/**
	 * Freshness is not the only way expansion can fail. The codec refuses text whose expansion
	 * would exceed its output byte limit, and that refusal reached the same render paths. A
	 * display path must degrade for ANY codec reason, not just a stale revision.
	 */
	it("degrades instead of throwing when the codec itself refuses the text", async () => {
		const fixture = await createRenderFixture();
		const notices: string[] = [];
		const detach = attachSecretsNoticeSink(message => notices.push(message));
		try {
			const huge = "v".repeat(MAX_SECRET_VALUE_BYTES);
			// Restorable (`config` + `regex`), so the codec is genuinely REACHED. A withheld mapping
			// returns the text untouched without ever entering the codec, which would make the
			// degrade below vacuous: it would pass whether or not the refusal is handled. The pattern
			// stays tiny while the VALUE is huge, which is what overflows the expansion output.
			const obfuscator = new SecretObfuscator([{ type: "regex", origin: "config", content: "v+" }]);
			const placeholder = obfuscator.obfuscate(huge);
			expect(placeholder).not.toBe(huge);
			const overLimit = placeholder.repeat(17);
			// The codec genuinely refuses this text, so the degrade is not vacuous.
			expect(() => obfuscator.deobfuscate(overLimit)).toThrow(/output byte limit/i);

			fixture.session.sessionManager.appendMessage(assistantSaying(overLimit, 1));
			installRuntime(fixture.session, obfuscator, { fresh: true });

			expect(fixture.session.displayToolIntent(overLimit)).toBe(overLimit);
			expect(contentTextOf(fixture.session.displayAssistantContent([{ type: "text", text: overLimit }]))).toBe(
				overLimit,
			);
			expect(assistantTextOf(fixture.session.buildTranscriptSessionContext().messages)).toBe(overLimit);
			expect(notices.some(notice => notice.includes("unexpanded"))).toBe(true);
		} finally {
			detach();
			await disposeRenderFixture(fixture);
		}
	});

	/**
	 * The async render path behind `navigateTree`: it rebuilds the agent's display state from the
	 * session file, and a throw there left the TUI with a branch selected and no transcript. Being
	 * async it can do better than degrade, so it awaits the vault re-read first.
	 *
	 * The adversarial half is that the re-read FAILS: the navigation must still complete.
	 *
	 * WHY THE VEHICLE IS A RESTORABLE MAPPING, because `refreshAwaits() === 1` is the assertion and
	 * a withheld one legitimately awaits ZERO times. Text whose only placeholder is a vault-backed
	 * credential cannot be changed by expansion however fresh the vault becomes, so reading the
	 * vault off disk before drawing it would be pure waste on a render path. Skipping the await
	 * there is correct, not a broken await, and this row would read as proof of the opposite to
	 * anyone who found it without this note.
	 */
	it("completes a branch navigation transcript rebuild when the refresh itself fails", async () => {
		const fixture = await createRenderFixture();
		try {
			const obfuscator = new SecretObfuscator([{ type: "regex", origin: "config", content: STORED_VALUE }]);
			const placeholder = obfuscator.obfuscate(STORED_VALUE);
			expect(placeholder).not.toBe(STORED_VALUE);
			fixture.session.sessionManager.appendMessage(assistantSaying(`the token is ${placeholder}`, 1));
			fixture.session.sessionManager.appendMessage(assistantSaying("a later turn", 2));
			const target = fixture.session.sessionManager.getEntries().find(entry => entry.type === "message");
			expect(target).toBeDefined();

			const probe = installRuntime(fixture.session, obfuscator, { fresh: false, refreshFails: true });
			const navigated = await fixture.session.navigateTree(target?.id ?? "");

			expect(navigated).toBeDefined();
			expect(probe.refreshAwaits()).toBe(1);
			expect(assistantTextOf(fixture.session.messages)).toContain(placeholder);
			expect(assistantTextOf(fixture.session.messages)).not.toContain(STORED_VALUE);
		} finally {
			await disposeRenderFixture(fixture);
		}
	});

	/**
	 * A stale revision must not be a permanent downgrade. The render degrades, but it also starts
	 * the vault re-read, and that re-read is queued on the session's scope-transition tail so the
	 * recovery is observable rather than a race: after it settles, the SAME text expands.
	 *
	 * Without this the session would show placeholders until the operator restarted it, which is
	 * the same unusable state as the crash, only quieter. That is why the row asserts on the
	 * already-rendered placeholder and not only on a value minted later: recovery that leaves the
	 * transcript the operator is looking at permanently opaque is not recovery.
	 *
	 * Two vehicles, because they fail independently:
	 *
	 * A value that ALREADY FLOWED is carried into the refreshed runtime by `retainRedactionsFrom`,
	 * which exists so redaction never regresses across a refresh. It used to install that value as a
	 * redact-only mapping that shadowed the config regex rule, which left every previously seen
	 * config-regex value opaque for the rest of the session; the codec now defers to a covering
	 * obfuscate-mode rule instead, so the rule re-registers the reverse mapping and the display grant
	 * the first time the value passes through the new runtime, which any outbound redaction does. The
	 * row makes that pass explicit rather than pretending a render alone recovers the mapping: text
	 * holds the PLACEHOLDER, and no amount of rendering it teaches the runtime the cleartext.
	 *
	 * A value the refreshed runtime SEES FIRST exercises the ordinary path, and would still pass if
	 * the retained half broke, which is exactly why it cannot be the only vehicle.
	 */
	it("recovers on its own so a later render expands again", async () => {
		const fixture = await createRenderFixture();
		try {
			const restorable = await enableSecrets(fixture);
			fixture.session.sessionManager.appendMessage(assistantSaying(`the token is ${restorable}`, 1));
			await mutateVaultAsAnotherProcess(fixture);

			// Degraded render, which also schedules the recovery.
			expect(assistantTextOf(fixture.session.buildTranscriptSessionContext().messages)).toContain(restorable);
			expect(assistantTextOf(fixture.session.buildTranscriptSessionContext().messages)).not.toContain(
				RESTORABLE_VALUE,
			);

			await fixture.session.awaitScopeTransitionReady();

			// The refreshed runtime is in place, proven by the vault entry it could not have had before.
			expect(fixture.session.obfuscator?.obfuscate(SECOND_VALUE)).toBe("#SECOND_TOKEN#");

			// The retained value, once it passes through the refreshed runtime as it does on any
			// outbound redaction. The rule mints the same placeholder and registers the reverse
			// mapping and the display grant on that first use, so the text ALREADY on screen expands.
			expect(fixture.session.obfuscator?.obfuscate(RESTORABLE_VALUE)).toBe(restorable);
			expect(assistantTextOf(fixture.session.buildTranscriptSessionContext().messages)).toContain(RESTORABLE_VALUE);

			// A value the refreshed runtime learns now, which fails independently of the retained half.
			const minted = fixture.session.obfuscator?.obfuscate(RESTORABLE_VALUE_AFTER_REFRESH) ?? "";
			expect(minted).not.toBe(RESTORABLE_VALUE_AFTER_REFRESH);
			fixture.session.sessionManager.appendMessage(assistantSaying(`the later token is ${minted}`, 2));
			expect(assistantTextOf(fixture.session.buildTranscriptSessionContext().messages)).toContain(
				RESTORABLE_VALUE_AFTER_REFRESH,
			);
			expect(fixture.session.displayToolIntent(`using ${minted}`)).toBe(`using ${RESTORABLE_VALUE_AFTER_REFRESH}`);
		} finally {
			await disposeRenderFixture(fixture);
		}
	});

	/**
	 * THE WITHHOLD PATH, which every row above deliberately steers around by using a restorable
	 * mapping, and which therefore needs its own row or nothing here touches it.
	 *
	 * A vault-backed credential must render as its placeholder in BOTH freshness states. Checking
	 * only the stale one would pass even if a fresh render started drawing the value, and checking
	 * only the fresh one would miss a stale render that leaked it: the two failures need opposite
	 * assertions, so the row asserts both.
	 *
	 * If this regresses, a stored credential is printed into the operator's terminal and scrollback
	 * by whichever of the two states stopped withholding, and the rows above would all stay green
	 * because their vehicle is a mapping that is SUPPOSED to expand.
	 */
	it("withholds a vault-backed secret whether the vault is fresh or stale", async () => {
		const fixture = await createRenderFixture();
		try {
			await enableSecrets(fixture);
			fixture.session.sessionManager.appendMessage(assistantSaying(`the token is ${STORED_PLACEHOLDER}`, 1));

			// Fresh: the captured revision is current and the value is STILL not drawn.
			expect(assistantTextOf(fixture.session.buildTranscriptSessionContext().messages)).toBe(
				`the token is ${STORED_PLACEHOLDER}`,
			);
			expect(
				contentTextOf(fixture.session.displayAssistantContent([{ type: "text", text: STORED_PLACEHOLDER }])),
			).toBe(STORED_PLACEHOLDER);
			expect(fixture.session.displayToolIntent(`reading ${STORED_PLACEHOLDER}`)).toBe(
				`reading ${STORED_PLACEHOLDER}`,
			);

			await mutateVaultAsAnotherProcess(fixture);

			// Stale: unchanged, and still not drawn.
			expect(assistantTextOf(fixture.session.buildTranscriptSessionContext().messages)).toBe(
				`the token is ${STORED_PLACEHOLDER}`,
			);
			expect(assistantTextOf(fixture.session.buildDisplaySessionContext().messages)).not.toContain(STORED_VALUE);

			// And after the recovery that makes a restorable mapping expand again, still withheld.
			await fixture.session.awaitScopeTransitionReady();
			expect(assistantTextOf(fixture.session.buildTranscriptSessionContext().messages)).not.toContain(STORED_VALUE);
		} finally {
			await disposeRenderFixture(fixture);
		}
	});

	/**
	 * The other end of the range: protection turned on with NO vault on disk, before the session
	 * is even built. `buildDisplaySessionContext` runs inside the AgentSession CONSTRUCTOR, so a
	 * render-path throw here would fail session CREATION rather than one repaint, and the operator
	 * would see a launch that dies instead of a TUI. Nothing about an absent vault is stale, so
	 * every render must be a plain pass-through.
	 *
	 * READ THIS BEFORE CONCLUDING THE SECRETS CODE CANNOT BE INVOLVED IN A STARTUP PROBLEM. With
	 * protection on and no vault file anywhere, `obfuscator.hasSecrets()` is still TRUE. The
	 * loader derives secrets from ENVIRONMENT values matched by keyword, so there are secrets to
	 * obfuscate without a vault ever existing: the obfuscator is live, every display path really
	 * does run its expansion, and the only thing missing is a captured vault revision, which is
	 * why the freshness probe treats this session as fresh and never degrades it. The intuition
	 * that "no vault means no obfuscator, so this seam is inert" is wrong and costs an hour.
	 *
	 * If this regresses, `config set secrets.enabled true` followed by a launch stops booting.
	 */
	it("boots and renders with protection enabled and no vault on disk", async () => {
		const fixture = await createRenderFixture({ storeSecret: false, enableBeforeConstruction: true });
		try {
			expect(fixture.session.secretsEnabled).toBe(true);
			// Pinned, not just described in the comment above: the obfuscator is LIVE here despite
			// there being no vault, so the pass-throughs below are the real expansion path running
			// and finding nothing to expand, not an inert seam being skipped.
			expect(fixture.session.obfuscator?.hasSecrets()).toBe(true);
			fixture.session.sessionManager.appendMessage(assistantSaying(`plain ${STORED_PLACEHOLDER} text`, 1));

			// A placeholder-shaped string with no secret behind it is not expandable and not an
			// error: it renders exactly as written, on every path.
			expect(assistantTextOf(fixture.session.buildTranscriptSessionContext().messages)).toBe(
				`plain ${STORED_PLACEHOLDER} text`,
			);
			expect(assistantTextOf(fixture.session.buildDisplaySessionContext().messages)).toBe(
				`plain ${STORED_PLACEHOLDER} text`,
			);
			expect(fixture.session.displayToolIntent(`reading ${STORED_PLACEHOLDER}`)).toBe(
				`reading ${STORED_PLACEHOLDER}`,
			);
			expect(
				fixture.session.displayAssistantContent([{ type: "text", text: `plain ${STORED_PLACEHOLDER} text` }]),
			).toEqual([{ type: "text", text: `plain ${STORED_PLACEHOLDER} text` }]);
		} finally {
			await disposeRenderFixture(fixture);
		}
	});
});
