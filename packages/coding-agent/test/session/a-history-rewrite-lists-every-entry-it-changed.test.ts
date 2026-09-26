import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Agent } from "@veyyon/agent-core";
import * as compactionModule from "@veyyon/agent-core/compaction";
import type { AssistantMessage, ImageContent, TextContent, ToolResultMessage } from "@veyyon/ai";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { getBundledModel } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { SettingPath } from "@veyyon/coding-agent/config/settings-schema";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import type { CompactionEntry, SessionEntry } from "@veyyon/kernel/session/session-entries";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import {
	FileSessionStorage,
	type SessionFileBody,
	type WriteTextAtomicOptions,
} from "@veyyon/kernel/session/session-storage";
import { TempDir } from "@veyyon/utils";

/**
 * WHY: a history rewrite (prune, shake, image drop, compaction tail elision, dead-end stamp) changes
 * entries in place and hands `SessionManager.rewriteEntries(updated)` the list of what it changed. The
 * manager keeps the file's bytes before the earliest listed entry and writes only the rest, so an
 * entry changed in place and left off the list keeps its old line on disk. The live session does not
 * notice; resume, `/fork` and export then read tool output, images and markers the session already
 * dropped, and the provider prompt cache misses on the divergent prefix.
 *
 * The class is "a caller changes an entry and leaves it off the list". Only the earliest changed
 * entry decides what is kept, so leaving off a later one is harmless and leaving off the earliest is
 * the defect. The manager cannot see an in-place change, so the suite checks at the one place every
 * caller passes through: each listed rewrite is followed by a whole rewrite of the same in-memory
 * state, and the two files must be byte-identical. Every row also proves the partial path ran with a
 * non-empty kept prefix, so a row cannot pass by falling back to a whole rewrite. The rows drive the
 * real `AgentSession` entry points: `dropImages` with each entry kind as the earliest, manual
 * `shake("elide")` and the redundancy dedup (their shared offload path), the per-turn stale-result
 * pass, the list `pruneToolOutputs` hands the threshold prune, and a threshold compaction that elides
 * its tail and stamps a dead-end warning, with and without its recovery artifact.
 *
 * The recovered-retry marker is the one caller without a row here:
 * `agent-session-retry-recovery.test.ts` reloads the session file and reads the marker back, which
 * fails when the marked entry is left off its list.
 *
 * MEASURED (mutation matrix, each mutant applied alone):
 * - M1 `dropImages` leaves message entries off: the message-earliest row red.
 * - M2 `dropImages` leaves custom-message entries off: the custom-message-earliest row red.
 * - M3 the shake offload path leaves the first region off: the shake and dedup rows red. Leaving the
 *   last region off: green, since the first region is the earliest.
 * - M4 `pruneSupersededToolResults` leaves its first entry off: the stale-pass row red. Its last:
 *   green, as above.
 * - M5 `pruneToolOutputs` leaves its last entry off (it collects newest first, so the last is the
 *   earliest): the threshold-prune row red. Its first: green, as above.
 * - M6 the tail elision persist lists nothing: both compaction rows red. It lists the entry only
 *   when the recovery pointer lands: the artifact-not-saved row red.
 * - M7 the dead-end stamp lists nothing: both compaction rows red.
 * - M8 the recovered-retry marker lists nothing: `agent-session-retry-recovery.test.ts` red.
 *
 * WHAT THIS DOES NOT CATCH: a new production caller of `rewriteEntries(updated)`. The call sites
 * are private methods the suite cannot enumerate, so a new caller needs its own row.
 */

/** Records the byte count every tail rewrite keeps, so a row can prove the partial path ran. */
class RecordingStorage extends FileSessionStorage {
	kept: number[] = [];

	override async rewriteTailAtomic(
		p: string,
		keepBytes: number,
		head: string,
		tail: SessionFileBody,
		options?: WriteTextAtomicOptions,
	): Promise<void> {
		this.kept.push(keepBytes);
		await super.rewriteTailAtomic(p, keepBytes, head, tail, options);
	}
}

interface RewriteLog {
	/** Rewrites that named their updated entries. */
	listed: number;
	/** One line per listed rewrite whose file differed from a whole rewrite of the same state. */
	mismatches: string[];
}

const wholeRewrite = SessionManager.prototype.rewriteEntries;

