import type { Message } from "@veyyon/model";

/**
 * Message shapes an application adds to {@link AgentMessage}, by declaration merging.
 *
 * ```ts
 * declare module "@veyyon/session" {
 *   interface CustomAgentMessages {
 *     artifact: ArtifactMessage;
 *     notification: NotificationMessage;
 *   }
 * }
 * ```
 */
export interface CustomAgentMessages {
	// Empty by default; an application extends it by declaration merging.
}

/**
 * A message in a session: an LLM {@link Message} or one of the application's own.
 *
 * An application adds its own message kinds while the base LLM messages stay typed; the agent
 * converts the union to `Message[]` before each LLM call.
 */
export type AgentMessage = Message | CustomAgentMessages[keyof CustomAgentMessages];
