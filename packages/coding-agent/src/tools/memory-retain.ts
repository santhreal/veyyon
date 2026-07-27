import type { AgentTool, AgentToolResult } from "@veyyon/agent-core";
import { type } from "arktype";
import { toolsPrompts } from "../prompts/tools/rows";
import type { ToolSession } from ".";
import { abortedPartway } from "./aborted-partway";
import { throwIfAborted } from "./tool-errors";

const memoryRetainSchema = type({
	items: type({
		content: type("string").describe("information to remember"),
		"context?": type("string").describe("source context"),
	})
		.array()
		.atLeastLength(1)
		.describe("memories to retain"),
});

export type MemoryRetainParams = typeof memoryRetainSchema.infer;

/** One item as the abort message names it: its context when it has one, else its opening words. */
function itemLabel(item: { content: string; context?: string }, index: number): string {
	const context = item.context?.trim();
	if (context) return context;
	const head = item.content.trim().split("\n")[0] ?? "";
	return head.length > 48 ? `${head.slice(0, 45)}...` : head || `item ${index + 1}`;
}

/**
 * The abort for a retain cancelled between items, with mnemopi as the backend.
 *
 * `rememberScoped` writes to the store per item, so a cancellation halfway leaves some
 * memories stored and the rest not, and there is no rollback: a stored memory is a fact the
 * agent will recall later. The message therefore names what landed rather than implying the
 * whole call was undone, using the sentence `tools/aborted-partway.ts` builds for every tool
 * that can stop halfway.
 */
function retainAbortedPartway(
	stored: readonly string[],
	remaining: ReadonlyArray<{ content: string; context?: string }>,
	cause: unknown,
) {
	return abortedPartway(
		{
			operation: "Retain",
			unit: { one: "memory", many: "memories" },
			done: stored,
			pending: remaining.map((item, index) => itemLabel(item, stored.length + index)),
			doneLabel: "already stored",
			pendingLabel: "NOT stored",
			adviceWhenDone: "the memories above are in the store and were not rolled back",
		},
		cause,
	);
}

export class MemoryRetainTool implements AgentTool<typeof memoryRetainSchema> {
	readonly name = "retain";
	readonly approval = "read" as const;
	readonly label = "Retain";
	readonly description = toolsPrompts["tools/retain"].text;
	readonly parameters = memoryRetainSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Store important facts in long-term memory";

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): MemoryRetainTool | null {
		const backend = session.settings.get("memory.backend");
		if (backend !== "hindsight" && backend !== "mnemopi") return null;
		return new MemoryRetainTool(session);
	}

	/**
	 * Store every item, refusing outright if the operator has already cancelled.
	 *
	 * Deliberately NOT wrapped in `untilAborted`, which the two READING memory tools use.
	 * Racing a mutation against the signal rejects while the writes keep going, so the
	 * operator is told the retain was cancelled and the memories land anyway. Instead the
	 * signal is checked before the first write and between items: what is stored is stored,
	 * and the abort says how many that was.
	 */
	async execute(_id: string, params: MemoryRetainParams, signal?: AbortSignal): Promise<AgentToolResult> {
		throwIfAborted(signal);
		const backend = this.session.settings.get("memory.backend");
		if (backend === "mnemopi") {
			const state = this.session.getMnemopiSessionState?.();
			if (!state) {
				throw new Error("Mnemopi backend is not initialised for this session.");
			}

			const stored: string[] = [];
			for (const [index, item] of params.items.entries()) {
				if (signal?.aborted) throw retainAbortedPartway(stored, params.items.slice(index), signal.reason);
				state.rememberScoped(item.content, {
					source: "coding-agent-retain",
					importance: 0.75,
					metadata: {
						session_id: state.sessionId,
						cwd: state.session.sessionManager.getCwd(),
						context: item.context ?? null,
						tool: "retain",
					},
					scope: "bank",
					extract: true,
					extractEntities: true,
					veracity: "tool",
					memoryType: "fact",
				});
				stored.push(itemLabel(item, index));
			}

			const count = params.items.length;
			const noun = count === 1 ? "memory" : "memories";
			return {
				content: [{ type: "text", text: `${count} ${noun} stored.` }],
				details: { count },
			};
		}

		const state = this.session.getHindsightSessionState?.();
		if (!state) {
			throw new Error("Hindsight backend is not initialised for this session.");
		}

		// Push every item onto the session-owned queue and return immediately.
		//
		// Nothing is written to the store here, so a cancellation between items has nothing to
		// report: the queue flushes later, and dropping the remaining items would be a silent
		// partial retain. The entry check above is the whole cancellation contract for this
		// backend.
		// The queue flushes either when it reaches its batch threshold or when
		// its debounce timer fires. If the eventual batch fails, the queue
		// surfaces a UI-only warning notice — the LLM is not informed.
		for (const item of params.items) {
			state.enqueueRetain(item.content, item.context);
		}

		const count = params.items.length;
		const noun = count === 1 ? "memory" : "memories";
		return {
			content: [{ type: "text", text: `${count} ${noun} queued.` }],
			details: { count },
		};
	}
}
