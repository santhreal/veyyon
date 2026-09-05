import type { AgentMessage } from "@veyyon/session";
import type { AgentMessageKind } from "../../src/registry/message-kind";
import {
	agentMessageKind,
	registerAgentMessageKinds,
	registeredAgentMessageRoles,
} from "../../src/session/message-kinds";

type UserMessage = Extract<AgentMessage, { role: "user" }>;
const message: UserMessage = { role: "user", content: "registered message", timestamp: 0 };
const kind: AgentMessageKind<UserMessage> = {
	role: "user",
	toLlm: value => [value],
	toText: value => (typeof value.content === "string" ? value.content : "structured message"),
};
registerAgentMessageKinds([kind]);
registerAgentMessageKinds([kind]);
let collision: string | undefined;
try {
	registerAgentMessageKinds([{ role: "user", toLlm: () => [], toText: () => "replacement" }]);
} catch (error) {
	if (!(error instanceof Error)) throw error;
	collision = error.message;
}
const registered = agentMessageKind<UserMessage>("user");
process.stdout.write(
	JSON.stringify({
		roles: registeredAgentMessageRoles(),
		text: registered.toText(message),
		messages: registered.toLlm(message),
		collision,
	}),
);
