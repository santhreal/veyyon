/**
 * The operator's instruction files reach the model on EVERY api, through ONE channel.
 *
 * WHY THIS SUITE EXISTS, and why it is shaped as a table rather than a case for the bug.
 *
 * The operator's `AGENTS.md` failing to reach a Cursor model has now happened three times. The
 * third time, every part in isolation was correct: discovery produced all three scopes, the
 * prompt builder rendered whatever it was handed, and the provider wrote whatever it was given.
 * What was wrong was the JOIN. cursor-agent alone assembled its instructions its own way: the
 * session inlined NOTHING in the prompt on that api and shipped a separate, scope-filtered list
 * of file units instead, so the repository's own `AGENTS.md` was excluded from the list as
 * repository content and excluded from the prompt because the list was supposed to carry it.
 *
 * The fix is structural: there is one channel now. Every api inlines its context files into the
 * assembled prompt, and the Cursor provider carries that prompt on the active user turn.
 * This suite pins the property that survives it — for every api, the operator's bytes and the
 * project's bytes are in what the model receives — and pins the per-api decision that used to
 * be the hiding place.
 *
 * Three things keep it honest:
 *
 *  1. `DELIVERY` is a `Record<KnownApi, …>`, so adding a member to the union without recording a
 *     delivery decision does not compile. A new provider cannot land with the question unanswered.
 *  2. Every api carried by a BUNDLED model must be a key of the table, checked at run time. A new
 *     api reaching the catalog by any route (a generated row, a descriptor, an upstream refresh)
 *     turns this suite red even if the type union was not touched.
 *  3. Each recorded channel is EXERCISED against real discovery output, not asserted about. A row
 *     claims a channel and then has to actually render the operator's bytes into a real prompt,
 *     and the cursor row has to put that prompt on a real Cursor wire frame.
 *
 * The fixture deliberately uses a cwd with no project file for the operator-scope arms, which is
 * where the operator was (`~/tmp`). A repository file is not a substitute for the operator's own.
 */
import { describe, expect, it, setDefaultTimeout } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { create, fromBinary } from "@bufbuild/protobuf";
import { buildCursorRules, buildGrpcRequest, handleServerMessage } from "@veyyon/ai/providers/cursor";
import type { AssistantMessage, Context, ImageContent, Model, TextContent } from "@veyyon/ai/types";
import { AssistantMessageEventStream } from "@veyyon/ai/utils/event-stream";
import {
	AgentClientMessageSchema,
	AgentServerMessageSchema,
	ExecServerMessageSchema,
	RequestContextArgsSchema,
	type RequestContextSuccess,
} from "@veyyon/catalog/discovery/cursor-gen/agent_pb";
import { type GeneratedProvider, getBundledModels, getBundledProviders } from "@veyyon/catalog/models";
import type { KnownApi } from "@veyyon/catalog/types";
import type { ContextFile } from "@veyyon/coding-agent/capability/context-file";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { createAgentSession, discoverContextFiles } from "@veyyon/coding-agent/sdk";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import type { ContextFileEntry } from "@veyyon/coding-agent/tools";
import {
	GLOBAL_BODY,
	PROFILE_BODY,
	PROJECT_ROOT_BODY,
	renderedContextBlock,
	useContextScopeFixture,
} from "./helpers/context-scope-fixture";

// The last arm walks every api a bundled model can select and renders the
// operator's bytes for each, which is 2.5s on an idle box and past Bun's 5s
// default in a full bucket run: chunk 27 of `ci:test:coding-agent:runtime`
// failed on the clock while the same file passed on its own.
setDefaultTimeout(60_000);

/**
 * How the assembled prompt travels to the model on an api.
 *
 * Both channels carry the SAME prompt, context files inlined. `system-prompt` sends it as the
 * request's system prompt; `cursor-user-turn` prepends it to the active user message, because
 * Cursor's server discards client prompt blobs, replaces the prompt head with its own, and
 * applies none of the request-context rules. Nothing about the composition differs, which is the
 * property that closed the defect: an api can no longer withhold a scope the prompt build
 * rendered.
 */
type DeliveryChannel = "system-prompt" | "cursor-user-turn";

/**
 * One recorded decision per api. Exhaustive by type: a new `KnownApi` member breaks the build
 * here, which is the point. Do not add a row without knowing that the channel named actually
 * carries the operator's files on that api; the cases below will check that you did.
 */
const DELIVERY: Record<KnownApi, DeliveryChannel> = {
	"openai-completions": "system-prompt",
	"openai-responses": "system-prompt",
	openrouter: "system-prompt",
	"openai-codex-responses": "system-prompt",
	"azure-openai-responses": "system-prompt",
	"anthropic-messages": "system-prompt",
	"bedrock-converse-stream": "system-prompt",
	"google-generative-ai": "system-prompt",
	"google-gemini-cli": "system-prompt",
	"google-vertex": "system-prompt",
	"ollama-chat": "system-prompt",
	"cursor-agent": "cursor-user-turn",
	"gitlab-duo-agent": "system-prompt",
	"devin-agent": "system-prompt",
};

