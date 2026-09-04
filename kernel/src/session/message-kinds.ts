/**
 * The role-keyed table of message kinds the domains contributed.
 *
 * `convertToLlm` reaches a role the provider vocabulary does not define — a `!` command, a `$`
 * Python run — and reads its conversion here. The table is filled by whoever assembles the tool
 * domains, from each manifest's `messageKinds`, and read by the session spine, which is how a
 * kernel module converts a shell message without importing the shell.
 *
 * FAIL LOUD ON A ROLE NOBODY DECLARED. A transcript holding a role with no kind is a transcript the
 * session cannot send: dropping the message would send the model a conversation with a hole in it
 * and no record of why, and the next turn would be answered against context the operator did not
 * see. The lookup throws and names the manifest member that declares a kind.
 *
 * ONE OWNER PER ROLE. Registering a second kind for a role a different kind already claims throws,
 * since two conversions for one role means the transcript's wording depends on load order. The same
 * kind object registered twice is a no-op, so a composition root may run more than once in one
 * process (the test runner does).
 */
import type { AgentMessage } from "@veyyon/session";
import type { AgentMessageKind } from "../registry/message-kind";

const kinds = new Map<AgentMessage["role"], AgentMessageKind>();

export function registerAgentMessageKinds(contributed: readonly AgentMessageKind[]): void {
	for (const kind of contributed) {
		const existing = kinds.get(kind.role);
		if (existing === kind) continue;
		if (existing !== undefined) {
			throw new Error(
				`message role "${kind.role}" already has a kind; a role is declared by one domain manifest's messageKinds`,
			);
		}
		kinds.set(kind.role, kind);
	}
}

/**
 * The kind a role converts through. Throws when no domain declared one, which is the difference
 * between a transcript the session refuses to send and one it sends with a message missing.
 */
export function agentMessageKind<TMessage extends AgentMessage>(role: TMessage["role"]): AgentMessageKind<TMessage> {
	const kind = kinds.get(role);
	if (kind === undefined) {
		throw new Error(
			`no message kind for role "${role}": a tool domain manifest declares it under messageKinds, and the tool registry registers every manifest's kinds before a session converts a transcript`,
		);
	}
	return kind as AgentMessageKind<TMessage>;
}

/** Every role a domain declared a kind for, in registration order. */
export function registeredAgentMessageRoles(): AgentMessage["role"][] {
	return [...kinds.keys()];
}
