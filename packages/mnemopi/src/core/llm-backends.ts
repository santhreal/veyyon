import type { FetchImpl } from "@veyyon/ai";

export interface CompleteOptions {
	maxTokens?: number;
	temperature?: number;
	timeout?: number;
	provider?: string | null;
	model?: string | null;
	fetch?: FetchImpl;
}

export interface LlmBackend {
	name?: string;
	complete(prompt: string, opts?: CompleteOptions): string | null | Promise<string | null>;
}

let hostBackend: LlmBackend | null = null;

export function setHostLlmBackend(backend: LlmBackend | null | undefined): void {
	hostBackend = backend ?? null;
}

export function getHostLlmBackend(): LlmBackend | null {
	return hostBackend;
}

export function resetHostLlmBackendForTests(): void {
	hostBackend = null;
}

export async function callHostLlm(prompt: string, opts: CompleteOptions = {}): Promise<string | null> {
	const backend = getHostLlmBackend();
	if (backend === null) {
		return null;
	}

	// Do NOT swallow backend errors here. A throw (the backend crashed, an
	// adapter bug, a timeout) must reach the caller so it can be classified: the
	// extraction layer records it as a real failure (host_adapter_raised) and the
	// summarization layer logs it and falls through to a local backend. A bare
	// `catch { return null }` here would misreport a hard failure as "the model
	// produced no output", losing the error entirely (a Law 10 silent fallback).
	const result = await backend.complete(prompt, opts);
	return typeof result === "string" ? result : null;
}

export class CallableLlmBackend implements LlmBackend {
	constructor(
		public name: string,
		private readonly fn: (prompt: string, opts?: CompleteOptions) => string | null | Promise<string | null>,
	) {}

	complete(prompt: string, opts?: CompleteOptions): string | null | Promise<string | null> {
		return this.fn(prompt, opts);
	}
}