/**
 * What every api does with each context-file scope: delivers it.
 *
 * Exhaustive by type, so a new scope (a machine-wide file, a workspace file, anything) does not
 * compile until someone records its answer. "withheld" is deliberately not a value any level may
 * take. A scope worth discovering is worth delivering, and a scope that must not reach the model
 * is one discovery must not produce — filtering it per api is what hid a whole layer on one api
 * while every other api rendered it.
 */
const LEVEL_EVERYWHERE: Record<ContextFile["level"], "delivered"> = {
	global: "delivered",
	user: "delivered",
	project: "delivered",
};

const RECORDED_APIS = Object.keys(DELIVERY) as KnownApi[];

const GLOBAL_MARKER = "GLOBAL-SCOPE-BYTES-c3f1";
const PROFILE_MARKER = "PROFILE-SCOPE-BYTES-9a27";
const PROJECT_ROOT_MARKER = "PROJECT-ROOT-BYTES-51bd";

const fixture = useContextScopeFixture("operator-delivery-");

const EMPTY_TREE = { rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] as string[] };

interface OperatorScopes {
	/** Real discovery output for this workspace. */
	contextFiles: ContextFileEntry[];
	cwd: string;
	agentDir: string;
	home: string;
}

/**
 * Lay every scope down and run the REAL discovery the session runs. Returns exactly what
 * `sdk.ts` would hold in `promptContextFiles`.
 *
 * `bare` is the operator's own situation: a plain directory outside any repository, so the
 * operator's two files are the only layers and a project file cannot stand in for them.
 * Otherwise the fixture's repository tree contributes its project layer too, which is the layer
 * this api used to drop.
 */
async function operatorScopes(options: { bare?: boolean } = {}): Promise<OperatorScopes> {
	const fx = fixture("work");
	fx.writeFile(fx.globalAgentsPath, GLOBAL_BODY);
	fx.writeFile(fx.profileAgentsPath, PROFILE_BODY);
	let cwd = fx.cwd;
	if (options.bare) {
		cwd = path.join(fx.home, "tmp");
		fs.mkdirSync(cwd, { recursive: true });
	} else {
		fx.writeFile(fx.rootAgentsPath, PROJECT_ROOT_BODY);
	}
	fx.resetCaches();

	const contextFiles = await discoverContextFiles(cwd, fx.agentDir);
	return { contextFiles, cwd, agentDir: fx.agentDir, home: fx.home };
}

/**
 * The first bundled model carrying this api, in catalog order.
 *
 * A SHIPPED row rather than a hand-made one. The session resolves prompt policy from the model
 * it is handed, and a synthetic row can satisfy a predicate the shipped rows do not reach.
 */
function bundledModelFor(api: KnownApi): Model {
	for (const provider of getBundledProviders() as GeneratedProvider[]) {
		for (const model of getBundledModels(provider)) {
			if (model.api === api) return model;
		}
	}
	throw new Error(`No bundled model carries api "${api}", so its recorded channel cannot be exercised.`);
}

/**
 * The system prompt a REAL session builds for this api.
 *
 * Built by `createAgentSession` and read back through `refreshBaseSystemPrompt`, which is the
 * session's own `rebuildSystemPrompt` closure and therefore the live `contextFiles` decision.
 * Reproducing that expression here instead would make the suite agree with itself: a second api
 * that strips context files through some other predicate would be delivered nothing and still be
 * recorded, and exercised, as `system-prompt`.
 *
 * The session runs its OWN discovery from the bare cwd, so the files it finds are the operator's.
 */
async function sessionPromptFor(api: KnownApi, scopes: OperatorScopes): Promise<string[]> {
	const model = bundledModelFor(api);
	const authStorage = await AuthStorage.create(path.join(scopes.home, `auth-${api}.db`));
	authStorage.setRuntimeApiKey(model.provider, "test-token");
	const created = await createAgentSession({
		cwd: scopes.cwd,
		agentDir: scopes.agentDir,
		sessionManager: SessionManager.create(scopes.cwd, path.join(scopes.home, `sessions-${api}`)),
		authStorage,
		modelRegistry: new ModelRegistry(authStorage),
		settings: Settings.isolated({ "async.enabled": false, "advisor.enabled": false }),
		model,
		disableExtensionDiscovery: true,
		skills: [],
		workspaceTree: { rootPath: scopes.cwd, ...EMPTY_TREE },
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
	});
	try {
		return await created.session.refreshBaseSystemPrompt("per-api-delivery-check");
	} finally {
		await created.session.dispose();
	}
}

