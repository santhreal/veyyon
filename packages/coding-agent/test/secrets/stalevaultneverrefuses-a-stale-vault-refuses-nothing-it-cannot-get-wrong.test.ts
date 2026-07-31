/**
 * A moved vault revision refuses nothing it could not have gotten wrong.
 *
 * THE BUG THIS LOCKS OUT. `assertFreshForExpansion` in `sdk.ts` threw unconditionally the moment the
 * vault's revision fingerprint stopped matching the one a request was pinned to. Two things made
 * that catastrophic rather than merely strict. It fired on the SESSION ("this session holds a
 * secret") instead of on the PAYLOAD ("this text carries a placeholder I would substitute"), so a
 * `bash` call reading `echo "$HOME"` was refused out of a session that happened to hold one
 * credential. And the recovery was already written one line above the throw: `refreshSecretRuntime`
 * was scheduled with `void`, its promise discarded, and the guard threw anyway. A stale revision is
 * a cache miss, not a security event.
 *
 * WHAT BREAKS IF THIS REGRESSES. Every tool call in a session that ever loaded a secret starts
 * failing as soon as anything moves the fingerprint, whether or not the call mentions a secret. No
 * setting avoids it: the guard lives in the expansion codec, downstream of the approval gate, so
 * `yolo` cannot bypass it.
 *
 * WHY THESE ARE END TO END. The gate has to hold at the one seam that actually expands, which is
 * `transformToolCallArguments` in `sdk.ts`. A unit test on the obfuscator, or on the lease alone,
 * stays green if that call site keeps asking the session-wide question. So these drive a real vault
 * on disk, `createAgentSession`, a scripted model issuing one tool call, and a registered tool that
 * reports what actually arrived.
 *
 * HOW STALENESS IS FORCED. `SecretVault.prototype.revision` is overridden for the duration of a run.
 * That is exactly what an external writer looks like from inside this process, and it keeps the
 * suite independent of how the fingerprint happens to be computed. Expiry is forced by offsetting
 * `Date.now`, not by sleeping, so the retired-placeholder row costs no wall-clock time.
 *
 * NO VALUE IS EVER RECORDED. The probe tool reports booleans, so a failing expectation prints
 * `false`, never a credential.
 */
import { describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { unregisterCustomApis } from "@veyyon/ai/api-registry";
import { createMockModel, registerMockApi } from "@veyyon/ai/providers/mock";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { createAgentSession } from "@veyyon/coding-agent/sdk";
import { SECRET_SPEND_NOTICE_SOURCE } from "@veyyon/coding-agent/secrets/notices";
import { resolveVaultLocations, SecretVault } from "@veyyon/coding-agent/secrets/vault";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { TempDir } from "@veyyon/utils";
import { type } from "arktype";

const MOCK_API_SOURCE = "stale-vault-refuses-nothing";

const LIVE_NAME = "STALE_LANE_TOKEN";
/** What the vault holds when the session starts. */
const ORIGINAL_VALUE = "ghp_stalelaneoriginalcredential0123";
/** What the vault holds after an out-of-band rotation. */
const ROTATED_VALUE = "ghp_stalelanerotatedcredential98765";

const EXPIRING_NAME = "STALE_LANE_EXPIRING";
const EXPIRING_VALUE = "ghp_stalelaneexpiringcredential5555";
/** Stored live, then retired by moving the clock past it rather than by waiting. */
const EXPIRING_TTL_MS = 60_000;

/** What the probe tool saw, as booleans. The credential never leaves `execute`. */
interface ProbeObservation {
	/** The value stored by the out-of-band rotation arrived, i.e. expansion used the live vault. */
	sawRotatedValue: boolean;
	/** The value the session loaded at startup arrived, i.e. expansion used the pinned snapshot. */
	sawStartupValue: boolean;
	/** The argument arrived exactly as the model wrote it, i.e. nothing was substituted. */
	verbatim: boolean;
}

/** How `SecretVault.prototype.revision` answers once the session is up. */
type Staleness =
	/** Untouched: the real fingerprint, whatever it is. */
	| "settled"
	/** One external write, then quiet. A reload can reach a fresh revision. */
	| "one-external-write"
	/** A writer that never stops. No reload can ever reach a fresh revision. */
	| "unending-churn";

interface SeededSecret {
	name: string;
	value: string;
	ttlMs?: number;
}

interface ProbeRun {
	/** Stored in the vault before the session starts. */
	seed: SeededSecret[];
	/** The argument the scripted model writes, before expansion. */
	note: string;
	staleness: Staleness;
	/** Rotate `LIVE_NAME` out of band after the session is up, before the prompt. */
	rotate?: boolean;
	/** Jump the clock this far forward after startup, to retire a TTL the session loaded live. */
	advanceClockMs?: number;
}

interface ProbeOutcome {
	observed: ProbeObservation[];
	/** Every `tool_execution_end` payload, so a refusal shows up as its own text. */
	toolResultTexts: string[];
	spendMessages: string[];
}

/** Drive one scripted `spend_probe` call through a live yolo-mode session. */
async function runProbe(run: ProbeRun): Promise<ProbeOutcome> {
	const tempDir = TempDir.createSync("veyyon-stale-vault-lane-");
	// Distinct directories per scope: the vault refuses to let one file stand for two authenticated
	// scopes, so pointing all three at one temp dir is rejected.
	const globalConfigRoot = tempDir.join("global");
	const agentDir = tempDir.join("profile");
	const cwd = tempDir.join("project");
	for (const dir of [globalConfigRoot, agentDir, cwd]) fs.mkdirSync(dir, { recursive: true });

	// The session resolves its vault from exactly these three inputs, so storing through the same
	// arithmetic is what makes the entry visible to the session that has to expand it.
	const vault = new SecretVault(resolveVaultLocations({ globalConfigRoot, agentDir, cwd }));
	for (const secret of run.seed) {
		await vault.add({
			name: secret.name,
			value: secret.value,
			scope: "profile",
			ttl: secret.ttlMs ?? null,
		});
	}

	// Both spies go in BEFORE the session, and only start answering differently once it is up.
	// `SecretObfuscator` captures the `Date.now` reference at construction, and the startup load has
	// to capture a real fingerprint for the live one to be able to disagree with it.
	const realNow = Date.now;
	let clockOffsetMs = 0;
	const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => realNow() + clockOffsetMs);
	const realRevision = SecretVault.prototype.revision;
	let revisionAnswer: (() => string) | undefined;
	const revisionSpy = vi.spyOn(SecretVault.prototype, "revision").mockImplementation(function (
		this: SecretVault,
	): string {
		return revisionAnswer === undefined ? realRevision.call(this) : revisionAnswer();
	});

	const authStorage = await AuthStorage.create(path.join(agentDir, "auth.db"));
	authStorage.setRuntimeApiKey("mock", "mock-key");
	registerMockApi(MOCK_API_SOURCE);
	const observed: ProbeObservation[] = [];
	const toolResultTexts: string[] = [];
	const spendMessages: string[] = [];
	const { session } = await createAgentSession({
		cwd,
		agentDir,
		globalConfigRoot,
		authStorage,
		modelRegistry: new ModelRegistry(authStorage, path.join(agentDir, "models.yml")),
		sessionManager: SessionManager.inMemory(cwd),
		settings: Settings.isolated({
			"secrets.enabled": true,
			// The row with no approval prompt, so nothing but the codec can refuse the call.
			"tools.approvalMode": "yolo",
			"secrets.auditLog": false,
			"compaction.enabled": false,
		}),
		model: createMockModel({
			responses: [
				{ content: [{ type: "toolCall", name: "spend_probe", arguments: { note: run.note } }] },
				{ content: ["done"] },
			],
		}),
		disableExtensionDiscovery: true,
		extensions: [
			pi => {
				// Read tier, so nothing but a credential could ever make this call prompt.
				pi.registerTool({
					name: "spend_probe",
					label: "Spend Probe",
					description: "Reports whether its argument arrived expanded.",
					parameters: type({ note: "string" }),
					approval: "read",
					async execute(_toolCallId, params) {
						observed.push({
							sawRotatedValue: params.note.includes(ROTATED_VALUE),
							sawStartupValue: params.note.includes(ORIGINAL_VALUE),
							verbatim: params.note === run.note,
						});
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
		if (event.type === "notice" && event.source === SECRET_SPEND_NOTICE_SOURCE) spendMessages.push(event.message);
		if (event.type !== "tool_execution_end") return;
		for (const block of event.result.content) {
			if (block.type === "text") toolResultTexts.push(block.text);
		}
	});
	try {
		if (run.rotate === true) {
			await vault.add({ name: LIVE_NAME, value: ROTATED_VALUE, scope: "profile", ttl: null });
		}
		if (run.advanceClockMs !== undefined) clockOffsetMs = run.advanceClockMs;
		if (run.staleness === "one-external-write") {
			revisionAnswer = () => "external-write-1";
		} else if (run.staleness === "unending-churn") {
			let tick = 0;
			revisionAnswer = () => {
				tick += 1;
				return `unending-churn-${tick}`;
			};
		}
		await session.prompt("call the probe");
		await session.waitForIdle();
	} finally {
		await session.dispose();
		revisionSpy.mockRestore();
		nowSpy.mockRestore();
		unregisterCustomApis(MOCK_API_SOURCE);
		authStorage.close();
		tempDir.removeSync();
	}
	return { observed, toolResultTexts, spendMessages };
}

const liveSecret: SeededSecret[] = [{ name: LIVE_NAME, value: ORIGINAL_VALUE }];

describe("a tool call from a session whose vault revision has moved", () => {
	/**
	 * The reported crash, reduced to its smallest form. The payload has nothing expandable in it, so
	 * `deobfuscate` would return it byte for byte; a stale snapshot cannot possibly answer it wrongly
	 * and must not cost it anything. Regression guarded: gating the freshness check on
	 * `obfuscator.hasSecrets()` (does this SESSION hold a secret) instead of on
	 * `containsLivePlaceholder` (does this TEXT carry one).
	 */
	it("runs a call with no placeholder in it, even while the revision never stops moving", async () => {
		const { observed, toolResultTexts, spendMessages } = await runProbe({
			seed: liveSecret,
			note: 'echo "$HOME"; echo ---; ls -la "$HOME"',
			staleness: "unending-churn",
		});

		expect(observed).toEqual([{ sawRotatedValue: false, sawStartupValue: false, verbatim: true }]);
		expect(toolResultTexts).toEqual(["probed"]);
		expect(spendMessages).toEqual([]);
	});

	/**
	 * The recovery the old guard scheduled and then discarded. One external write moved the vault and
	 * the value behind the name changed with it; the call must reload and expand against the vault as
	 * it is NOW, not refuse and not hand the tool the superseded value. Regression guarded: throwing
	 * on a stale revision, and expanding from the pinned snapshot without reloading.
	 */
	it("reloads and expands a placeholder against the current vault instead of refusing", async () => {
		const { observed, toolResultTexts, spendMessages } = await runProbe({
			seed: liveSecret,
			note: `token=#${LIVE_NAME}#`,
			rotate: true,
			staleness: "one-external-write",
		});

		expect(observed).toEqual([{ sawRotatedValue: true, sawStartupValue: false, verbatim: false }]);
		expect(toolResultTexts).toEqual(["probed"]);
		expect(spendMessages).toEqual([`This spend_probe call spent stored secret ${LIVE_NAME}.`]);
	});

	/**
	 * The fail-closed case that must survive. The payload really does carry a live placeholder and no
	 * reload can reach a revision that stays current, so there is no way to know the value is not
	 * already superseded. Refusing is right; refusing badly is not. The message must tell the operator
	 * what to do and must not blame "another session or process" for what is a failed reload.
	 * Regression guarded: deleting the fail-closed path, and refusing with the old opaque wording.
	 */
	it("refuses a placeholder it cannot resolve against a current vault, and says what to do", async () => {
		const { observed, toolResultTexts, spendMessages } = await runProbe({
			seed: liveSecret,
			note: `token=#${LIVE_NAME}#`,
			staleness: "unending-churn",
		});

		expect(observed).toEqual([]);
		expect(spendMessages).toEqual([]);
		expect(toolResultTexts).toHaveLength(1);
		const refusal = toolResultTexts[0];
		expect(refusal).toContain("Secret expansion was refused");
		expect(refusal).toContain("retry this call");
		expect(refusal).toContain("/secret list");
		expect(refusal).not.toContain("changed in another session or process");
		// A refusal is a failed tool result the model can act on, never a value leak.
		expect(refusal).not.toContain(ORIGINAL_VALUE);
	});

	/**
	 * Expiry is a revocation, not permission to send the old placeholder literally. The name once
	 * represented a credential, so the tool boundary must refuse it even when the vault revision is
	 * moving and the expired value is absent from the substitution map. Regression guarded: leaking
	 * a retired placeholder to the tool because only currently expandable names were considered.
	 */
	it("refuses a call naming an expired secret without exposing its former value", async () => {
		const { observed, toolResultTexts, spendMessages } = await runProbe({
			seed: [...liveSecret, { name: EXPIRING_NAME, value: EXPIRING_VALUE, ttlMs: EXPIRING_TTL_MS }],
			note: `token=#${EXPIRING_NAME}#`,
			advanceClockMs: EXPIRING_TTL_MS * 2,
			staleness: "unending-churn",
		});

		expect(observed).toEqual([]);
		expect(spendMessages).toEqual([]);
		expect(toolResultTexts).toHaveLength(1);
		const refusal = toolResultTexts[0];
		expect(refusal).toContain(`Stored secret #${EXPIRING_NAME}# is no longer available`);
		expect(refusal).toContain("Store the credential again");
		expect(refusal).not.toContain(EXPIRING_VALUE);
	});

	/**
	 * The adversarial half of the same boundary. A placeholder the vault never issued is inert text.
	 * A model can write one at will, so keying the refusal off placeholder SHAPE would hand the model
	 * a way to fail every tool call in a session that holds any secret.
	 */
	it("runs a call naming a placeholder the vault never issued", async () => {
		const { observed, toolResultTexts, spendMessages } = await runProbe({
			seed: liveSecret,
			note: "token=#STALE_LANE_NEVER_STORED#",
			staleness: "unending-churn",
		});

		expect(observed).toEqual([{ sawRotatedValue: false, sawStartupValue: false, verbatim: true }]);
		expect(toolResultTexts).toEqual(["probed"]);
		expect(spendMessages).toEqual([]);
	});

	/**
	 * The control row. Nothing moved, so none of the recovery path is involved and ordinary expansion
	 * still happens. Without this, a change that quietly stopped expanding altogether would still
	 * pass every "no placeholder" row above.
	 */
	it("expands normally when the revision never moved at all", async () => {
		const { observed, toolResultTexts, spendMessages } = await runProbe({
			seed: liveSecret,
			note: `token=#${LIVE_NAME}#`,
			staleness: "settled",
		});

		expect(observed).toEqual([{ sawRotatedValue: false, sawStartupValue: true, verbatim: false }]);
		expect(toolResultTexts).toEqual(["probed"]);
		expect(spendMessages).toEqual([`This spend_probe call spent stored secret ${LIVE_NAME}.`]);
	});
});