function firstDifference(partial: string, whole: string): string {
	const partialLines = partial.split("\n");
	const wholeLines = whole.split("\n");
	for (let i = 0; i < Math.max(partialLines.length, wholeLines.length); i++) {
		if (partialLines[i] === wholeLines[i]) continue;
		const kept = (partialLines[i] ?? "<missing>").slice(0, 160);
		const expected = (wholeLines[i] ?? "<missing>").slice(0, 160);
		return `line ${i + 1}: file has ${kept}; a whole rewrite has ${expected}`;
	}
	return "same lines, different bytes";
}

/**
 * After each rewrite that lists its updated entries, publish the same state whole and compare. The
 * whole publish also leaves the file in the state the next listed rewrite measures itself against.
 */
function verifyListedRewrites(manager: SessionManager): RewriteLog {
	const log: RewriteLog = { listed: 0, mismatches: [] };
	vi.spyOn(manager, "rewriteEntries").mockImplementation(async (updated?: Iterable<SessionEntry>) => {
		await wholeRewrite.call(manager, updated);
		if (updated === undefined) return;
		log.listed++;
		const file = manager.getSessionFile();
		if (!file) throw new Error("expected a persisted session file");
		const partial = await fs.readFile(file, "utf8");
		await wholeRewrite.call(manager);
		const whole = await fs.readFile(file, "utf8");
		if (partial !== whole) log.mismatches.push(firstDifference(partial, whole));
	});
	return log;
}

const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const PNG: ImageContent = { type: "image", data: "iVBORw0KGgo", mimeType: "image/png" };

