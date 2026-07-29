/**
 * The events a UI draws a tool call from must carry the placeholder, never the expanded credential.
 *
 * THE BUG, AS REPORTED. A bash tool-call card in the TUI rendered `printf %s "stress-stale-live-…"`
 * — the live credential — while the echoed prompt above it still said `#STRESS_STALE#`. The same
 * expansion reached `--mode json` on stdout. Neither was a renderer bug: `transformToolCallArguments`
 * ran once and the loop forwarded the SAME object to `tool.execute` and to `tool_execution_start`,
 * and `tool_execution_start` is the event a renderer treats as authoritative ("arguments are final,
 * reconcile them"). Every present and future display was therefore handed a credential by default,
 * and each one had to remember to redact it. One forgot.
 *
 * THE FIX THIS PINS. The transform returns two forms and the loop routes them by audience:
 * `execution` to `tool.execute` and `beforeToolCall`, `display` to `tool_execution_start`,
 * `tool_execution_update`, the telemetry span and the recorded arguments. In `sdk.ts` the secret
 * expansion writes `execution` only. Argot handle expansion writes both, because a person must
 * never be shown a raw `§handle` — the two rewrites want opposite things from a display, which is
 * why one shared form could not serve both.
 *
 * WHY THIS SUITE IS END TO END AND SINK-AGNOSTIC. A unit test on the transform proves the split in
 * isolation and stays green if `sdk.ts` puts the expansion on the wrong field. So this drives a real
 * vault on disk, `createAgentSession`, a scripted model issuing one tool call and a registered tool
 * that reports what actually arrived. The central assertion sweeps EVERY event the session emits
 * rather than naming the two a UI happens to read today: a card, a JSON line, an HTML export and a
 * subagent HUD all reconcile from this stream, so proving the value is absent from all of it covers
 * the sinks that exist and the ones added later.
 *
 * Run in yolo mode deliberately. The secret-use boundary is skipped there by design, so this is the
 * configuration most likely to be running unattended and the one where a leaked value is least
 * likely to be noticed.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
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

const MOCK_API_SOURCE = "rendered-tool-call-never-shows-a-credential";
const SECRET_NAME = "PROBE_TOKEN";
const PLACEHOLDER = `#${SECRET_NAME}#`;
/** Synthetic throughout: no real credential is ever seeded, printed or asserted on. */
const SECRET_VALUE = "probe-token-live-3f19c6";

interface Drive {
	/** The `note` each tool invocation actually received. */
	executed: string[];
	/** Every event the session emitted, serialized the way a sink would consume it. */
	events: { type: string; json: string }[];
	/** The `args` of the first `tool_execution_start`, as a display would read them. */
	startArgs: string | undefined;
	/** The `args` of the first `tool_execution_update`, the streaming half of the same card. */
	updateArgs: string | undefined;
	/** Per provider request, whether it carried the value and whether it carried the placeholder. */
	providerTurns: { carriesValue: boolean; carriesPlaceholder: boolean }[];
}

/**
 * Every location in the event stream holding `needle`, as `type.dotted.path`. A failure has to name
 * the FIELD, not just the event: "the credential is somewhere in `agent_end`" sends the next person
 * hunting through a whole transcript, and printing the offending event would put the value in the
 * test output — the exact thing being prevented.
 */
function leakPaths(events: { type: string; json: string }[], needle: string): string[] {
	const found: string[] = [];
	const walk = (node: unknown, at: string): void => {
		if (typeof node === "string") {
			if (node.includes(needle)) found.push(at);
			return;
		}
		if (Array.isArray(node)) {
			for (const [index, item] of node.entries()) walk(item, `${at}[${index}]`);
			return;
		}
		if (node !== null && typeof node === "object") {
			for (const [key, value] of Object.entries(node)) walk(value, `${at}.${key}`);
		}
	};
	for (const event of events) {
		if (!event.json.includes(needle)) continue;
		walk(JSON.parse(event.json), event.type);
	}
	return [...new Set(found)];
}

