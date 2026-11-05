/**
 * What a conversation holds that ends with it: the agents it spawned, its place in the agent
 * registry, the IRC traffic of its agents, the standing approval grants given in it, and its eval
 * kernels.
 *
 * This is a session collaborator. A `/new` or `/resume` swaps the transcript under the same
 * session, and nothing else tells the process-global registry, IRC bus or kernel pool that the
 * previous conversation ended; {@link ConversationRelease.release} does. It reaches the session only
 * through {@link ConversationReleaseHost}.
 */
import { disposeOwnedResources } from "@veyyon/kernel/session/owned-resources";
import { errorMessage, logger } from "@veyyon/utils";
import { AgentLifecycleManager } from "../../registry/agent-lifecycle";
import { AgentRegistry } from "../../registry/agent-registry";
import { IrcBus } from "../../task/irc-bus";
import { RESCOPE_TERMINATE_REASON } from "../agent-session-types";

/** What {@link ConversationRelease} needs from the session that holds it. */
export interface ConversationReleaseHost {
	/** The id of the transcript the session now records to, which becomes the agent's new scope. */
	sessionId(): string | undefined;
	/** Drop the per-tool approval decisions kept for this conversation. */
	forgetToolDecisions(): void;
}

export class ConversationRelease {
	readonly #host: ConversationReleaseHost;
	readonly #agentId: string | undefined;
	readonly #evalKernelOwnerId: string;

	constructor(host: ConversationReleaseHost, agentId: string | undefined, evalKernelOwnerId: string) {
		this.#host = host;
		this.#agentId = agentId;
		this.#evalKernelOwnerId = evalKernelOwnerId;
	}

	/**
	 * Release what the conversation the session just left holds: its spawned agents and registry
	 * scope, then its eval kernels.
	 *
	 * A kernel is keyed by the transcript's eval session id, so no cell of the next conversation
	 * reaches the previous one's kernel, and it kept its interpreter's memory until the session
	 * ended: a window open for days held one kernel per conversation. The release runs the registry
	 * `dispose` uses, so every eval language goes with it; a kernel a spawned agent still shares
	 * stays alive for that agent. A cell still running in a released kernel ends cancelled: the pool
	 * no longer holds its session, so it is not retried into a fresh kernel. A release that fails is
	 * logged and does not fail the switch.
	 */
	async release(): Promise<void> {
		await this.#rescope();
		try {
			await disposeOwnedResources("eval-kernel-owner", this.#evalKernelOwnerId);
		} catch (error) {
			logger.warn("Some eval kernels of the previous conversation failed to release", {
				error: errorMessage(error),
			});
		}
	}

	/**
	 * Re-root the session's agent in the registry after it moved to a different transcript, and
	 * release the spawned agents of the conversation it left.
	 *
	 * The registry is process-global, so every spawned agent of the previous conversation would stay
	 * registered: the agent dashboard would list it, `irc list` would offer it as a peer, and
	 * messaging it would wake an agent whose replies land in a transcript already left. An asleep ref
	 * holds its session file and a live one holds a whole session, so it is a leak as well.
	 *
	 * The descendants are terminated BEFORE the re-scope, while they still resolve as this agent's
	 * subtree; re-scoping first would leave them parented to a scope nothing walks. Their background
	 * jobs are cancelled by the caller first, on the same subtree.
	 *
	 * Terminate, not release: release disposes the session, and dispose stops the agent loop but
	 * leaves its bash, eval, handoff and advisor work running and its scheduled continuations armed.
	 * `terminate` aborts a running agent first, deepest generation first, which is the kill the
	 * dashboard and `job cancel` use.
	 */
	async #rescope(): Promise<void> {
		const id = this.#agentId;
		if (!id) return;
		const registry = AgentRegistry.global();
		const self = registry.get(id);
		if (!self) return;
		const endingScope = self.scope;
		const descendants = registry.descendantsOf(id);
		await this.terminateSpawnedAgents(RESCOPE_TERMINATE_REASON);
		// The traffic goes whether or not anything was still registered to release: an agent that
		// finished and aged out, or was disposed, is unregistered by the time `/new` runs, and the
		// previous conversation's log would otherwise open the next conversation's Comms pane.
		//
		// This agent's own legs go too. `forgetAgents` drops a line when EITHER endpoint is named,
		// and every line of the ended conversation has a released child or this agent on it. The
		// ENDING scope bounds the purge, so it cannot reach a line another conversation in this
		// process recorded under a recycled agent name.
		IrcBus.global().forgetAgents(descendants.concat([id]), endingScope);
		// Standing approval grants end with the conversation they were given in: "Allow bash for this
		// session" answers for the work in front of it, and `/new` or `/resume` replaces that work.
		this.#host.forgetToolDecisions();
		registry.rescope(id, this.#host.sessionId());
		logger.debug("Re-rooted the agent registry for a new conversation", {
			agentId: id,
			from: endingScope,
			to: registry.get(id)?.scope,
			released: descendants.length,
		});
	}

	/**
	 * Terminate every agent this session spawned, each direct child with its own subtree, deepest
	 * generation first. A termination that throws is logged and skipped, so an agent that cannot be
	 * stopped does not strand the session between two conversations. Used when a conversation ends
	 * while the process keeps running: a `/new` or `/resume` in place, and the disposal of a
	 * top-level session that is not the last one in the process.
	 */
	async terminateSpawnedAgents(reason: string): Promise<void> {
		const id = this.#agentId;
		if (!id) return;
		const registry = AgentRegistry.global();
		const children = registry.descendantsOf(id).filter(descendant => registry.get(descendant)?.parentId === id);
		if (children.length === 0) return;
		const lifecycle = AgentLifecycleManager.global();
		await Promise.all(
			children.map(async child => {
				try {
					await lifecycle.terminate(child, reason);
				} catch (error) {
					logger.warn("Failed to terminate a spawned agent of an ending conversation", {
						agentId: child,
						error: errorMessage(error),
					});
				}
			}),
		);
	}
}
