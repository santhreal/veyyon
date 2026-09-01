import type { Api, Context, Model, SimpleStreamOptions, ToolChoice } from "@veyyon/ai";
import type { AssistantMessageEventStream } from "@veyyon/ai/utils/event-stream";

export const SIM_API = "bedrock-converse-stream" as const;

export const SIM_IDLE_BUDGET_SECONDS = 0.3;
export const SIM_FIRST_EVENT_BUDGET_SECONDS = 0.3;
export const SIM_COST_PER_TOKEN = 0.001;

export interface ScriptedTurn {
	readonly stream: AssistantMessageEventStream;
	readonly call: number;
	readonly model: Model<Api>;
	readonly context: Context;
	readonly signal: AbortSignal | undefined;
	readonly toolChoice: ToolChoice | undefined;
	readonly cacheRouting: { readonly sessionId: string | undefined; readonly promptCacheKey: string | undefined };
	readonly options: SimpleStreamOptions | undefined;
	text(value: string): void;
	thinking(value: string, signature?: string): void;
	openThinking(partialValue: string): void;
	toolCall(name: string, args: Record<string, unknown>, id?: string, intent?: string): void;
	openToolCall(name: string, partialArgs: string, id?: string, intent?: string): void;
	execResolvedToolCall(name: string, args: Record<string, unknown>, id?: string, intent?: string): void;
	usage(counts: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }): void;
	finish(reason?: "stop" | "toolUse" | "length"): void;
	fail(message: string, errorId?: number): void;
	trackLocalWork(work: Promise<unknown>): Promise<void>;
	onLocalWorkProbe(callback: (probeCount: number) => void): void;
}

export type ProviderScript = (turn: ScriptedTurn) => void | Promise<void>;
