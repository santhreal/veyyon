import type { Api, AssistantMessage, Context, Model, SimpleStreamOptions } from "@veyyon/ai";

/** The transport a SIDE request runs on: a request the session makes for itself rather than for the conversation. A compaction summary, a handoff, a tree */
export type SideCompleteImpl = <TApi extends Api>(
	model: Model<TApi>,
	ctx: Context,
	options: SimpleStreamOptions,
) => Promise<AssistantMessage>;
