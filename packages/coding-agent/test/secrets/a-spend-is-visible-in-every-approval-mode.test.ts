/**
 * Spending a credential is an operator-visible event in EVERY approval mode, including yolo.
 *
 * THE GAP. Expansion is audited (`secrets.auditLog`) and, outside yolo, gated (the secret-use
 * boundary). Neither of those puts anything on screen while the spend happens: the log is a file
 * read afterwards, and the boundary is deliberately skipped when `approvalMode === "yolo"` or the
 * `/yolo` bypass is on. yolo is the mode most likely to be running unattended, so it was exactly
 * the configuration in which a stored credential could leave the vault
 * into a live command with no signal at all. The transcript showed the `#GITHUB_TOKEN#` placeholder
 * only when the tool's renderer happened to print the argument it sat in — a `bash` command yes, a
 * `write` body or a nested `env` entry no — and even then an expanded placeholder looked identical
 * to one that was merely mentioned and passed through as inert text.
 *
 * WHAT THIS SUITE HOLDS. Four things, because the fix has four separable contracts:
 *
 *   1. `secretSpendMarker` builds the line, driven by a REAL `SecretObfuscator` so
 *      `knowsPlaceholder` is the production predicate. The exact sentence is pinned, because an
 *      operator reads it; so is silence on a call that spends nothing and on a placeholder the
 *      vault never issued.
 *   2. The per-mode matrix through the REAL `ExtensionToolWrapper`, one mode per test: what the
 *      approval gate does, and that the transcript line is there either way. Before the fix, the
 *      yolo/bypass rows had an empty second column, which is the regression.
 *   3. The interactive renderer, through the REAL `EventController`: a spend gets its own transcript
 *      block. `showStatus` COALESCES consecutive status lines, and one assistant message can issue
 *      several tool calls whose blocks are all in the transcript before the first one executes — so
 *      nothing is appended between two spends and the second line would have overwritten the first.
 *      Three credentials spent, one named, is not a signal.
 *   4. The seam itself, in a LIVE session: `createAgentSession`, a real vault on disk, a scripted
 *      model issuing one tool call, and a registered tool that reports whether the credential
 *      actually arrived. The first three suites all stay green if `sdk.ts` stops calling the marker,
 *      calls it after expansion (nothing left to name), or drops the `emitNotice`.
 *
 * THE VALUE IS NEVER IN ANY OF IT. Names are read out of placeholder bodies, never out of anything
 * that has been through expansion, and an unnamed secret's HMAC body is counted rather than printed.
 * Two tests assert that directly rather than trusting the construction.
 */
import { beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentTool } from "@veyyon/agent-core";
import type { AssistantMessage } from "@veyyon/ai";
import { unregisterCustomApis } from "@veyyon/ai/api-registry";
import { createMockModel, type MockResponse, registerMockApi } from "@veyyon/ai/providers/mock";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { ExtensionRunner } from "@veyyon/coding-agent/extensibility/extensions/runner";
import { ExtensionToolWrapper } from "@veyyon/coding-agent/extensibility/extensions/wrapper";
import { EventController } from "@veyyon/coding-agent/modes/controllers/event-controller";
import { type PrintModeSession, runPrintMode } from "@veyyon/coding-agent/modes/print-mode";
import { initTheme, theme } from "@veyyon/coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@veyyon/coding-agent/modes/types";
import { createAgentSession, type ExtensionFactory } from "@veyyon/coding-agent/sdk";
import { SECRET_SPEND_NOTICE_SOURCE } from "@veyyon/coding-agent/secrets/notices";
import { SecretObfuscator } from "@veyyon/coding-agent/secrets/obfuscator";
import { secretSpendMarker } from "@veyyon/coding-agent/secrets/spend-marker";
import { resolveVaultLocations, SecretVault } from "@veyyon/coding-agent/secrets/vault";
import type { AgentSession, AgentSessionEvent } from "@veyyon/coding-agent/session/agent-session";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { Text } from "@veyyon/tui";
import { TempDir } from "@veyyon/utils";
import { type } from "arktype";

// The transcript-block assertions compare against `theme.fg("dim", …)`, so the palette has to be
// resolved before any of them run.
beforeAll(async () => {
	await initTheme(false);
});

/** Fixed so the unnamed placeholder is byte-stable across runs of this file. */
const PLACEHOLDER_KEY = new Uint8Array(32).fill(21);

const GITHUB_VALUE = "ghp_spendmarkerfirstcredential123456";
const OPENAI_VALUE = "sk-spendmarkersecondcredential7890ab";
const UNNAMED_VALUE = "spend-marker-unnamed-credential-4242";

