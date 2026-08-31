import type { Api, AssistantMessage, Context, Model, SimpleStreamOptions } from "@veyyon/ai";

/**
 * The transport a SIDE request runs on: a request the session makes for itself
 * rather than for the conversation. A compaction summary, a handoff, a tree
 * navigation summary, the title a session gives itself, the label for a spawned
 * subagent, and the two classifiers that read a turn after it ends are all side
 * requests.
 *
 * Every one of them defaults to a bare `completeSimple`, which reads no operator
 * setting at all: no stream idle watchdog, no first-event watchdog, outside
 * `providers.maxInFlightRequests`, outside the per-provider concurrency cap, and
 * without `providers.openrouterVariant`. A side request is unattended by
 * definition, which is what makes those settings matter more there than on a turn
 * somebody is watching: the watchdogs are what END a request whose provider goes
 * silent, and the cap is what stops several from leaving at once.
 *
 * So a site that builds its own options names {@link AgentSession.sideComplete}
 * (`#sideCompleteImpl` from inside the session) rather than writing the adapter
 * again. One shape, one name, so a new side request cannot forget it by accident.
 */
export type SideCompleteImpl = <TApi extends Api>(
	model: Model<TApi>,
	ctx: Context,
	options: SimpleStreamOptions,
) => Promise<AssistantMessage>;
