/**
 * The operator's instruction files reach the model on EVERY api, by some path.
 *
 * WHY THIS SUITE EXISTS, and why it is shaped as a table rather than a case for the bug.
 *
 * The operator's `AGENTS.md` failing to reach a Cursor model has now happened twice. The second
 * time, every part in isolation was correct: discovery produced the global and profile entries,
 * `cursorContextFileRules` kept both, `buildCursorRules` wrapped both, and the provider wrote both
 * to the wire when asked. What no test covered was the JOIN — whether, for a given api, the files
 * end up somewhere the model actually reads. The delivery MECHANISM is api-dependent
 * (`usesCursorRuleDelivery`), the choice is made in one expression in `sdk.ts`, and the two
 * mechanisms have nothing in common, so a per-helper test can be green while the join is broken.
 *
 * The table below is that join, recorded once per api. Three things keep it honest:
 *
 *  1. `DELIVERY` is a `Record<KnownApi, …>`, so adding a member to the union without recording a
 *     delivery decision does not compile. A new provider cannot land with the question unanswered.
 *  2. Every api carried by a BUNDLED model must be a key of the table, checked at run time. A new
 *     api reaching the catalog by any route (a generated row, a descriptor, an upstream refresh)
 *     turns this suite red even if the type union was not touched.
 *  3. Each recorded channel is EXERCISED against real discovery output, not asserted about. A row
 *     that claims "system-prompt" has to actually render the operator's bytes into a real prompt,
 *     and a row that claims "cursor-rules" has to actually put them on a real Cursor wire frame.
 *
 * The fixture deliberately uses a cwd with no project file, which is where the operator was
 * (`~/tmp`). A repository file is not a substitute for the operator's own, and a suite that runs
 * inside a repo would not notice if it had become one.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { create, fromBinary } from "@bufbuild/protobuf";
import { buildCursorRules, handleServerMessage } from "@veyyon/ai/providers/cursor";
import type { AssistantMessage, Model } from "@veyyon/ai/types";
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
import { cursorContextFileRules, usesCursorRuleDelivery } from "@veyyon/coding-agent/cursor";
import { createAgentSession, discoverContextFiles } from "@veyyon/coding-agent/sdk";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import type { ContextFileEntry } from "@veyyon/coding-agent/tools";
import { GLOBAL_BODY, PROFILE_BODY, useContextScopeFixture } from "./helpers/context-scope-fixture";

/**
 * How an api carries the operator's instruction files to the model.
 *
 * `system-prompt` inlines them in the prompt the client sends. `cursor-rules` sends them as
 * `requestContext.rules` and inlines NOTHING, because Cursor's server discards client prompt
 * blobs and replaces them with its own.
 */
type DeliveryChannel = "system-prompt" | "cursor-rules";

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
	"cursor-agent": "cursor-rules",
	"gitlab-duo-agent": "system-prompt",
	"devin-agent": "system-prompt",
};

/**
 * What the rules channel does with each context-file scope.
 *
 * The same closure argument as `DELIVERY`, one level down. `cursorContextFileRules` names two
 * levels and drops silently on the rest, so a new scope (a machine-wide file, a workspace file,
 * anything) reaches Cursor as nothing at all, with no error and no way for the operator to tell.
 * Exhaustive by type: adding a member to `ContextFile["level"]` does not compile until someone
 * records what it should do here, and the case below checks the recorded answer is the real one.
 */
const LEVEL_ON_CURSOR: Record<ContextFile["level"], "delivered" | "withheld"> = {
	// The operator's own two scopes, which is the whole point of the channel.
	global: "delivered",
	user: "delivered",
	// A repository may not configure the agent through a channel the operator cannot see.
	project: "withheld",
};

const RECORDED_APIS = Object.keys(DELIVERY) as KnownApi[];

const GLOBAL_MARKER = "GLOBAL-SCOPE-BYTES-c3f1";
const PROFILE_MARKER = "PROFILE-SCOPE-BYTES-9a27";

const fixture = useContextScopeFixture("operator-delivery-");

const EMPTY_TREE = { rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] as string[] };

interface OperatorScopes {
	/** Real discovery output for a cwd with no project file. */
	contextFiles: ContextFileEntry[];
	cwd: string;
	agentDir: string;
	home: string;
}