/** Every value this file puts in front of the marker, for the "no value anywhere" assertions. */
const ALL_VALUES = [GITHUB_VALUE, OPENAI_VALUE, UNNAMED_VALUE];

/**
 * The obfuscator the session would hold: two named entries and one unnamed value.
 *
 * Built per test rather than shared, so a test that expires or forgets an entry cannot leak into
 * the next one.
 */
function liveObfuscator(): SecretObfuscator {
	return new SecretObfuscator(
		[
			{ type: "plain", origin: "config", content: GITHUB_VALUE, name: "GITHUB_TOKEN" },
			{ type: "plain", origin: "config", content: OPENAI_VALUE, name: "OPENAI_KEY" },
			{ type: "plain", origin: "config", content: UNNAMED_VALUE },
		],
		{ placeholderKey: PLACEHOLDER_KEY },
	);
}

/** The marker for `args`, through the same predicate `sdk.ts` passes at the expansion call site. */
function markerFor(args: unknown, tool = "bash"): string | undefined {
	const obfuscator = liveObfuscator();
	return secretSpendMarker(args, tool, placeholder => obfuscator.knowsPlaceholder(placeholder));
}

/** The opaque placeholder the obfuscator minted for the unnamed value. */
function unnamedPlaceholder(): string {
	return liveObfuscator().obfuscate(UNNAMED_VALUE);
}

describe("the transcript line a spend produces", () => {
	/**
	 * The central case. A credential in a shell command the model assembled is named, in a sentence
	 * an operator can act on, and the sentence says which tool is spending it.
	 */
	it("names the secret and the tool that spent it", () => {
		expect(markerFor({ command: "curl -H 'Authorization: Bearer #GITHUB_TOKEN#' https://api.github.com" })).toBe(
			"This bash call spent stored secret GITHUB_TOKEN.",
		);
	});

	/**
	 * Two credentials in one call are both named, sorted rather than in encounter order, so repeated
	 * spends of the same pair read identically instead of shuffling with the model's phrasing.
	 */
	it("names every secret in one call once, in a stable order", () => {
		expect(markerFor({ command: "deploy --key #OPENAI_KEY# --token #GITHUB_TOKEN# --token #GITHUB_TOKEN#" })).toBe(
			"This bash call spent stored secrets GITHUB_TOKEN, OPENAI_KEY.",
		);
	});

	/**
	 * An unnamed secret is counted, not printed. Its placeholder body is an HMAC of the value: it
	 * means nothing to a human and it is a stable fingerprint of the credential, so the line counts
	 * it exactly the way the approval prompt does.
	 */
	it("counts an unnamed secret instead of printing its placeholder body", () => {
		const placeholder = unnamedPlaceholder();
		const marker = markerFor({ command: `deploy --token ${placeholder}` });

		expect(marker).toBe("This bash call spent one unnamed secret.");
		expect(marker).not.toContain(placeholder.slice(1, -1));
	});

	/** Named and unnamed in one call keep the approval prompt's "X and one unnamed secret" shape. */
	it("names what it can and counts what it cannot", () => {
		expect(markerFor({ command: `deploy --a #GITHUB_TOKEN# --b ${unnamedPlaceholder()}` })).toBe(
			"This bash call spent stored secret GITHUB_TOKEN and one unnamed secret.",
		);
	});

	/**
	 * THE NEGATIVE THAT KEEPS THE SIGNAL WORTH READING. An ordinary call must produce nothing at
	 * all. A marker on every tool call would be trained out of an operator's attention within a
	 * session, which is the same failure as no marker.
	 */
	it("produces no marker for a call that spends nothing", () => {
		expect(markerFor({ command: "ls -la" })).toBeUndefined();
	});

	/**
	 * THE SECOND NEGATIVE. A placeholder-shaped token the vault never issued is passed through to
	 * the tool as inert text; nothing is substituted and nothing is spent. Marking it would make the
	 * signal a liar in the one direction that costs the most: an operator who has seen one false
	 * "credential spent" stops believing the next one.
	 */
	it("produces no marker for a placeholder the vault never issued", () => {
		expect(markerFor({ command: "echo #HELLO_WORLD# > note.txt" })).toBeUndefined();
	});

	/**
	 * The case the transcript could never show by itself. A credential nested in an argument no
	 * renderer prints — a `write` body, a header map, an `env` entry — was invisible even when the
	 * placeholder was right there in the recorded arguments.
	 */
	it("marks a secret buried in an argument no renderer prints", () => {
		expect(markerFor({ path: "deploy.sh", content: { env: { AUTH: "Bearer #GITHUB_TOKEN#" } } }, "write")).toBe(
			"This write call spent stored secret GITHUB_TOKEN.",
		);
	});

	/** THE INVARIANT. Whatever else changes about the wording, no part of a value can be in it. */
	it("never puts any part of a credential in the line", () => {
		const marker = markerFor({
			command: `a #GITHUB_TOKEN# b #OPENAI_KEY# c ${unnamedPlaceholder()}`,
		});

		expect(marker).toBe("This bash call spent stored secrets GITHUB_TOKEN, OPENAI_KEY and one unnamed secret.");
		for (const value of ALL_VALUES) {
			expect(marker).not.toContain(value);
			expect(marker).not.toContain(value.slice(0, 12));
		}
	});

	/**
	 * The tool name arrives on the provider's tool call, so it is model-controlled text on its way to
	 * a terminal. Control bytes become visible escapes and the name is bounded, so a pathological
	 * name can neither move the cursor nor push the credential name off the line.
	 */
	it("neutralises and bounds a model-supplied tool name", () => {
		expect(markerFor({ command: "#GITHUB_TOKEN#" }, "ev\u001b[2Jil")).toBe(
			"This ev\\u001B[2Jil call spent stored secret GITHUB_TOKEN.",
		);
		expect(markerFor({ command: "#GITHUB_TOKEN#" }, "T".repeat(200))).toBe(
			`This ${"T".repeat(63)}… call spent stored secret GITHUB_TOKEN.`,
		);
	});
});

