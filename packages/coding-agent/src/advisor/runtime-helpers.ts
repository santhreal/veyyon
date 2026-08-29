import type { AgentMessage } from "@veyyon/agent-core";
import type { SecretObfuscator } from "../secrets/obfuscator";

export interface AdvisorAgent {
	prompt(input: string): Promise<void>;
	abort(reason?: unknown): void;
	reset(): void;
	rollbackTo?(count: number): void;
	readonly state: { messages: AgentMessage[]; error?: string };
}

export interface AdvisorRuntimeHost {
	snapshotMessages(): AgentMessage[];
	enqueueAdvice(note: string, severity?: "nit" | "concern" | "blocker"): void;
	obfuscator?: SecretObfuscator;
	maintainContext?(incomingTokens: number): Promise<boolean>;
	beginAdvisorUpdate?(): void;
	onTurnError?(error: unknown): Promise<void> | void;
	notifyFailure?(error: unknown): void;
}

export const ADVISOR_QUARANTINE_PREFIX = "Advisor response quarantined";
