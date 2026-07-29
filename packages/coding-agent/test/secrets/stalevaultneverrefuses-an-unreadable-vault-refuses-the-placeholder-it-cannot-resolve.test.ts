/**
 * A vault scope that cannot be read must not let a placeholder through as literal text.
 *
 * THE BUG THIS LOCKS OUT. Making an unparseable vault non-fatal to launch (`load()` skips the
 * unreadable scope with a notice instead of throwing, so the operator can still reach `/secret`
 * to repair it) opened a fail-OPEN hole at the spend seam, and every existing guard waves it
 * through:
 *
 *   - `revision()` fingerprints file STATS and never parses, so a CORRUPT file's revision matches
 *     the captured one exactly and all three freshness conditions are satisfied.
 *   - `containsLivePlaceholder` is false, because the obfuscator never learned the name the
 *     unreadable file held.
 *   - `hasSecrets()` is false too when the broken scope was the only source, which skips the rest
 *     of the spend seam outright.
 *
 * So `#TOKEN#` was passed through verbatim and the tool RAN, with the literal seven characters
 * `#TOKEN#` sitting where a credential belongs. That is worse than the startup crash it replaced,
 * in the one way that counts: a dead TUI is loud, and a command that quietly executes against a
 * live endpoint with a placeholder for its credential is not.
 *
 * THE RULE, AND WHY IT CANNOT BE NAME-SPECIFIC. An unparseable vault never says which names it
 * held, so there is no list to check a token against. The only sound formulation is that while ANY
 * scope is unreadable, a placeholder-shaped token that does not resolve is refused rather than
 * passed through. This is the FOURTH refusal condition, alongside the three that govern staleness.
 *
 * WHAT BREAKS IF THIS REGRESSES. A corrupt vault stops being a loud, repairable problem and becomes
 * a silent one: commands run with placeholder text as credentials. Do NOT make a failure here pass
 * by widening the refusal to every unknown token. The healthy-vault rows below are the other half
 * of the contract: with every scope readable, an unknown `#WORD#` must behave exactly as it does
 * today, or every session without a vault starts refusing ordinary text.
 *
 * WHY THIS IS END TO END. The guard has to hold at the one seam that actually expands,
 * `transformToolCallArguments` in `sdk.ts`, and specifically OUTSIDE its `hasSecrets()` gate. A
 * unit test on the vault or the obfuscator stays green while that call site keeps asking the
 * session-wide question, which is precisely the bug.
 *
 * NO VALUE IS EVER RECORDED. The probe reports booleans, so a failing expectation prints `false`,
 * never a credential.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { unregisterCustomApis } from "@veyyon/ai/api-registry";
import { createMockModel, registerMockApi } from "@veyyon/ai/providers/mock";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { createAgentSession } from "@veyyon/coding-agent/sdk";
import { resolveVaultLocations, SecretVault } from "@veyyon/coding-agent/secrets/vault";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { TempDir } from "@veyyon/utils";
import { type } from "arktype";
import { makeScopeUnreadable } from "./stalevaultneverrefuses-corrupt-vault-fixture";

const MOCK_API_SOURCE = "unreadable-vault-refuses-orphan";

const PROFILE_NAME = "CORRUPT_LANE_TOKEN";
const PROFILE_VALUE = "ghp_corruptlaneprofilecredential01";
const GLOBAL_NAME = "CORRUPT_LANE_GLOBAL";
const GLOBAL_VALUE = "ghp_corruptlaneglobalcredential002";

/**
 * A marker only the unreadable file could have contributed, used to assert the refusal never
 * echoes vault bytes. The corruption itself comes from the shared fixture, which seals genuinely
 * non-JSON plaintext so the file clears every provenance and integrity check and fails at parse.
 */
const VAULT_BYTE_MARKER = "this decrypted cleanly and is not json";

interface ProbeObservation {
	/** The profile-scope value arrived, i.e. the unreadable scope somehow still expanded. */
	sawProfileValue: boolean;
	/** The global-scope value arrived, i.e. a healthy scope expanded normally. */
	sawGlobalValue: boolean;
	/** The argument arrived exactly as written, i.e. nothing was substituted. */
	verbatim: boolean;
}

interface ProbeRun {
	/** The argument the scripted model writes, before expansion. */
	note: string;
	/** Overwrite the profile vault with unparseable bytes before the session starts. */
	corruptProfileScope: boolean;
	/** Also seed a readable secret in the global scope, to prove one bad scope is not all of them. */
	seedGlobal?: boolean;
}

interface ProbeOutcome {
	observed: ProbeObservation[];
	/** Every `tool_execution_end` payload, so a refusal shows up as its own text. */
	toolResultTexts: string[];
}