/** A tool whose tier auto-approves everywhere, so the ONLY reason to prompt is the credential. */
const probeTool = {
	name: "probe",
	label: "Probe",
	summary: "reads something",
	description: "reads something",
	parameters: type({}),
	approval: "read" as const,
	execute: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
} as unknown as AgentTool;

/** A runner with a UI and no approval handlers, so one `select` call is the whole prompt path. */
function runnerWithUi(select: (prompt: string, choices: string[]) => Promise<string>): ExtensionRunner {
	return {
		hasHandlers: () => false,
		hasUI: () => true,
		getUIContext: () => ({ select }),
		emit: async () => undefined,
		emitToolCall: async () => undefined,
		emitToolResult: async () => undefined,
		createContext: () => ({}),
	} as unknown as ExtensionRunner;
}

/**
 * One call, in its two forms.
 *
 * `asWritten` is what the model emitted and what `sdk.ts` inspects to build the marker, BEFORE
 * expansion. `asExecuted` is the same call after `deobfuscateToolArguments` substituted the value,
 * which is the form the approval gate sees, because the gate runs on the arguments the tool is about
 * to receive. Driving both halves off one pair keeps the matrix describing a single event.
 */
const SPENDING_CALL = {
	asWritten: { command: "curl -H 'Authorization: Bearer #GITHUB_TOKEN#' https://api.github.com" },
	asExecuted: { command: `curl -H 'Authorization: Bearer ${GITHUB_VALUE}' https://api.github.com` },
} as const;

/** The line the operator reads for {@link SPENDING_CALL}, whatever the gate decided. */
const SPEND_LINE = "This bash call spent stored secret GITHUB_TOKEN.";

/** The prompt body the secret-use boundary produces for {@link SPENDING_CALL}. */
const SECRET_PROMPT =
	"## Permission required\n" +
	"**Tool:** `probe`\n" +
	"**Scope:** This call only\n" +
	"**Reason:** This call uses stored secret: GITHUB_TOKEN. Approving it runs the call with the real credential.";

/**
 * Run one approval-mode cell and report both columns of the matrix: the prompt the operator was
 * shown (or `undefined` when the call ran unasked), and the transcript line the spend produced.
 *
 * The prompt half drives the real wrapper, with the session's live redactor in the tool context
 * exactly as `AgentSession` supplies it. The marker half is computed the way `sdk.ts` computes it,
 * from the arguments as the model wrote them.
 */
async function modeCell(
	mode: string,
	options?: { planModeActive?: boolean; bypassAllApprovals?: boolean; autoApprove?: boolean },
): Promise<{ prompt: string | undefined; marker: string | undefined }> {
	const obfuscator = liveObfuscator();
	const prompts: string[] = [];
	const select = async (body: string): Promise<string> => {
		prompts.push(body);
		return "Approve";
	};
	const wrapper = new ExtensionToolWrapper(probeTool, runnerWithUi(select));
	await wrapper.execute("call-1", SPENDING_CALL.asExecuted as never, undefined, undefined, {
		settings: { get: (key: string) => (key === "tools.approvalMode" ? mode : {}) },
		obfuscateProviderText: (text: string) => obfuscator.obfuscate(text),
		sessionManager: { getCwd: () => "/repo", getSessionId: () => "session-1" },
		...options,
	} as never);
	return {
		prompt: prompts[0],
		marker: secretSpendMarker(SPENDING_CALL.asWritten, "bash", p => obfuscator.knowsPlaceholder(p)),
	};
}

