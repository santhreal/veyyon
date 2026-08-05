/**
 * Mid-session mutation of the model context PREFIX.
 *
 * The system prompt is the provider's cache prefix. Both providers this harness
 * targets key their cache on CONTENT, not on any handle the client holds:
 * Anthropic marks byte-carrying `cache_control` breakpoints on serialized text
 * blocks (`packages/ai/src/providers/anthropic.ts` `applyPromptCaching`, and the
 * stable-prefix anchor at `applyCacheControlToStableSystemPrefix`), and the
 * OpenAI Responses path marks a `prompt_cache_breakpoint` on an `input_text`
 * block (`packages/ai/src/providers/openai-prompt-cache.ts`
 * `formatOpenAIInputText`). Neither sees an array identity. So the cost question
 * is only ever "did the BYTES change mid-session", and the answer has to be
 * recorded with a reason a reader can act on, because a change invalidates the
 * cache for the whole conversation behind it: a measured 66-turn trace lost five
 * turns to `cacheRead: 0` while resending 46-72k tokens each.
 *
 * This suite pins the three contracts that keep that cost attributable and
 * bounded. It is deliberately one file: these are one defect class, and they were
 * previously defended by nothing at all.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent, type AgentTool } from "@veyyon/agent-core";
import type { Model } from "@veyyon/ai";
import { createArgotSession } from "@veyyon/coding-agent/argot-cache";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { formatModelString } from "@veyyon/coding-agent/config/model-resolver";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { usesCursorRuleDelivery } from "@veyyon/coding-agent/cursor";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { usesCodexTaskPrompt } from "@veyyon/coding-agent/task/prompt-policy";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import { ArgotUnloadTool } from "@veyyon/coding-agent/tools/argot";
import { removeSyncWithRetries } from "@veyyon/utils";
import type { Vocabulary } from "argot";
import { useTrackedTempDirs } from "./helpers/tracked-temp-dir";

const makeTempDir = useTrackedTempDirs("pi-prompt-prefix-cache-");

/** A stand-in for the `edit` tool, present only so `getActiveToolNames()` reports it. */
const EDIT_TOOL_STUB = {
	name: "edit",
	label: "Edit",
	description: "stub",
	parameters: { type: "object", properties: {} },
	execute: async () => ({ content: [{ type: "text", text: "" }] }),
};

describe("system prompt prefix invalidation", () => {
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let tempDir: string;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = makeTempDir();
		authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
			session = undefined;
		}
		authStorage.close();
		removeSyncWithRetries(tempDir);
	});

	/**
	 * Two models in the SAME prompt-model-key cohort whose edit variants differ.
	 *
	 * `resolveEditMode` sends any model whose string contains `kimi` to `replace`
	 * while everything else keeps the `hashline` default, and neither model may be
	 * a GPT-5.6 task-policy model or a cursor-agent model, or
	 * `#currentPromptModelKey` would move too and the reason under test would no
	 * longer isolate the edit variant.
	 */
	function pickEditVariantPair(): [Model, Model] {
		const sameCohort = (model: Model): boolean => !usesCodexTaskPrompt(model.id) && !usesCursorRuleDelivery(model);
		const all = modelRegistry.getAll().filter(sameCohort);
		const hashline = all.find(model => !formatModelString(model).toLowerCase().includes("kimi"));
		const replace = all.find(model => formatModelString(model).toLowerCase().includes("kimi"));
		if (!hashline || !replace) throw new Error("Expected a kimi and a non-kimi model in the same prompt cohort");
		return [hashline, replace];
	}

	function newSession(model: Model, settings: Settings, rebuilt: string[]): AgentSession {
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: ["initial"],
				tools: [EDIT_TOOL_STUB as unknown as AgentTool],
				messages: [],
			},
		});
		return new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			toolRegistry: new Map(),
			// A FRESH array every call, like a real rebuild: the reference always
			// differs, so only a content comparison can tell an identical rebuild
			// from a changed one.
			rebuildSystemPrompt: async () => ({ systemPrompt: [...rebuilt] }),
		});
	}

	/**
	 * BUG: a model switch that moved only the edit variant recorded its
	 * invalidation as `edit-mode-change`.
	 *
	 * That names a trigger no session can produce. `edit.mode` is not a prompt
	 * gate (`system-prompt-builder/gate-registry.ts` never lists it), and the only
	 * reads of the edit mode for this purpose are the four `setModel`/`cycleModel`
	 * paths, so the edit variant NEVER re-resolves except across a model switch.
	 *
	 * COST THIS PREVENTS: not the re-prefill itself, which a model switch makes
	 * unavoidable — a different model is a different provider cache namespace, so
	 * the prefix was already dead. It prevents the wasted hunt. The invalidation
	 * record exists so a reader chasing `cacheRead: 0` turns can attribute them,
	 * and a phantom trigger sends that reader looking for a settings flip nobody
	 * performed instead of reading "model switch, already paid for".
	 */
	it("names the model switch when a switch moves only the edit variant", async () => {
		expect(Bun.env.VEYYON_EDIT_VARIANT).toBeUndefined();
		expect(Bun.env.VEYYON_STRICT_EDIT_MODE).toBeUndefined();

		const [hashlineModel, replaceModel] = pickEditVariantPair();
		authStorage.setRuntimeApiKey(hashlineModel.provider, "key-a");
		authStorage.setRuntimeApiKey(replaceModel.provider, "key-b");

		session = newSession(
			hashlineModel,
			Settings.isolated({
				"compaction.enabled": false,
				includeModelInPrompt: false,
				"edit.mode": "hashline",
			}),
			["rebuilt"],
		);

		await session.setModel(replaceModel);

		expect(session.systemPromptInvalidations()).toEqual(["model-switch:edit-mode"]);
	});

	/**
	 * The other half of the same contract: the reason must still say WHICH inputs
	 * moved, so "these two models share a prompt cohort and only the edit variant
	 * forced the rebuild" stays distinguishable from a cohort change. Collapsing
	 * every model switch to one opaque string would trade the phantom trigger for
	 * no signal at all.
	 */
	it("names the prompt-model-key when the switch moves the model cohort", async () => {
		const all = modelRegistry.getAll();
		const defaultPolicy = all.find(model => !usesCodexTaskPrompt(model.id) && !usesCursorRuleDelivery(model));
		const codexPolicy = all.find(model => usesCodexTaskPrompt(model.id));
		if (!defaultPolicy || !codexPolicy) throw new Error("Expected default-policy and GPT-5.6 models");
		authStorage.setRuntimeApiKey(defaultPolicy.provider, "key-a");
		authStorage.setRuntimeApiKey(codexPolicy.provider, "key-b");

		session = newSession(
			defaultPolicy,
			Settings.isolated({ "compaction.enabled": false, includeModelInPrompt: false }),
			["rebuilt"],
		);

		await session.setModel(codexPolicy);

		const [reason] = session.systemPromptInvalidations();
		expect(reason).toStartWith("model-switch:");
		expect(reason).toContain("prompt-model-key");
	});

	/**
	 * The premise the whole record rests on: providers key on CONTENT, so a
	 * rebuild that reproduces the same bytes is free and must NOT be recorded.
	 *
	 * COST THIS PREVENTS: a recorder that compared array identity instead of
	 * content would mark every rebuild as an invalidation. Every skip
	 * optimization downstream — the tool-signature skip in
	 * `#applyActiveToolsByName`, the reference memo in `context-usage.ts` — is
	 * built on this being a content comparison, and a reference comparison here
	 * would report a full re-prefill on turns that actually cost nothing, making
	 * the evidence useless in the opposite direction from the bug above.
	 */
	it("records nothing when a rebuild reproduces the same bytes", async () => {
		const [model] = pickEditVariantPair();
		authStorage.setRuntimeApiKey(model.provider, "key-a");

		session = newSession(model, Settings.isolated({ "compaction.enabled": false }), ["stable-a", "stable-b"]);

		// A fresh array each call: same bytes, different reference.
		const first = await session.refreshBaseSystemPrompt("probe-one");
		const second = await session.refreshBaseSystemPrompt("probe-two");

		expect(second).toEqual(first);
		// The very first refresh replaces the constructor's `["initial"]`, so it is
		// a genuine byte change; the second must add nothing.
		expect(session.systemPromptInvalidations()).toEqual(["probe-one"]);
	});
});

