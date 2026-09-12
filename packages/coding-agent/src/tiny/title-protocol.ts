import type { WorkerOutboundBase } from "../subprocess/worker-client";
import type {
	WorkerProgressEvent,
	WorkerProgressFileState,
	WorkerProgressMessage,
	WorkerProgressStatus,
} from "../subprocess/worker-request-client";
import type { TinyLocalModelKey, TinyTitleLocalModelKey } from "./models";

export type TinyTitleProgressStatus = WorkerProgressStatus;
export type TinyTitleProgressFileState = WorkerProgressFileState;
export type TinyTitleProgressEvent = WorkerProgressEvent<TinyLocalModelKey>;

export type TinyTitleWorkerInbound =
	| { type: "ping"; id: string }
	| { type: "generate"; id: string; modelKey: TinyTitleLocalModelKey; message: string; systemPrompt?: string }
	| { type: "complete"; id: string; modelKey: TinyLocalModelKey; prompt: string; maxTokens?: number }
	| { type: "download"; id: string; modelKey: TinyLocalModelKey };

export type TinyTitleWorkerOutbound =
	| WorkerOutboundBase
	| WorkerProgressMessage<TinyLocalModelKey>
	| { type: "title"; id: string; title: string | null }
	| { type: "completion"; id: string; text: string | null }
	| { type: "downloaded"; id: string };

/**
 * Wire transport between the parent (`TinyTitleClient`) and the tiny-model
 * subprocess. The parent owns the subprocess lifecycle (graceful work, hard
 * kill on shutdown); the protocol therefore carries no explicit close
 * handshake — once the parent decides to terminate, it signals the OS to
 * reap the child so `onnxruntime-node`'s NAPI finalizer never runs in any
 * shared address space. See `title-client.ts` for the spawn/kill glue.
 */
export interface TinyTitleTransport {
	send(message: TinyTitleWorkerOutbound): void;
	onMessage(handler: (message: TinyTitleWorkerInbound) => void): () => void;
}