/**
 * Drive a real `requestContextArgs` ask through the real provider handler and return the rule
 * text that reached the wire. Nothing here is stubbed but the socket.
 */
async function rulesOnTheWire(systemPrompt: string[]): Promise<string[]> {
	const frames: Buffer[] = [];
	const h2 = { write: (buf: Buffer) => frames.push(Buffer.from(buf)) } as never;
	const output = { role: "assistant", content: [], stopReason: "stop" } as unknown as AssistantMessage;
	const ask = create(AgentServerMessageSchema, {
		message: {
			case: "execServerMessage",
			value: create(ExecServerMessageSchema, {
				execId: "ctx-1",
				message: { case: "requestContextArgs", value: create(RequestContextArgsSchema, {}) },
			}),
		},
	});

	await handleServerMessage(
		ask,
		output,
		new AssistantMessageEventStream(),
		{} as never,
		new Map(),
		h2,
		undefined,
		undefined,
		[],
		buildCursorRules(systemPrompt),
	);

	expect(frames).toHaveLength(1);
	const message = fromBinary(AgentClientMessageSchema, new Uint8Array(frames[0].subarray(5)));
	if (message.message.case !== "execClientMessage") throw new Error(`unexpected: ${message.message.case}`);
	const exec = message.message.value;
	if (exec.message.case !== "requestContextResult") throw new Error(`unexpected: ${exec.message.case}`);
	const result = exec.message.value.result;
	if (result.case !== "success") throw new Error(`requestContext failed: ${result.case}`);
	const rules = (result.value as RequestContextSuccess).requestContext?.rules ?? [];
	return rules.map(rule => rule.content);
}

/** A 1x1 transparent PNG, so the multimodal branch has a real image to carry. */
const ONE_PIXEL_PNG =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

/**
 * Build a REAL Cursor run request through the provider's own request builder and return the
 * text of the active user turn — the field this server delivers to the model verbatim.
 *
 * Decoded from the serialized frame, not read off an intermediate value, so a change that
 * assembles the preamble and then fails to put it on the wire fails here.
 */
async function activeUserTurnText(
	systemPrompt: string[],
	content: string | (TextContent | ImageContent)[],
): Promise<string> {
	const model = bundledModelFor("cursor-agent") as Model<"cursor-agent">;
	const built = await buildGrpcRequest(
		model,
		{ systemPrompt, messages: [{ role: "user", content }] } as Context,
		undefined,
		{ conversationId: "conv-1", blobStore: new Map() },
	);
	const message = fromBinary(AgentClientMessageSchema, built.requestBytes);
	if (message.message.case !== "runRequest") throw new Error(`unexpected: ${message.message.case}`);
	const action = message.message.value.action?.action;
	if (action?.case !== "userMessageAction") throw new Error(`unexpected action: ${action?.case}`);
	return action.value.userMessage?.text ?? "";
}