describe("what an operator sees per approval mode when a call spends a credential", () => {
	/** `ask`: the boundary prompts, and the prompt names the credential rather than the tool tier. */
	it("asks, naming the credential, in ask mode", async () => {
		expect(await modeCell("ask")).toEqual({ prompt: SECRET_PROMPT, marker: SPEND_LINE });
	});

	/** `auto-edit` auto-approves the read tier, so the credential is the only thing that prompts. */
	it("asks, naming the credential, in auto-edit mode", async () => {
		expect(await modeCell("auto-edit")).toEqual({ prompt: SECRET_PROMPT, marker: SPEND_LINE });
	});

	/** `plan` with a read-tier tool is not a denial, so the same prompt is what the operator gets. */
	it("asks, naming the credential, in plan mode", async () => {
		expect(await modeCell("plan", { planModeActive: true })).toEqual({ prompt: SECRET_PROMPT, marker: SPEND_LINE });
	});

	/** The retired omp names still reach the same gate; an old config is not a silent downgrade. */
	it("asks, naming the credential, under the legacy always-ask and write names", async () => {
		expect(await modeCell("always-ask")).toEqual({ prompt: SECRET_PROMPT, marker: SPEND_LINE });
		expect(await modeCell("write")).toEqual({ prompt: SECRET_PROMPT, marker: SPEND_LINE });
	});

	/**
	 * THE REGRESSION THIS FIX EXISTS FOR. yolo opts out of all permission, deliberately, so it opts
	 * out of the secret-use boundary too — nothing prompts. Before the marker this row had NO second
	 * column: the credential left the vault with the operator shown nothing at all, in the mode most
	 * likely to be running unattended.
	 */
	it("does not ask in yolo mode, and still says what was spent", async () => {
		expect(await modeCell("yolo")).toEqual({ prompt: undefined, marker: SPEND_LINE });
	});

	/** `/yolo` lifts prompts inside a session with a non-yolo configured mode. Same hole, same fill. */
	it("does not ask under the /yolo bypass, and still says what was spent", async () => {
		expect(await modeCell("ask", { bypassAllApprovals: true })).toEqual({ prompt: undefined, marker: SPEND_LINE });
	});

	/** `--yolo` / `--auto-approve` forces yolo before the configured mode is consulted at all. */
	it("does not ask under CLI auto-approve, and still says what was spent", async () => {
		expect(await modeCell("ask", { autoApprove: true })).toEqual({ prompt: undefined, marker: SPEND_LINE });
	});

	/**
	 * A hand-edited typo fails closed to `ask`, so it must not become the silent-spend cell. The
	 * config check warns about the typo separately; what matters here is that the credential still
	 * asks.
	 */
	it("asks, naming the credential, when the configured mode is a typo", async () => {
		expect(await modeCell("yoloo")).toEqual({ prompt: SECRET_PROMPT, marker: SPEND_LINE });
	});
});

/** The controller members `#handleNotice` reaches, plus the three surfaces it can route to. */
function noticeContext() {
	const present = vi.fn();
	const showStatus = vi.fn();
	const showWarning = vi.fn();
	const showError = vi.fn();
	const ctx = {
		isInitialized: true,
		init: vi.fn(async () => {}),
		ui: { requestRender: vi.fn() },
		pendingTools: new Map(),
		statusLine: { invalidate: vi.fn(), markActivityStart: vi.fn() },
		viewSession: { isStreaming: false },
		present,
		showStatus,
		showWarning,
		showError,
		refreshComposerShortcuts: vi.fn(),
		dismissWelcome: vi.fn(),
	} as unknown as InteractiveModeContext;
	return { ctx, present, showStatus, showWarning, showError };
}

function spendNotice(message: string): Extract<AgentSessionEvent, { type: "notice" }> {
	return { type: "notice", level: "info", message, source: SECRET_SPEND_NOTICE_SOURCE };
}

/** The `Text` child of a presented block, so the assertion is on the bytes the terminal receives. */
function presentedText(call: unknown): string {
	const block = call as Array<{ getText?: () => string }>;
	const text = block.find((child): child is Text => child instanceof Text);
	if (!text) throw new Error("presented block carried no Text child");
	return text.getText();
}