/**
 * `setSystemPrompt` keeps the caller's array.
 *
 * BUG THIS PREVENTS: the per-turn `before_agent_start` path in `agent-session`
 * re-sets the prompt on EVERY turn — with the base prompt when no extension
 * touched it. That is safe only because the array travels through unchanged.
 * `context-usage.ts` memoizes the expensive system-prompt tokenization on the
 * IDENTITY of this array and documents that `setSystemPrompt` "replaces the array
 * reference rather than mutating it"; a defensive copy here would make every turn
 * look like a changed prompt to that memo and re-tokenize the whole prefix on the
 * per-turn compaction and threshold paths, three times per turn.
 */
describe("Agent.setSystemPrompt", () => {
	it("stores the caller's array rather than a copy", () => {
		const agent = new Agent();
		const prompt = ["stable-one", "stable-two"];

		agent.setSystemPrompt(prompt);

		expect(agent.state.systemPrompt).toBe(prompt);
	});
});

/**
 * A tool that rebuilds the prompt names its reason.
 *
 * BUG: `ToolSession.refreshBaseSystemPrompt` was declared `(): Promise<void>`,
 * with no reason parameter, while the session method it forwards to requires one.
 * The argot tools called it bare, so the invalidation was recorded, logged and
 * written to the transcript with `reason: undefined`.
 *
 * COST THIS PREVENTS: this is the WORST-placed rebuild in the harness. It runs
 * mid-turn, from inside a tool call, with the entire conversation already behind
 * the prefix, so the next request re-reads every token of it. An unattributed
 * entry is exactly the state the required parameter on
 * `AgentSession.refreshBaseSystemPrompt` was introduced to end: a measured
 * session recorded four consecutive `unspecified` rebuilds of a ~32k-character
 * prompt and could not say what caused any of them.
 */
describe("argot tools", () => {
	const makeArgotDir = useTrackedTempDirs("pi-prompt-prefix-argot-");

	function vocabulary(): Vocabulary {
		return {
			version: 1,
			sigil: "§",
			handles: new Map([["conn", "packages/server/src/database/connection.ts"]]),
			meta: new Map(),
		};
	}

	it("passes a reason when unloading drops a taught project", async () => {
		const root = makeArgotDir();
		fs.writeFileSync(path.join(root, ".argot"), "");

		const argot = createArgotSession({ enabled: true, isSubagent: false, subagentMode: "off" });
		if (argot === undefined) throw new Error("expected a codec for an enabled top-level session");
		argot.load(root, vocabulary());

		const reasons: string[] = [];
		const toolSession: ToolSession = {
			cwd: root,
			hasUI: false,
			settings: Settings.isolated({ "argot.enabled": true }),
			getArgotSession: () => argot,
			refreshBaseSystemPrompt: async reason => {
				reasons.push(reason);
			},
		};

		await new ArgotUnloadTool(toolSession).execute("call-1", { folder_path: root });

		// The exact string, not merely "something truthy": the whole value of the
		// record is that a reader can tell this rebuild apart from a cwd re-root or
		// a settings flip.
		expect(reasons).toEqual(["argot-unload"]);
	});
});
