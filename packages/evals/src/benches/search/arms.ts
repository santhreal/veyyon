/**
 * The implementations a search case is measured against.
 *
 * An arm answers a `SearchToolInput`. The bench runs every registered arm over every case
 * and compares each one against a declared reference arm, so "the tool agrees with the
 * engine it dispatches to" is one instance of a general comparison rather than the only
 * shape the bench can express. A second tool facade, a remote search service, a candidate
 * engine behind a flag: each is a registration, not an edit to the runner.
 *
 * An arm carries no timing or byte accounting. The runner owns measurement so every arm is
 * measured the same way.
 */
import type { AgentToolResult } from "@veyyon/agent-core";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import { executeFileSearch, type FileSearchDetails } from "@veyyon/coding-agent/tools/file-search";
import { SearchTool, type SearchToolDetails, type SearchToolInput } from "@veyyon/coding-agent/tools/search";
import { executeStructureSearch, type StructureSearchDetails } from "@veyyon/coding-agent/tools/structure-search";
import { executeTextSearch, type TextSearchDetails } from "@veyyon/coding-agent/tools/text-search";

/** What every arm returns: a tool result whose details are one of the four search shapes. */
export type SearchArmResult = AgentToolResult<
	SearchToolDetails | FileSearchDetails | TextSearchDetails | StructureSearchDetails
>;

/** The corpus an arm answers against, handed to it once per materialized corpus. */
export interface SearchArmContext {
	readonly session: ToolSession;
	readonly corpusDir: string;
}

/**
 * One implementation under measurement.
 *
 * `prepare` exists for an arm that owns per-corpus state — a tool instance, a warmed index,
 * a client — so the runner never rebuilds it per iteration and never leaks it across corpora.
 */
export interface SearchArm {
	readonly id: string;
	readonly description: string;
	prepare(context: SearchArmContext): SearchArmRunner;
}

export interface SearchArmRunner {
	run(callId: string, input: SearchToolInput, signal?: AbortSignal): Promise<SearchArmResult>;
	/** Released after the corpus is measured. Absent when the arm holds nothing. */
	dispose?(): Promise<void>;
}

/** The unified `search` tool a model reaches, schema dispatch included. */
export const UNIFIED_TOOL_ARM: SearchArm = {
	id: "unified-tool",
	description: "The production `search` tool facade, including type dispatch and cross-type refusal",
	prepare(context) {
		const tool = new SearchTool(context.session);
		return {
			run: (callId, input) => tool.execute(callId, input),
		};
	},
};

/** The production engines the tool dispatches to, called directly. */
export const DIRECT_ENGINE_ARM: SearchArm = {
	id: "direct-engine",
	description: "executeFileSearch / executeTextSearch / executeStructureSearch called without the facade",
	prepare(context) {
		return {
			run: (_callId, input, signal) => executeDirectEngine(context.session, input, signal),
		};
	},
};

/** Route one unified input to the engine that owns its type. */
export function executeDirectEngine(
	session: ToolSession,
	input: SearchToolInput,
	signal?: AbortSignal,
): Promise<AgentToolResult<FileSearchDetails | TextSearchDetails | StructureSearchDetails>> {
	if (input.type === "files") {
		return executeFileSearch(
			session,
			{ path: input.input, hidden: input.hidden, gitignore: input.gitignore, limit: input.limit },
			signal,
		);
	}
	if (input.type === "text") {
		return executeTextSearch(
			session,
			{ pattern: input.input, path: input.path, case: input.case, gitignore: input.gitignore, skip: input.skip },
			signal,
		);
	}
	return executeStructureSearch(session, { pattern: input.input, path: input.path, skip: input.skip }, signal);
}