describe("the interactive transcript block a spend becomes", () => {
	/**
	 * The line reaches the transcript byte for byte, dim, with no `source: ` prefix bolted on: the
	 * marker is already a sentence, and `secret-spend: This bash call spent …` reads as debug output
	 * rather than as something addressed to the operator.
	 */
	it("presents the spend as its own dim transcript block", async () => {
		const { ctx, present, showStatus } = noticeContext();

		await new EventController(ctx).handleEvent(spendNotice(SPEND_LINE));

		expect(present).toHaveBeenCalledTimes(1);
		expect(presentedText(present.mock.calls[0]![0])).toBe(theme.fg("dim", SPEND_LINE));
		expect(showStatus).not.toHaveBeenCalled();
	});

	/**
	 * THE COALESCING REGRESSION. `showStatus` replaces the previous status line when nothing was
	 * appended between the two, and nothing IS appended between two spends in one assistant message:
	 * every tool block was created while the arguments streamed, before the first call executed. On
	 * that path the second spend overwrote the first, so two credentials spent showed one name.
	 */
	it("gives each of two consecutive spends its own block", async () => {
		const { ctx, present } = noticeContext();
		const controller = new EventController(ctx);
		const second = "This fetch call spent stored secret OPENAI_KEY.";

		await controller.handleEvent(spendNotice(SPEND_LINE));
		await controller.handleEvent(spendNotice(second));

		expect(present).toHaveBeenCalledTimes(2);
		expect(presentedText(present.mock.calls[0]![0])).toBe(theme.fg("dim", SPEND_LINE));
		expect(presentedText(present.mock.calls[1]![0])).toBe(theme.fg("dim", second));
	});

	/**
	 * The spend branch is keyed on its own notice source, so the vault's own `secrets` warnings keep
	 * the surface they had. Widening the branch to every secrets notice would have moved key-mode and
	 * superseded-binding warnings off the warning surface and dimmed them into the transcript.
	 */
	it("leaves an ordinary secrets warning on the warning surface", async () => {
		const { ctx, present, showWarning } = noticeContext();

		await new EventController(ctx).handleEvent({
			type: "notice",
			level: "warning",
			message: "Your profile vault was re-sealed.",
			source: "secrets",
		});

		expect(present).not.toHaveBeenCalled();
		expect(showWarning).toHaveBeenCalledWith("secrets: Your profile vault was re-sealed.");
	});
});

/**
 * The one call site, in a live session.
 *
 * The three suites above each hold one end of the wire: the marker builds the line, the wrapper
 * decides the gate, the controller draws the block. None of them proves the thing that makes the
 * feature exist — that `transformToolCallArguments` in `sdk.ts` calls the marker at the expansion
 * point, with the session's own obfuscator, and emits it on the session. A refactor that moved the
 * expansion into another hook, reordered the marker after `deobfuscateToolArguments` (leaving
 * nothing to name), or dropped the `session?.emitNotice` line would leave all three green.
 *
 * So this drives the real thing: a real vault on disk, `createAgentSession`, a scripted model that
 * issues one tool call, and a registered tool that reports whether the credential actually arrived.
 * The mode is yolo, because that is the row the fix was written for — no approval prompt happens,
 * and the notice is the only signal in existence.
 */
const E2E_SECRET_NAME = "E2E_SPEND_TOKEN";
const E2E_SECRET_VALUE = "ghp_e2espendtokenvalue0123456789ab";
const E2E_MOCK_API_SOURCE = "secret-spend-visibility-e2e";

/**
 * What the tool saw, as two booleans. The credential never leaves `execute`, so a failure here
 * prints `false`, not a value.
 */
interface ProbeObservation {
	/** The real credential arrived in the argument, i.e. expansion happened. */
	expanded: boolean;
	/** The argument arrived exactly as the model wrote it, i.e. nothing was substituted. */
	verbatim: boolean;
}

/** What the probe compares its argument against. */
interface ProbeExpectation {
	/** The credential whose arrival proves expansion happened. */
	credential: string;
	/** The argument exactly as the model wrote it, so "nothing was substituted" is checkable. */
	written: string;
}

/** A read-tier tool, so nothing but a credential could ever make this call prompt. */
function probeExtension(observed: ProbeObservation[], expected: ProbeExpectation): ExtensionFactory {
	return pi => {
		pi.registerTool({
			name: "spend_probe",
			label: "Spend Probe",
			description: "Reports whether its argument arrived expanded.",
			parameters: type({ note: "string" }),
			approval: "read",
			async execute(_toolCallId, params) {
				observed.push({
					expanded: params.note.includes(expected.credential),
					verbatim: params.note === expected.written,
				});
				return { content: [{ type: "text", text: "probed" }] };
			},
		});
	};
}