describe("a history rewrite lists every entry it changed", () => {
	let tempDir: TempDir;
	let storage: RecordingStorage;
	let manager: SessionManager;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let apiInfo: Pick<AssistantMessage, "api" | "provider" | "model">;
	let log: RewriteLog;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@veyyon-history-rewrite-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		storage = new RecordingStorage();
		manager = SessionManager.create(tempDir.path(), tempDir.path(), storage);
		log = verifyListedRewrites(manager);
	});

	afterEach(async () => {
		try {
			await session?.dispose();
		} finally {
			authStorage.close();
			await tempDir.remove();
			vi.restoreAllMocks();
		}
	});

	function start(settings: Partial<Record<SettingPath, unknown>>): AgentSession {
		const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundled) throw new Error("Expected built-in anthropic model to exist");
		const model = { ...bundled, contextWindow: 200_000, maxTokens: 64_000 };
		apiInfo = { api: model.api, provider: model.provider, model: model.id };
		const agent = new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } });
		session = new AgentSession({
			agent,
			sessionManager: manager,
			settings: Settings.isolated({ "todo.enabled": false, "contextPromotion.enabled": false, ...settings }),
			modelRegistry: new ModelRegistry(authStorage),
		});
		return session;
	}

	function appendUser(content: string | (TextContent | ImageContent)[]): void {
		manager.appendMessage({ role: "user", content, timestamp: Date.now() });
	}

	function appendAssistant(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): void {
		manager.appendMessage({ role: "assistant", content, ...apiInfo, stopReason, usage, timestamp: Date.now() });
	}

	function appendToolTurn(
		toolName: string,
		args: Record<string, unknown>,
		content: ToolResultMessage["content"],
		extra: Partial<ToolResultMessage> = {},
	): string {
		const toolCallId = `call-${toolName}-${manager.getEntries().length}`;
		appendAssistant([{ type: "toolCall", id: toolCallId, name: toolName, arguments: args }], "toolUse");
		manager.appendMessage({
			role: "toolResult",
			toolCallId,
			toolName,
			content,
			isError: false,
			timestamp: Date.now(),
			...extra,
		});
		return toolCallId;
	}

	/** A finished turn ahead of everything a row changes: the bytes a partial rewrite keeps. */
	function appendUntouchedPrefix(): void {
		appendUser("Start the task.");
		appendAssistant([{ type: "text", text: "Starting." }], "stop");
	}

	/** Load the file from disk the way resume does. */
	async function reload(): Promise<SessionManager> {
		const file = manager.getSessionFile();
		if (!file) throw new Error("expected a persisted session file");
		return SessionManager.open(file, tempDir.path(), undefined, { suppressBreadcrumb: true });
	}

	function toolResultText(entries: SessionEntry[], toolCallId: string): string {
		for (const entry of entries) {
			if (entry.type !== "message" || entry.message.role !== "toolResult") continue;
			if (entry.message.toolCallId !== toolCallId) continue;
			return entry.message.content.map(block => (block.type === "text" ? block.text : `<${block.type}>`)).join("");
		}
		throw new Error(`no tool result ${toolCallId}`);
	}

	function expectEveryListedRewriteWhole(listed: number): void {
		expect(log.mismatches).toEqual([]);
		expect(log.listed).toBe(listed);
		// Each listed rewrite took the partial path and kept the untouched prefix.
		expect(storage.kept).toHaveLength(listed);
		for (const kept of storage.kept) expect(kept).toBeGreaterThan(0);
	}

	// Only the earliest changed entry decides what is kept, so each entry kind takes a turn at being it.
	for (const earliest of ["message", "custom message"] as const) {
		it(`drops images from message and custom-message entries when a ${earliest} is the earliest`, async () => {
			start({});
			appendUntouchedPrefix();
			const appendCustom = () =>
				manager.appendCustomMessageEntry("attachment", [{ type: "text", text: "pasted" }, PNG], true);
			if (earliest === "custom message") appendCustom();
			appendUser([{ type: "text", text: "look at this" }, PNG]);
			const screenshotCall = appendToolTurn("browser", { action: "run" }, [{ type: "text", text: "captured" }, PNG]);
			if (earliest === "message") appendCustom();
			appendAssistant([{ type: "text", text: "Seen." }], "stop");
			await manager.flush();

			expect(await session.dropImages()).toEqual({ removed: 3 });

			expectEveryListedRewriteWhole(1);
			const reloaded = await reload();
			expect(JSON.stringify(reloaded.getEntries())).not.toContain(PNG.data);
			expect(toolResultText(reloaded.getEntries(), screenshotCall)).toBe("captured");
		});
	}

	it("elides every heavy result a manual shake selects", async () => {
		start({ "compaction.enabled": true, "compaction.autoContinue": false });
		appendUntouchedPrefix();
		const calls: string[] = [];
		for (let i = 0; i < 3; i++) {
			appendUser(`run step ${i}`);
			calls.push(appendToolTurn("bash", { command: `step ${i}` }, [{ type: "text", text: `${i}`.repeat(4000) }]));
		}
		await manager.flush();

		const result = await session.shake("elide");

		expect(result.toolResultsDropped).toBe(3);
		expectEveryListedRewriteWhole(1);
		const reloaded = (await reload()).getEntries();
		for (const call of calls) expect(toolResultText(reloaded, call)).toContain(`artifact://${result.artifactId}`);
	});

	it("elides every earlier copy the redundancy dedup finds", async () => {
		start({ "compaction.enabled": true, "compaction.autoContinue": false });
		appendUntouchedPrefix();
		const body = "IDENTICAL_BODY\n".repeat(20);
		const calls: string[] = [];
		for (let i = 0; i < 3; i++) {
			appendUser(`list again ${i}`);
			calls.push(appendToolTurn("bash", { command: "ls" }, [{ type: "text", text: body }]));
		}
		await manager.flush();

		const result = await session.dedupeRedundantToolResults();

		expect(result.toolResultsDropped).toBe(2);
		expectEveryListedRewriteWhole(1);
		const reloaded = (await reload()).getEntries();
		expect(toolResultText(reloaded, calls[0]!)).toContain(`artifact://${result.artifactId}`);
		expect(toolResultText(reloaded, calls[1]!)).toContain(`artifact://${result.artifactId}`);
		expect(toolResultText(reloaded, calls[2]!)).toBe(body);
	});

	it("persists every result the per-turn stale pass replaces", async () => {
		start({ "compaction.enabled": false, "compaction.supersedeReads": true, "compaction.dropUseless": true });
		appendUntouchedPrefix();
		appendUser("Read the target.");
		const staleRead = appendToolTurn("read", { path: "src/target.ts" }, [
			{ type: "text", text: "STALE\n".repeat(200) },
		]);
		appendUser("Search for it.");
		const uselessSearch = appendToolTurn(
			"search",
			{ type: "text", input: "missing" },
			[{ type: "text", text: "NOTHING\n".repeat(200) }],
			{ useless: true },
		);
		appendUser("Read it again.");
		const freshRead = appendToolTurn("read", { path: "src/target.ts" }, [
			{ type: "text", text: "FRESH\n".repeat(200) },
		]);
		appendAssistant([{ type: "text", text: "Done." }], "stop");
		session.agent.replaceMessages(session.buildDisplaySessionContext().messages);
		vi.spyOn(session.agent, "prompt").mockImplementation(async () => {});

		await session.prompt("Continue.");

		expectEveryListedRewriteWhole(1);
		const reloaded = (await reload()).getEntries();
		expect(toolResultText(reloaded, staleRead)).toBe(compactionModule.SUPERSEDED_NOTICE);
		expect(toolResultText(reloaded, uselessSearch)).toBe(compactionModule.USELESS_NOTICE);
		expect(toolResultText(reloaded, freshRead)).toBe("FRESH\n".repeat(200));
	});

	it("persists every result the threshold prune's list names", async () => {
		start({});
		appendUntouchedPrefix();
		const calls: string[] = [];
		for (let i = 0; i < 4; i++) {
			appendUser(`dump log ${i}`);
			calls.push(
				appendToolTurn("bash", { command: `cat log-${i}` }, [{ type: "text", text: `L${i}\n`.repeat(3000) }]),
			);
		}
		appendAssistant([{ type: "text", text: "Read them all." }], "stop");
		await manager.flush();

		// The threshold prune hands this list to `rewriteEntries` unchanged. Protect only the newest
		// result so the pass rewrites several older ones in one call.
		const result = compactionModule.pruneToolOutputs(manager.getBranch(), {
			...compactionModule.DEFAULT_PRUNE_CONFIG,
			protectTokens: 1,
			minimumSavings: 1,
		});
		expect(result.prunedCount).toBe(3);
		await manager.rewriteEntries(result.prunedEntries);

		expectEveryListedRewriteWhole(1);
		const reloaded = (await reload()).getEntries();
		for (const [i, call] of calls.slice(0, 3).entries()) {
			expect(toolResultText(reloaded, call)).not.toContain(`L${i}\n`);
		}
		expect(toolResultText(reloaded, calls[3]!)).toBe("L3\n".repeat(3000));
	});

	// `prepareCompaction` replaces the elided message before the artifact is saved, so the entry is
	// changed whether or not its recovery pointer lands.
	for (const artifact of ["saved", "not saved"] as const) {
		it(`persists the tail elision and the dead-end stamp a threshold compaction writes, artifact ${artifact}`, async () => {
			start({
				"compaction.enabled": true,
				"compaction.strategy": "summary",
				"compaction.keepRecentTokens": 1,
				"compaction.autoContinue": false,
				"compaction.dropUseless": false,
				"compaction.supersedeReads": false,
			});
			session.settings.set("compaction.thresholdTokens", 50);
			appendUntouchedPrefix();
			appendUser("Read the notes.");
			appendToolTurn("read", { path: "notes.md" }, [{ type: "text", text: "notes" }]);
			appendAssistant([{ type: "text", text: "Noted." }], "stop");
			// The branch ends on the heavy result, so the cut keeps its turn and the tail elision replaces it.
			appendUser("Run the build.");
			const buildCall = appendToolTurn("bash", { command: "make" }, [
				{ type: "text", text: "BUILD LINE\n".repeat(3000) },
			]);
			session.agent.replaceMessages(session.buildDisplaySessionContext().messages);
			await manager.flush();

			if (artifact === "not saved") {
				const saveArtifact = SessionManager.prototype.saveArtifact;
				vi.spyOn(manager, "saveArtifact").mockImplementation(async (content: string, toolType: string) => {
					if (toolType === "compaction-tail") throw new Error("ENOSPC: no space left on device");
					return saveArtifact.call(manager, content, toolType);
				});
			}
			vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => ({
				summary: "threshold summary",
				shortSummary: undefined,
				firstKeptEntryId: preparation.firstKeptEntryId,
				tokensBefore: preparation.tokensBefore,
				details: {},
			}));
			// No headroom after the pass and nothing a rescue can free: the pass stamps a dead end.
			vi.spyOn(session, "getContextUsage").mockReturnValue({ tokens: 190_000, contextWindow: 200_000, percent: 95 });
			vi.spyOn(session, "shake").mockResolvedValue({
				mode: "elide",
				toolResultsDropped: 0,
				blocksDropped: 0,
				tokensFreed: 0,
			});
			vi.spyOn(session.agent, "prompt").mockImplementation(async () => {});

			await session.prompt("Continue.");

			expectEveryListedRewriteWhole(2);
			const reloaded = (await reload()).getEntries();
			const buildText = toolResultText(reloaded, buildCall);
			expect(buildText).not.toContain("BUILD LINE");
			expect(buildText.includes("artifact://")).toBe(artifact === "saved");
			const compaction = reloaded.filter((entry): entry is CompactionEntry => entry.type === "compaction").at(-1);
			expect(compaction?.warning).toContain("Compaction freed too little context to make progress");
		});
	}
});
