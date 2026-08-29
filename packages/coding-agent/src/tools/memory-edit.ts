import type { AgentTool, AgentToolResult } from "@veyyon/agent-core";
import { clampLow } from "@veyyon/utils";
import { toolsPrompts } from "../prompts/tools/rows";
import type { ToolSession } from ".";
import type { MemoryEditParams } from "./memory-edit-helpers";

import { memoryEditSchema } from "./memory-edit-helpers";
import { throwIfAborted } from "./tool-errors";

export class MemoryEditTool implements AgentTool<typeof memoryEditSchema> {
	readonly name = "memory_edit";
	readonly approval = "read" as const;
	readonly label = "Memory Edit";
	readonly description = toolsPrompts["tools/memory-edit"].text;
	readonly parameters = memoryEditSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Update, forget, or invalidate Mnemopi memories";

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): MemoryEditTool | null {
		const backend = session.settings.get("memory.backend");
		if (backend !== "mnemopi") return null;
		return new MemoryEditTool(session);
	}

	/** Apply one memory edit, refusing outright if the operator has already cancelled. There is nothing to interrupt once it starts: `editScopedMemory` is a single synchronous */
	async execute(_id: string, params: MemoryEditParams, signal?: AbortSignal): Promise<AgentToolResult> {
		throwIfAborted(signal);
		const state = this.session.getMnemopiSessionState?.();
		if (!state) {
			throw new Error("Mnemopi backend is not initialised for this session.");
		}
		if (params.op === "update" && params.content === undefined && params.importance === undefined) {
			throw new Error("memory_edit update requires content or importance.");
		}

		const importance = params.importance === undefined ? undefined : clampLow(params.importance, 0, 1);
		const result = state.editScopedMemory(params.op, params.id, {
			content: params.content,
			importance,
			replacementId: params.replacement_id,
		});
		const location = result.bank ? ` in bank ${result.bank}${result.store ? ` (${result.store})` : ""}` : "";
		const text =
			result.status === "not_found"
				? `Memory ${params.id} was not found${location}.`
				: result.status === "not_editable"
					? `Memory ${params.id} is a read-only fact${location}; it cannot be edited. Read it with memory://${params.id}.`
					: `Memory ${params.id} ${result.status}${location}.`;
		return {
			content: [{ type: "text", text }],
			details: result,
		};
	}
}
