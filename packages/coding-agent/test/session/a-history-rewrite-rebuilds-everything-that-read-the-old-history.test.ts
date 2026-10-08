/**
 * WHY: a pass that rewrites recorded history in place leaves every reader of the old history stale
 * unless it also runs the epilogue: persist the changed entries, rebuild the agent's context from
 * them, reset the advisor runtimes, close the provider sessions that cache message identity, and mark
 * the context report. Before the passes shared one epilogue, three rewrite paths re-anchored the
 * context report and four did not, including `/shake` from both front ends: the report counted bytes
 * a pass had removed, and the compaction decision could not skip a summarization the pass made
 * unnecessary.
 *
 * The class is "a rewrite pass skips, reorders or repeats part of the epilogue", with two siblings a
 * selecting pass can fall into: rewriting an entry the compaction in effect already summarized away
 * (disk churn with no prompt effect), and eliding a result the plan protects. The suite enumerates the
 * public passes of `HistoryRewrites` from its prototype at run time and fails on a pass without a
 * recorded scenario. Each scenario builds real history in a real `SessionManager`, and the same
 * material serves as the positive control for the boundary and protection rows, so a row cannot pass
 * because its material was never eligible. The passes that do not select from the branch are pinned
 * by exact equality.
 *
 * WHAT THIS DOES NOT CATCH: whether the persisted bytes match the in-memory rewrite
 * (`a-history-rewrite-lists-every-entry-it-changed.test.ts` owns that), what the context report reads
 * after the mark (`the-context-figure-reads-only-usage-that-describes-the-next-prompt.test.ts`), and a
 * rewrite of history written outside this collaborator, such as a compaction's tail elision.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { AGGRESSIVE_SHAKE_CONFIG, collectShakeRegions } from "@veyyon/agent-core/compaction";
import type { AssistantMessage, ImageContent, TextContent, ToolResultMessage } from "@veyyon/ai";
import { getBundledModel } from "@veyyon/catalog/models";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { HistoryRewrites } from "@veyyon/coding-agent/session/runtime/history-rewrites";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { TempDir } from "@veyyon/utils";

/** The epilogue every pass that changed an entry runs, once and in this order. */
const EPILOGUE = [
	"rewriteEntries",
	"replaceMessages",
	"resetAdvisorRuntimes",
	"closeCodexSessions",
	"markHistoryRewritten",
] as const;

/** Tools the scenarios read from; a plan that protects them leaves every selecting pass nothing. */
const MATERIAL_TOOLS = ["bash", "read", "search"];

/**
 * How a pass picks what it rewrites:
 * - `live`: from the branch after the keep boundary, minus the tools the plan protects.
 * - `branch`: every entry on the branch.
 * - `caller`: the regions its caller hands it.
 */
type Selection = "live" | "branch" | "caller";

interface Scenario {
	selection: Selection;
	/** Appends history the pass rewrites. */
	material(tape: Tape): void;
	run(rewrites: HistoryRewrites, manager: SessionManager): Promise<unknown>;
}

const PNG: ImageContent = { type: "image", data: "iVBORw0KGgo", mimeType: "image/png" };

const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

class Tape {
	readonly #manager: SessionManager;
	readonly #apiInfo: Pick<AssistantMessage, "api" | "provider" | "model">;

	constructor(manager: SessionManager) {
		this.#manager = manager;
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("expected the bundled anthropic model");
		this.#apiInfo = { api: model.api, provider: model.provider, model: model.id };
	}

	user(content: string | (TextContent | ImageContent)[]): string {
		return this.#manager.appendMessage({ role: "user", content, timestamp: Date.now() });
	}

	assistant(text: string): void {
		this.#manager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text }],
			...this.#apiInfo,
			stopReason: "stop",
			usage,
			timestamp: Date.now(),
		});
	}

	toolTurn(
		toolName: string,
		args: Record<string, unknown>,
		text: string,
		extra: Partial<ToolResultMessage> = {},
	): void {
		const toolCallId = `call-${toolName}-${this.#manager.getEntries().length}`;
		this.#manager.appendMessage({
			role: "assistant",
			content: [{ type: "toolCall", id: toolCallId, name: toolName, arguments: args }],
			...this.#apiInfo,
			stopReason: "toolUse",
			usage,
			timestamp: Date.now(),
		});
		this.#manager.appendMessage({
			role: "toolResult",
			toolCallId,
			toolName,
			content: [{ type: "text", text }],
			isError: false,
			timestamp: Date.now(),
			...extra,
		});
	}
}

function heavyShellResults(tape: Tape): void {
	for (let i = 0; i < 3; i++) {
		tape.user(`run step ${i}`);
		tape.toolTurn("bash", { command: `step ${i}` }, `${i}`.repeat(4000));
	}
}

