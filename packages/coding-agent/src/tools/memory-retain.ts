import type { AgentTool, AgentToolResult } from "@veyyon/agent-core";
import { toolsPrompts } from "../prompts/tools/rows";
import type { ToolSession } from ".";
import type { MemoryRetainParams } from "./memory-retain-helpers";

import { assertMemoryRetainLimits, itemLabel, memoryRetainSchema, retainAbortedPartway } from "./memory-retain-helpers";
import { throwIfAborted } from "./tool-errors";

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

	/** Store every item, refusing outright if the operator has already cancelled. Deliberately NOT wrapped in `untilAborted`, which the two READING memory tools use. */
	async execute(_id: string, params: MemoryRetainParams, signal?: AbortSignal): Promise<AgentToolResult> {
		throwIfAborted(signal);
		assertMemoryRetainLimits(params.items);
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

		// Atomically enqueue the whole call. A full queue rejects before retaining
		// any item, rather than reporting a partial success the caller cannot
		// reconcile.
		state.enqueueRetains(params.items);

		const count = params.items.length;
		const noun = count === 1 ? "memory" : "memories";
		return {
			content: [{ type: "text", text: `${count} ${noun} queued.` }],
			details: { count },
		};
	}
}