/**
 * Lay the operator's two files down and run the REAL discovery the session runs, from a bare
 * directory. Returns exactly what `sdk.ts` would hold in `promptContextFiles`.
 */
async function operatorScopes(): Promise<OperatorScopes> {
	const fx = fixture("work");
	fx.writeFile(fx.globalAgentsPath, GLOBAL_BODY);
	fx.writeFile(fx.profileAgentsPath, PROFILE_BODY);
	// The operator's cwd: a plain directory outside any repository, carrying no project file.
	const cwd = path.join(fx.home, "tmp");
	fs.mkdirSync(cwd, { recursive: true });
	fx.resetCaches();

	const contextFiles = await discoverContextFiles(cwd, fx.agentDir);
	return { contextFiles, cwd, agentDir: fx.agentDir, home: fx.home };
}

/** A minimal model row carrying only what the delivery predicate reads. */
function modelFor(api: KnownApi): Pick<Model, "api"> {
	return { api } as Pick<Model, "api">;
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
async function rulesOnTheWire(systemPrompt: string[], files: ContextFileEntry[]): Promise<string[]> {
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
		// `cursorContextFileRules` is the composition policy `sdk.ts` supplies as its resolver.
		buildCursorRules(systemPrompt, cursorContextFileRules(files)),
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

	it("keeps the recorded channel and the live predicate in agreement", () => {
		// `usesCursorRuleDelivery` is the ONE predicate driving both the prompt build and the
		// prompt cache key. If a row here disagrees with it, one of the two is wrong and the
		// operator's files are either delivered twice or not at all.
		const fromPredicate = RECORDED_APIS.map(api => [
			api,
			usesCursorRuleDelivery(modelFor(api)) ? "cursor-rules" : "system-prompt",
		]);
		expect(fromPredicate).toEqual(RECORDED_APIS.map(api => [api, DELIVERY[api]]));
	});

	it("honors the recorded decision for every context-file level on the rules channel", () => {
		// Exercised, not asserted about: each level is handed to the real composer and the answer
		// is read off what came back. A level recorded as delivered that the filter drops, or a
		// level recorded as withheld that it passes, is caught here rather than by an operator.
		const levels = Object.keys(LEVEL_ON_CURSOR) as ContextFile["level"][];
		const entries: ContextFileEntry[] = levels.map(level => ({
			path: `/operator/${level}/AGENTS.md`,
			content: `bytes for ${level}`,
			level,
		}));
		const deliveredPaths = new Set(cursorContextFileRules(entries).map(rule => rule.fullPath));

		const observed = levels.map(level => [
			level,
			deliveredPaths.has(`/operator/${level}/AGENTS.md`) ? "delivered" : "withheld",
		]);
		expect(observed).toEqual(levels.map(level => [level, LEVEL_ON_CURSOR[level]]));
	});

	it("carries the operator's global and profile files to the request on every recorded api", async () => {
		const scopes = await operatorScopes();
		// Real discovery, from a bare cwd, found both operator scopes and nothing else.
		expect(scopes.contextFiles.map(file => file.level)).toEqual(["user", "global"]);

		const missing: string[] = [];
		for (const api of RECORDED_APIS) {
			const systemPrompt = await sessionPromptFor(api, scopes);
			const promptText = systemPrompt.join("\n\n");

			if (DELIVERY[api] === "cursor-rules") {
				// Half one: the session inlines NOTHING, because Cursor discards prompt blobs.
				if (promptText.includes(GLOBAL_MARKER) || promptText.includes(PROFILE_MARKER)) {
					missing.push(`${api}: operator files inlined in the prompt Cursor discards`);
					continue;
				}
				// Half two: they arrive on the channel Cursor honors.
				const wire = (await rulesOnTheWire(systemPrompt, scopes.contextFiles)).join("\n\n");
				if (!wire.includes(GLOBAL_MARKER)) missing.push(`${api}: global file absent from requestContext.rules`);
				if (!wire.includes(PROFILE_MARKER)) missing.push(`${api}: profile file absent from requestContext.rules`);
				continue;
			}

			if (!promptText.includes(GLOBAL_MARKER)) missing.push(`${api}: global file absent from the system prompt`);
			if (!promptText.includes(PROFILE_MARKER)) missing.push(`${api}: profile file absent from the system prompt`);
		}

		expect(missing).toEqual([]);
	});
});