/** Everything one live run is asked about afterwards. */
interface ProbeRun {
	/** Every `secret-spend` notice message, in order. */
	spendMessages: string[];
	/** One entry per `spend_probe` call, in order. */
	observed: ProbeObservation[];
	/** Every session event, serialized: the transcript stream a value could leak into. */
	events: string;
	/** The on-disk session file after the run, for the same question about persistence. */
	sessionFile: string;
}

/**
 * A live yolo-mode session over a real vault, handed to `drive`.
 *
 * A REAL session file, not `SessionManager.inMemory`, because "the value never lands on disk" is
 * one of the things worth being able to state. Every event is captured serialized for the same
 * reason: a leak into the transcript would show up as the value inside this string.
 */
async function withProbeSession(options: {
	responses: readonly MockResponse[];
	expected: ProbeExpectation;
	drive: (session: AgentSession, vault: SecretVault) => Promise<void>;
}): Promise<ProbeRun> {
	const tempDir = TempDir.createSync("veyyon-secret-spend-e2e-");
	// Distinct directories per scope: the vault refuses to let one file stand for two authenticated
	// scopes, so pointing `globalConfigRoot`, `agentDir`, and `cwd` at one temp dir is rejected.
	const globalConfigRoot = tempDir.join("global");
	const agentDir = tempDir.join("profile");
	const cwd = tempDir.join("project");
	for (const dir of [globalConfigRoot, agentDir, cwd]) fs.mkdirSync(dir, { recursive: true });

	// The session resolves its vault from exactly these three inputs, so storing through the same
	// arithmetic is what makes the entry visible to the session that has to expand it.
	const vault = new SecretVault(resolveVaultLocations({ globalConfigRoot, agentDir, cwd }));
	await vault.add({ name: E2E_SECRET_NAME, value: E2E_SECRET_VALUE, scope: "profile", ttl: null });

	const authStorage = await AuthStorage.create(path.join(agentDir, "auth.db"));
	authStorage.setRuntimeApiKey("mock", "mock-key");
	registerMockApi(E2E_MOCK_API_SOURCE);
	const sessionManager = SessionManager.create(cwd, tempDir.join("sessions"));
	const observed: ProbeObservation[] = [];
	const spendMessages: string[] = [];
	const events: string[] = [];
	const { session } = await createAgentSession({
		cwd,
		agentDir,
		globalConfigRoot,
		authStorage,
		modelRegistry: new ModelRegistry(authStorage, path.join(agentDir, "models.yml")),
		sessionManager,
		settings: Settings.isolated({
			"secrets.enabled": true,
			// The row with no approval prompt: the notice is the entire operator-visible signal.
			"tools.approvalMode": "yolo",
			// Left at its default `false` on purpose — showing a spend is not gated on recording one.
			"secrets.auditLog": false,
			"compaction.enabled": false,
		}),
		model: createMockModel({ responses: [...options.responses] }),
		disableExtensionDiscovery: true,
		extensions: [probeExtension(observed, options.expected)],
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
		events.push(JSON.stringify(event));
		if (event.type === "notice" && event.source === SECRET_SPEND_NOTICE_SOURCE) spendMessages.push(event.message);
	});
	let sessionFile = "";
	try {
		await options.drive(session, vault);
		sessionManager.flushSync();
		const file = sessionManager.getSessionFile();
		if (typeof file === "string") sessionFile = fs.readFileSync(file, "utf8");
	} finally {
		await session.dispose();
		unregisterCustomApis(E2E_MOCK_API_SOURCE);
		authStorage.close();
		tempDir.removeSync();
	}
	return { spendMessages, observed, events: events.join("\n"), sessionFile };
}

/** One scripted `spend_probe` call in a single turn. */
async function runProbeCall(note: string): Promise<ProbeRun> {
	return await withProbeSession({
		responses: [{ content: [{ type: "toolCall", name: "spend_probe", arguments: { note } }] }, { content: ["done"] }],
		expected: { credential: E2E_SECRET_VALUE, written: note },
		drive: async session => {
			await session.prompt("call the probe");
			await session.waitForIdle();
		},
	});
}