async function drive(note: string): Promise<Drive> {
	const tempDir = TempDir.createSync("veyyon-rendered-card-");
	// Distinct directories per scope: the vault refuses to let one file stand for two authenticated
	// scopes, so pointing all three at one temp dir is rejected.
	const globalConfigRoot = tempDir.join("global");
	const agentDir = tempDir.join("profile");
	const cwd = tempDir.join("project");
	for (const dir of [globalConfigRoot, agentDir, cwd]) fs.mkdirSync(dir, { recursive: true });

	const vault = new SecretVault(resolveVaultLocations({ globalConfigRoot, agentDir, cwd }));
	await vault.add({
		name: SECRET_NAME,
		value: SECRET_VALUE,
		scope: "profile",
		ttl: null,
	});

	const authStorage = await AuthStorage.create(path.join(agentDir, "auth.db"));
	authStorage.setRuntimeApiKey("mock", "mock-key");
	registerMockApi(MOCK_API_SOURCE);
	const executed: string[] = [];
	const events: { type: string; json: string }[] = [];
	// Held so the provider requests can be inspected after the run. The mock CANNOT know the
	// credential: it only ever emits the placeholder, which is what makes a value found anywhere
	// downstream proof of a LOCAL substitution rather than something the model was handed.
	const model = createMockModel({
		responses: [
			{ content: [{ type: "toolCall", name: "spend_probe", arguments: { note } }] },
			// Prose naming the placeholder, because `AgentSession` expands placeholders in assistant
			// text for display and that is a separate path from the tool arguments.
			{ content: [`wrote the digest of the ${PLACEHOLDER} secret`] },
		],
	});
	const { session } = await createAgentSession({
		cwd,
		agentDir,
		globalConfigRoot,
		authStorage,
		modelRegistry: new ModelRegistry(authStorage, path.join(agentDir, "models.yml")),
		sessionManager: SessionManager.inMemory(cwd),
		settings: Settings.isolated({
			"secrets.enabled": true,
			"tools.approvalMode": "yolo",
			"secrets.auditLog": false,
			"compaction.enabled": false,
		}),
		model,
		disableExtensionDiscovery: true,
		extensions: [
			pi => {
				// Read tier, so nothing but a credential could make this call prompt, and it streams
				// one update so the incremental half of the card is observable too.
				pi.registerTool({
					name: "spend_probe",
					label: "Spend Probe",
					description: "Reports whether its argument arrived expanded.",
					parameters: type({ note: "string" }),
					approval: "read",
					async execute(_toolCallId, params, _signal, onUpdate) {
						executed.push(params.note);
						onUpdate?.({
							content: [{ type: "text", text: "working" }],
							details: {},
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
		workspaceTree: {
			rootPath: cwd,
			rendered: "",
			truncated: false,
			totalLines: 0,
			agentsMdFiles: [],
		},
	});
	let startArgs: string | undefined;
	let updateArgs: string | undefined;
	session.subscribe(event => {
		events.push({ type: event.type, json: JSON.stringify(event) ?? "" });
		if (event.type === "tool_execution_start" && startArgs === undefined) {
			startArgs = JSON.stringify(event.args);
		}
		if (event.type === "tool_execution_update" && updateArgs === undefined) {
			updateArgs = JSON.stringify(event.args);
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
	// Reduced to booleans HERE rather than kept as payloads: a fixture that retains the request
	// bodies would put a credential in a test's memory and, on failure, in its output.
	const providerTurns = model.calls.map(call => {
		const sent = JSON.stringify(call.context.messages ?? []);
		return { carriesValue: sent.includes(SECRET_VALUE), carriesPlaceholder: sent.includes(PLACEHOLDER) };
	});
	return { executed, events, startArgs, updateArgs, providerTurns };
}

let spend: Drive;
let plain: Drive;

beforeAll(async () => {
	spend = await drive(`printf '%s' '${PLACEHOLDER}' | sha256sum`);
	plain = await drive("printf '%s' 'no-secret-here' | sha256sum");
}, 60_000);

afterAll(() => {
	unregisterCustomApis(MOCK_API_SOURCE);
});

describe("a tool call that spends a secret, watched through the session event stream", () => {
	/**
	 * The half that must keep working. If the split had been done by simply not expanding, the tool
	 * would authenticate with the literal text `#PROBE_TOKEN#` and every secret would be broken
	 * while every test about not showing one passed.
	 */
	it("executes the tool with the credential substituted", () => {
		expect(spend.executed).toEqual([`printf '%s' '${SECRET_VALUE}' | sha256sum`]);
	});

	/**
	 * The reported bug, at the event a renderer reconciles from. Before the split this carried the
	 * same object the tool ran on, which is how the bash card came to draw a live credential.
	 */
	it("gives tool_execution_start the placeholder, not the credential", () => {
		expect(spend.startArgs).toBe(JSON.stringify({ note: `printf '%s' '${PLACEHOLDER}' | sha256sum` }));
	});

	/**
	 * The streaming half of the same card. `tool_execution_update` is emitted from inside the tool's
	 * own execution, which is the natural place to reach for the arguments the tool was handed, so a
	 * fix applied only to the start event would still repaint the card with the credential on the
	 * first progress chunk.
	 */
	it("gives tool_execution_update the placeholder, not the credential", () => {
		expect(spend.updateArgs).toBe(JSON.stringify({ note: `printf '%s' '${PLACEHOLDER}' | sha256sum` }));
	});

	/**
	 * The sink-agnostic assertion, and the reason this suite is worth its runtime. Rather than name
	 * the two events a tool-call view reads today, it proves the value is absent from EVERY
	 * tool-execution event, so a card, a `--mode json` line, an HTML export or a HUD added later
	 * cannot leak a value it was never handed. Failures report the JSON path, never the value.
	 *
	 * SCOPE, DELIBERATELY NAMED. The `message_*` / `turn_end` / `agent_end` families are excluded
	 * because they carry the assistant message, and `AgentSession` expands placeholders in assistant
	 * content for display ON PURPOSE (`#displaySecretExpander`, applied with
	 * `includeToolMetadata: true`), which reaches `content[].arguments`. That is a separate, older
	 * decision in a different subsystem from this seam, and it is tracked separately — this suite
	 * would silently start covering it if the exclusion were dropped, so it is stated rather than
	 * implied.
	 */
	it("never puts the credential in any tool-execution event", () => {
		const toolEvents = spend.events.filter(event => event.type.startsWith("tool_execution"));
		expect(toolEvents.length).toBeGreaterThan(0);
		expect(leakPaths(toolEvents, SECRET_VALUE)).toEqual([]);
	});

	/**
	 * The placeholder has to actually be there. Without this, a fix that dropped the `note` argument,
	 * emptied the args or replaced them with `[redacted]` would pass every assertion above while
	 * leaving an operator unable to see what the agent ran.
	 */
	it("still shows the operator which secret the call spends", () => {
		const naming = spend.events.filter(event => event.json.includes(PLACEHOLDER)).map(event => event.type);
		expect(naming).toContain("tool_execution_start");
	});

	/**
	 * The control. An identical call with no placeholder in it must be untouched, proving the two
	 * forms are the same object when nothing expanded and that the split costs a normal tool call
	 * nothing — including no stray copy that could diverge.
	 */
	it("leaves a call with no placeholder identical on both sides", () => {
		const command = "printf '%s' 'no-secret-here' | sha256sum";
		expect(plain.executed).toEqual([command]);
		expect(plain.startArgs).toBe(JSON.stringify({ note: command }));
	});

	/**
	 * The blast radius of the local display expansion, pinned as a hard boundary.
	 *
	 * `AgentSession` expands placeholders in assistant content for display, which puts the credential
	 * into the `message_*` events (both the prose and `content[].arguments`) — a screen-and-scrollback
	 * exposure that RenderPathsNeverThrow owns in `agent-session.ts`. The question that decides its
	 * severity is whether that expansion travels: if the expanded text became the conversation
	 * history, the NEXT turn would carry a credential to a third party, and a scrollback problem would
	 * be a disclosure.
	 *
	 * It does not, and this is the test that keeps it that way. The scripted model emits the
	 * placeholder in prose on the turn after the spend, so the expansion definitely fires; every
	 * provider request is then checked. The mock cannot know the credential, so `carriesValue` can
	 * only become true if a local expansion reached an outbound payload. `carriesPlaceholder` is
	 * asserted alongside it so a request that stopped carrying the reference at all — dropped, or
	 * scrubbed to nothing — cannot pass as clean.
	 */
	it("never sends the credential to the provider on any turn", () => {
		expect(spend.providerTurns).toEqual([
			{ carriesValue: false, carriesPlaceholder: false },
			{ carriesValue: false, carriesPlaceholder: true },
		]);
	});
});