const SCENARIOS: Record<string, Scenario> = {
	pruneStale: {
		selection: "live",
		material(tape) {
			tape.user("Read the target.");
			tape.toolTurn("read", { path: "src/target.ts" }, "STALE\n".repeat(200));
			tape.user("Read it again.");
			tape.toolTurn("read", { path: "src/target.ts" }, "FRESH\n".repeat(200));
		},
		run: rewrites => rewrites.pruneStale(),
	},
	pruneOverflow: {
		selection: "live",
		material(tape) {
			// A result its tool flagged useless bypasses the protect-recent window; it has to sit inside
			// the warm tail and free more than the minimum savings.
			tape.user("Search for it.");
			tape.toolTurn("search", { type: "text", input: "missing" }, "NOTHING\n".repeat(15_000), { useless: true });
			tape.user("Carry on.");
			tape.assistant("Carrying on.");
		},
		run: rewrites => rewrites.pruneOverflow(),
	},
	dropImages: {
		selection: "branch",
		material(tape) {
			tape.user([{ type: "text", text: "look at this" }, PNG]);
			tape.assistant("Seen.");
		},
		run: rewrites => rewrites.dropImages(),
	},
	shake: {
		selection: "live",
		material: heavyShellResults,
		run: rewrites => rewrites.shake("elide"),
	},
	dedupeRedundantToolResults: {
		selection: "live",
		material(tape) {
			for (let i = 0; i < 3; i++) {
				tape.user(`list again ${i}`);
				tape.toolTurn("bash", { command: "ls" }, "IDENTICAL_BODY\n".repeat(20));
			}
		},
		run: rewrites => rewrites.dedupeRedundantToolResults(),
	},
	offloadAndApply: {
		selection: "caller",
		material: heavyShellResults,
		run: (rewrites, manager) =>
			rewrites.offloadAndApply(collectShakeRegions(manager.getBranch(), AGGRESSIVE_SHAKE_CONFIG)),
	},
};

function passNames(): string[] {
	return Object.getOwnPropertyNames(HistoryRewrites.prototype)
		.filter(name => name !== "constructor")
		.sort();
}

describe("a history rewrite rebuilds everything that read the old history", () => {
	let tempDir: TempDir;
	let manager: SessionManager;
	let tape: Tape;
	let log: string[];
	let keepBoundaryId: string | undefined;
	let protectMaterial: boolean;

	function rewrites(): HistoryRewrites {
		return new HistoryRewrites({
			sessionStore: {
				getBranch: () => manager.getBranch(),
				rewriteEntries: async updated => {
					log.push("rewriteEntries");
					await manager.rewriteEntries(updated);
				},
				saveArtifact: (content, toolType) => manager.saveArtifact(content, toolType),
			},
			agent: { replaceMessages: () => log.push("replaceMessages") },
			settings: Settings.isolated({ "compaction.supersedeReads": true, "compaction.dropUseless": true }),
			withPlanProtection: config =>
				protectMaterial ? { ...config, protectedTools: [...config.protectedTools, ...MATERIAL_TOOLS] } : config,
			model: () => undefined,
			keepBoundaryId: () => keepBoundaryId,
			rebuiltMessages: () => manager.buildSessionContext().messages,
			resetAdvisorRuntimes: () => log.push("resetAdvisorRuntimes"),
			closeCodexSessions: () => log.push("closeCodexSessions"),
			markHistoryRewritten: () => log.push("markHistoryRewritten"),
			syncTodos: () => log.push("syncTodos"),
		});
	}

	beforeEach(() => {
		tempDir = TempDir.createSync("@veyyon-history-rewrites-");
		manager = SessionManager.create(tempDir.path(), tempDir.path());
		tape = new Tape(manager);
		log = [];
		keepBoundaryId = undefined;
		protectMaterial = false;
		tape.user("Start the task.");
		tape.assistant("Starting.");
	});

	afterEach(async () => {
		await tempDir.remove();
	});

	it("has a scenario for every pass the collaborator exposes", () => {
		expect(Object.keys(SCENARIOS).sort()).toEqual(passNames());
	});

	it("exempts only the passes that do not select from the live branch", () => {
		const exempt = Object.entries(SCENARIOS)
			.filter(([, scenario]) => scenario.selection !== "live")
			.map(([name]) => name)
			.sort();
		expect(exempt).toEqual(["dropImages", "offloadAndApply"]);
	});

	for (const [name, scenario] of Object.entries(SCENARIOS)) {
		describe(name, () => {
			it("runs the whole epilogue once, in order, after changing history", async () => {
				scenario.material(tape);

				await scenario.run(rewrites(), manager);

				expect(log.filter(step => step !== "syncTodos")).toEqual([...EPILOGUE]);
				// A todo re-read that runs has to read the rewritten branch.
				const sync = log.indexOf("syncTodos");
				if (sync !== -1) expect(sync).toBeGreaterThan(log.indexOf("rewriteEntries"));
			});

			if (scenario.selection !== "caller") {
				it("writes nothing when nothing is eligible", async () => {
					tape.user("Nothing to shrink here.");
					tape.assistant("Agreed.");

					await scenario.run(rewrites(), manager);

					expect(log).toEqual([]);
				});
			}

			if (scenario.selection === "live") {
				it("leaves history the compaction in effect summarized away", async () => {
					scenario.material(tape);
					keepBoundaryId = tape.user("Summarized up to here.");
					tape.assistant("Continuing from the summary.");
					const before = JSON.stringify(manager.getBranch());

					await scenario.run(rewrites(), manager);

					expect(log).toEqual([]);
					expect(JSON.stringify(manager.getBranch())).toBe(before);
				});

				it("leaves the results of tools the plan protects", async () => {
					scenario.material(tape);
					protectMaterial = true;
					const before = JSON.stringify(manager.getBranch());

					await scenario.run(rewrites(), manager);

					expect(log).toEqual([]);
					expect(JSON.stringify(manager.getBranch())).toBe(before);
				});
			}
		});
	}
});