describe("a live session spending a stored credential in yolo mode", () => {
	/**
	 * The whole seam: the expansion hook in `sdk.ts` names the spend on the session's notice
	 * channel, at the moment the credential is substituted, with the vault name the operator stored
	 * it under. Regression guarded: emitting nothing (the original yolo silence), emitting after
	 * expansion (no placeholder left, so the line degrades to naming nothing), or naming the wrong
	 * tool.
	 */
	it("announces the spend by name and hands the tool the real credential", async () => {
		const { spendMessages, observed } = await runProbeCall(`token=#${E2E_SECRET_NAME}#`);

		expect(spendMessages).toEqual([`This spend_probe call spent stored secret ${E2E_SECRET_NAME}.`]);
		expect(observed).toEqual([{ expanded: true, verbatim: false }]);
	});

	/**
	 * A placeholder the vault never issued is inert text, not a spend. Regression guarded: keying the
	 * notice off "the arguments contain something shaped like a placeholder" instead of off the
	 * obfuscator's `knowsPlaceholder`, which would cry credential over a name the model invented.
	 */
	it("says nothing when the call mentions a placeholder the vault never issued", async () => {
		const { spendMessages, observed } = await runProbeCall("token=#NEVER_STORED_TOKEN#");

		expect(spendMessages).toEqual([]);
		expect(observed).toEqual([{ expanded: false, verbatim: true }]);
	});

	/**
	 * The credential reaches the tool and does not reach the transcript ON DISK.
	 *
	 * The scope here is deliberate. Live UI events DO carry expanded arguments, because the operator
	 * has to be able to read the command that is about to run — that is the same display seam headless
	 * mode uses so output shows real values rather than a `#HASH#`. What must never happen is the
	 * credential being written down: the session file is replayed on resume and outlives the process.
	 *
	 * Regression guarded: a spend line built from expanded text rather than placeholder bodies, and
	 * the expansion leaking back into the persisted message so a resumed session replays a credential
	 * instead of re-expanding from the vault.
	 */
	it("writes the placeholder to the session file and never the credential", async () => {
		const { spendMessages, sessionFile, observed } = await runProbeCall(`token=#${E2E_SECRET_NAME}#`);

		expect(observed).toEqual([{ expanded: true, verbatim: false }]);
		expect(sessionFile).not.toContain(E2E_SECRET_VALUE);
		expect(sessionFile).toContain(`#${E2E_SECRET_NAME}#`);
		expect(spendMessages.join("")).not.toContain(E2E_SECRET_VALUE);
	});

	/**
	 * Add, then use, with no restart — the primary workflow.
	 *
	 * A vault write is what the session watches to know its entries went stale, so the two ways this
	 * can break are opposite: the guard at the expansion site refusing a call in the very session
	 * that stored the credential, or the runtime never reloading so the new name stays an unknown
	 * placeholder and is handed to the tool as inert text. `AgentSession.refreshSecrets` is the
	 * reconcile the `/secret` command runs after a write, so the sequence exercised here is the one
	 * an operator performs: store it, then spend it on the next turn.
	 *
	 * Regression guarded: both failure modes above, and the spend going unannounced for a credential
	 * that was not present when the session started.
	 */
	it("spends a credential stored earlier in the same session", async () => {
		const addedName = "ADDED_MID_SESSION";
		const addedValue = "ghp_addedmidsessionvalue0123456789";
		const note = `token=#${addedName}#`;
		const { spendMessages, observed, sessionFile } = await withProbeSession({
			responses: [
				{ content: ["stored"] },
				{ content: [{ type: "toolCall", name: "spend_probe", arguments: { note } }] },
				{ content: ["done"] },
			],
			expected: { credential: addedValue, written: note },
			drive: async (session, vault) => {
				await session.prompt("first turn");
				await session.waitForIdle();
				await vault.add({ name: addedName, value: addedValue, scope: "profile", ttl: null });
				// What the `/secret` command does after a write: reconcile the session's runtime so the
				// new entry is expandable without a restart.
				await session.refreshSecrets();
				await session.prompt("now call the probe");
				await session.waitForIdle();
			},
		});

		expect(spendMessages).toEqual([`This spend_probe call spent stored secret ${addedName}.`]);
		expect(observed).toEqual([{ expanded: true, verbatim: false }]);
		expect(sessionFile).not.toContain(addedValue);
	});
});

/**
 * The headless surface, which had no signal at all.
 *
 * `runPrintMode` subscribes to the session and, before this change, wrote something only when
 * `mode === "json"`. Text mode prints the final assistant message and nothing else, so `-p` under
 * yolo — CI, unattended, the approval boundary skipped by design — was the one configuration where
 * a stored credential reached a live command with nothing on any stream to say so.
 *
 * The line goes to STDERR, not stdout. Text-mode stdout is the answer a caller pipes into something
 * else; `Working...` and error lines already live on stderr. A spend line on stdout would corrupt
 * that contract, which is the other half of what these tests pin.
 */