/** Drive one scripted `spend_probe` call through a live yolo-mode session. */
async function runProbe(run: ProbeRun): Promise<ProbeOutcome> {
	const tempDir = TempDir.createSync("veyyon-corrupt-vault-lane-");
	// Distinct directories per scope: the vault refuses to let one file stand for two authenticated
	// scopes, so pointing all three at one temp dir is rejected.
	const globalConfigRoot = tempDir.join("global");
	const agentDir = tempDir.join("profile");
	const cwd = tempDir.join("project");
	for (const dir of [globalConfigRoot, agentDir, cwd]) fs.mkdirSync(dir, { recursive: true });

	const locations = resolveVaultLocations({ globalConfigRoot, agentDir, cwd });
	const vault = new SecretVault(locations);
	await vault.add({ name: PROFILE_NAME, value: PROFILE_VALUE, scope: "profile", ttl: null });
	if (run.seedGlobal === true) {
		await vault.add({ name: GLOBAL_NAME, value: GLOBAL_VALUE, scope: "global", ttl: null });
	}
	// The one failure `load()` may skip. Raw invalid JSON now refuses at startup, which is the
	// security suite's contract, so this must not borrow that input.
	if (run.corruptProfileScope) await makeScopeUnreadable(locations, "profile");

	const authStorage = await AuthStorage.create(path.join(agentDir, "auth.db"));
	authStorage.setRuntimeApiKey("mock", "mock-key");
	registerMockApi(MOCK_API_SOURCE);
	const observed: ProbeObservation[] = [];
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
							sawProfileValue: params.note.includes(PROFILE_VALUE),
							sawGlobalValue: params.note.includes(GLOBAL_VALUE),
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
		if (event.type !== "tool_execution_end") return;
		for (const block of event.result.content) {
			if (block.type === "text") toolResultTexts.push(block.text);
		}
	});
	try {
		await session.prompt("call the probe");
		await session.waitForIdle();
	} finally {
		await session.dispose();
		unregisterCustomApis(MOCK_API_SOURCE);
		authStorage.close();
		tempDir.removeSync();
	}
	return { observed, toolResultTexts };
}

describe("a tool call spending a placeholder while a vault scope cannot be read", () => {
	it("refuses the placeholder it cannot resolve, and does not run the tool", async () => {
		const { observed, toolResultTexts } = await runProbe({
			note: `deploy with #${PROFILE_NAME}#`,
			corruptProfileScope: true,
		});

		// The whole point: the command must NOT execute with `#CORRUPT_LANE_TOKEN#` as its credential.
		expect(observed).toEqual([]);
		expect(toolResultTexts.join("\n")).toContain("refused");
	});

	it("names the repair and never prints the unreadable file's bytes", async () => {
		const { toolResultTexts } = await runProbe({
			note: `deploy with #${PROFILE_NAME}#`,
			corruptProfileScope: true,
		});
		const refusal = toolResultTexts.join("\n");

		expect(refusal).toContain("vault could not be read");
		// The repair has to be COPY-PASTEABLE, so the scope is interpolated rather than left as a
		// placeholder for the operator to substitute. `discard` moves the file aside and does not
		// re-add anything, so naming it alone would leave the operator halfway.
		expect(refusal).toContain("/secret discard --scope profile");
		expect(refusal).toContain("/secret add");
		// A corrupt vault is attacker-influenced input. Echoing it into a tool result would put
		// whatever it contains in front of the model and into the transcript.
		expect(refusal).not.toContain(VAULT_BYTE_MARKER);
	});

	it("still runs a call that carries no placeholder-shaped token at all", async () => {
		const { observed } = await runProbe({
			note: "list the deployments",
			corruptProfileScope: true,
		});

		// A broken vault must not turn into a session-wide refusal. This is the same mistake the
		// staleness guard made, and it is the reason ordinary work became impossible.
		expect(observed).toEqual([{ sawProfileValue: false, sawGlobalValue: false, verbatim: true }]);
	});

	it("still expands a placeholder that a healthy scope can resolve", async () => {
		const { observed } = await runProbe({
			note: `deploy with #${GLOBAL_NAME}#`,
			corruptProfileScope: true,
			seedGlobal: true,
		});

		// One unreadable scope is not all of them. A token the surviving scopes DO resolve is a
		// normal spend and must behave like one.
		expect(observed).toEqual([{ sawProfileValue: false, sawGlobalValue: true, verbatim: false }]);
	});

	it("does not refuse an unknown placeholder-shaped token while every scope is readable", async () => {
		const { observed } = await runProbe({
			note: "deploy with #NOSUCHTOKEN#",
			corruptProfileScope: false,
		});

		// The adversarial case for a fail-closed guard is over-triggering. With a healthy vault an
		// unknown token is just text, exactly as it is today, and widening this would break every
		// session that mentions a `#WORD#` in passing.
		expect(observed).toEqual([{ sawProfileValue: false, sawGlobalValue: false, verbatim: true }]);
	});
});