describe("operator instruction delivery, per api", () => {
	it("records a delivery channel for every api a bundled model can select", () => {
		// Catalog-side closure. The type union is one way an api arrives; the generated catalog
		// is the other, and a row can carry an api the union never learned about.
		const inCatalog = new Set<string>();
		// `getBundledProviders` declares the wider `KnownProvider`, but its runtime values are the
		// keys of the generated catalog, which is exactly what `getBundledModels` indexes.
		for (const provider of getBundledProviders() as GeneratedProvider[]) {
			for (const model of getBundledModels(provider)) inCatalog.add(model.api);
		}
		expect(inCatalog.size).toBeGreaterThan(0);

		const undecided = [...inCatalog].filter(api => !(api in DELIVERY)).sort();
		expect(undecided).toEqual([]);
	});

	it("carries the operator's own two files to the request on every recorded api", async () => {
		// The operator's situation, verbatim: a plain directory with no repository in sight, so
		// nothing but their own files can account for a marker in the payload.
		const scopes = await operatorScopes({ bare: true });
		expect(scopes.contextFiles.map(file => file.level)).toEqual(["user", "global"]);

		const missing: string[] = [];
		for (const api of RECORDED_APIS) {
			const systemPrompt = await sessionPromptFor(api, scopes);
			const delivered =
				DELIVERY[api] === "cursor-user-turn"
					? await activeUserTurnText(systemPrompt, "hello")
					: systemPrompt.join("\n\n");

			if (!delivered.includes(GLOBAL_MARKER)) missing.push(`${api}: global file absent from ${DELIVERY[api]}`);
			if (!delivered.includes(PROFILE_MARKER)) missing.push(`${api}: profile file absent from ${DELIVERY[api]}`);
		}

		expect(missing).toEqual([]);
	});

	it("carries every recorded scope, including the project's, on every recorded api", async () => {
		// The sweep that closes the class. Each level is laid down as a real file, discovered by
		// the real loader, and looked for in what the model actually receives on each api. The
		// project row is the one that was dropped on cursor-agent alone.
		const scopes = await operatorScopes();
		const markerFor: Record<ContextFile["level"], string> = {
			global: GLOBAL_MARKER,
			user: PROFILE_MARKER,
			project: PROJECT_ROOT_MARKER,
		};
		const levels = Object.keys(LEVEL_EVERYWHERE) as ContextFile["level"][];
		// Every level the table records is actually present in this workspace, or the sweep below
		// would pass by asserting nothing.
		expect(levels.filter(level => scopes.contextFiles.some(file => file.level === level))).toEqual(levels);

		const observed: string[][] = [];
		for (const api of RECORDED_APIS) {
			const systemPrompt = await sessionPromptFor(api, scopes);
			const delivered =
				DELIVERY[api] === "cursor-user-turn"
					? await activeUserTurnText(systemPrompt, "hello")
					: systemPrompt.join("\n\n");
			for (const level of levels) {
				observed.push([api, level, delivered.includes(markerFor[level]) ? "delivered" : "withheld"]);
			}
		}

		expect(observed).toEqual(RECORDED_APIS.flatMap(api => levels.map(level => [api, level, "delivered"])));
	});

	it("renders one context-file payload, identical on every api", async () => {
		// The structural guarantee behind the sweep. An api that composes its own instruction
		// payload is free to drop a scope the others keep, which is precisely how this broke; if
		// every api renders the same blocks into the same prompt, one of them cannot be quietly
		// poorer. No api is exempt: cursor-agent used to be, and that exemption WAS the defect.
		const scopes = await operatorScopes();
		const blocks = scopes.contextFiles.map(file => renderedContextBlock(file.path, file.content));
		expect(blocks.length).toBeGreaterThan(0);

		const poorer: string[] = [];
		for (const api of RECORDED_APIS) {
			const promptText = (await sessionPromptFor(api, scopes)).join("\n\n");
			for (const block of blocks) {
				if (!promptText.includes(block)) poorer.push(`${api}: missing ${block.slice(0, 40)}…`);
			}
		}

		expect(poorer).toEqual([]);
	});

	it("still ships the assembled prompt as the request-context rule Cursor asks for", async () => {
		// The fail-closed exchange the provider observes. The server applies none of these rules,
		// but a turn that never sees the ask is a turn the model ran without instructions, so the
		// payload has to stay both present and identical to what the user turn carries.
		const scopes = await operatorScopes();
		const systemPrompt = await sessionPromptFor("cursor-agent", scopes);
		const rules = await rulesOnTheWire(systemPrompt);
		expect(rules).toEqual([systemPrompt.join("\n\n")]);
		expect(rules[0]).toContain(PROJECT_ROOT_MARKER);
	});

	it("puts the whole assembled prompt on Cursor's active user turn", async () => {
		// The api that cannot use a system prompt at all. Its server fetches the client's
		// system-prompt blobs and then rebuilds the prompt head with its own, and it applies
		// none of `requestContext.rules`; the active user turn is the one thing it delivers
		// verbatim, so the operator's bytes ride there or they reach the model nowhere.
		const scopes = await operatorScopes();
		const systemPrompt = await sessionPromptFor("cursor-agent", scopes);
		const turn = await activeUserTurnText(systemPrompt, "what is the first rule?");

		expect(turn).toContain("<operator-instructions>");
		expect(turn).toContain("</operator-instructions>");
		// The operator's question survives the preamble, and comes after it.
		expect(turn.indexOf("what is the first rule?")).toBeGreaterThan(turn.indexOf("</operator-instructions>"));
		// Every layer, inlined by the one composer, is inside the delimited block.
		const block = turn.slice(0, turn.indexOf("</operator-instructions>"));
		for (const marker of [GLOBAL_MARKER, PROFILE_MARKER, PROJECT_ROOT_MARKER]) {
			expect(block).toContain(marker);
		}
	});

	it("still carries the prompt on the user turn when the turn is multimodal", async () => {
		// The array-content branch. An image turn takes a different path through the request
		// builder, and an operator who pastes a screenshot must not lose their instructions.
		const scopes = await operatorScopes();
		const systemPrompt = await sessionPromptFor("cursor-agent", scopes);
		const turn = await activeUserTurnText(systemPrompt, [
			{ type: "text", text: "what is the first rule?" },
			{ type: "image", data: ONE_PIXEL_PNG, mimeType: "image/png" },
		]);

		expect(turn).toContain("<operator-instructions>");
		expect(turn).toContain(GLOBAL_MARKER);
		expect(turn).toContain(PROJECT_ROOT_MARKER);
		expect(turn).toContain("what is the first rule?");
	});
});