const PRINT_SPEND_LINE = "This bash call spent stored secret DEPLOY_KEY.";

/** The final answer this session settles on, so stdout has something to be checked against. */
const PRINT_ANSWER = "deployed";

/**
 * A print-mode session that emits `notices` mid-turn, the way the expansion hook does.
 *
 * Typed as `PrintModeSession` with no cast: a stub that lies about the shape is how the surface
 * drifts out from under the test.
 */
function printSessionEmitting(notices: readonly AgentSessionEvent[]): PrintModeSession {
	let listener: ((event: AgentSessionEvent) => void) | undefined;
	const answer: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text: PRINT_ANSWER }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason: "stop",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: 0,
	};
	return {
		state: { messages: [answer] },
		sessionManager: { getHeader: () => undefined },
		extensionRunner: undefined,
		subscribe: handler => {
			listener = handler;
			return () => {
				listener = undefined;
			};
		},
		prompt: async () => {
			// Mid-turn, exactly where a spend happens: the credential is substituted while the tool
			// call is dispatched, not after the answer is printed.
			for (const notice of notices) listener?.(notice);
			return true;
		},
		dispose: async () => {},
		displayAssistantContent: content => content,
		// `--mode json` re-redacts every line through this. Identity: these tests assert
		// that a spend NOTICE reaches a stream in every mode, and the notice names the
		// secret without carrying its value, so there is nothing here to redact back.
		obfuscateProviderText: text => text,
	};
}

/** Run print mode over a captured stdout/stderr pair. */
async function runPrintCapture(
	mode: "text" | "json",
	notices: readonly AgentSessionEvent[],
): Promise<{ stdout: string; stderr: string }> {
	const stdout: string[] = [];
	const stderr: string[] = [];
	const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((...args: unknown[]) => {
		const chunk = args[0];
		if (typeof chunk === "string") stdout.push(chunk);
		// print mode flushes stdout with a callback before returning.
		const last = args[args.length - 1];
		if (typeof last === "function") (last as () => void)();
		return true;
	});
	const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
		stderr.push(String(chunk));
		return true;
	});
	try {
		await runPrintMode(printSessionEmitting(notices), { mode, initialMessage: "deploy it" });
	} finally {
		stdoutSpy.mockRestore();
		stderrSpy.mockRestore();
	}
	return { stdout: stdout.join(""), stderr: stderr.join("") };
}

describe("a spend in headless print mode", () => {
	/**
	 * Regression guarded: text mode emitting nothing for a spend, which is what shipped — the
	 * subscriber wrote output only under `mode === "json"`, so `-p` plus yolo spent credentials
	 * silently. The line lands on stderr and stdout stays exactly the answer, so a caller piping
	 * stdout still gets only the answer.
	 */
	it("writes the spend to stderr and leaves stdout as the answer alone", async () => {
		const { stdout, stderr } = await runPrintCapture("text", [spendNotice(PRINT_SPEND_LINE)]);

		expect(stderr).toBe(`Working...\n${PRINT_SPEND_LINE}\n`);
		expect(stdout).toBe(`${PRINT_ANSWER}\n`);
	});

	/**
	 * Only a spend earns the stderr line. Regression guarded: routing every notice to stderr in text
	 * mode, which would turn each vault-expiry and re-seal warning into headless output that was
	 * never there before and would swamp the one line that matters.
	 */
	it("leaves an ordinary secrets warning off both streams in text mode", async () => {
		const { stdout, stderr } = await runPrintCapture("text", [
			{ type: "notice", level: "warning", message: "DEPLOY_KEY expires in 2h.", source: "secrets" },
		]);

		expect(stderr).toBe("Working...\n");
		expect(stdout).toBe(`${PRINT_ANSWER}\n`);
	});

	/**
	 * JSON mode already carried every event and MUST keep doing so on stdout. Regression guarded: the
	 * early `return` added for the text branch swallowing the json write, or json mode also picking up
	 * the stderr line and double-reporting one spend.
	 */
	it("keeps the spend on the json event stream and off stderr", async () => {
		const { stdout, stderr } = await runPrintCapture("json", [spendNotice(PRINT_SPEND_LINE)]);

		const events = stdout
			.split("\n")
			.filter(line => line.length > 0)
			.map(line => JSON.parse(line) as Record<string, unknown>);
		expect(events).toContainEqual({
			type: "notice",
			level: "info",
			message: PRINT_SPEND_LINE,
			source: SECRET_SPEND_NOTICE_SOURCE,
		});
		expect(stderr).toBe("");
	});
});
