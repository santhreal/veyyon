import type { FetchImpl } from "@veyyon/ai";
import { getMnemopiRuntimeOptions, type MnemopiLlmPayloadHook } from "./runtime-options";

/** Secret-free value held in online request bodies until the attempt hook runs. */
export const MNEMOPI_LLM_ATTEMPT_PLACEHOLDER = "[mnemopi payload pending attempt-time sanitization]";

export interface CompleteOptions {
	maxTokens?: number;
	temperature?: number;
	timeout?: number;
	provider?: string | null;
	model?: string | null;
	fetch?: FetchImpl;
	onPayload?: MnemopiLlmPayloadHook;
}

export interface LlmBackend {
	name?: string;
	/** True only when this callback can cross a process or provider boundary. */
	online?: boolean;
	/** Capability declaration required before raw context is made available through `onPayload`. */
	supportsAttemptPayload?: true;
	complete(prompt: string, opts?: CompleteOptions): string | null | Promise<string | null>;
}

export interface CallableLlmBackendOptions {
	online?: boolean;
	supportsAttemptPayload?: true;
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

function defaultOnlinePayload(payload: unknown, rawPrompt: string): unknown {
	const sanitize = getMnemopiRuntimeOptions()?.llm?.sanitizeProviderText;
	const visit = (value: unknown): unknown => {
		if (typeof value === "string") {
			const raw = value === MNEMOPI_LLM_ATTEMPT_PLACEHOLDER ? rawPrompt : value;
			if (sanitize === undefined) return raw;
			try {
				return sanitize(raw);
			} catch {
				throw new Error("Mnemopi provider text sanitization failed.");
			}
		}
		if (Array.isArray(value)) return value.map(visit);
		if (value === null || typeof value !== "object") return value;
		const copy: Record<string, unknown> = {};
		for (const [key, child] of Object.entries(value)) copy[key] = visit(child);
		return copy;
	};
	return visit(payload);
}

export async function callHostLlm(prompt: string, opts: CompleteOptions = {}): Promise<string | null> {
	const backend = getHostLlmBackend();
	if (backend === null) {
		return null;
	}

	if (backend.online !== true) {
		const { onPayload: _onlineOnly, ...localOpts } = opts;
		const result = await backend.complete(prompt, localOpts);
		return typeof result === "string" ? result : null;
	}
	if (backend.supportsAttemptPayload !== true) {
		throw new Error("Online Mnemopi host LLM backend does not support attempt-time payload sanitization.");
	}

	let applied = false;
	const onPayload: MnemopiLlmPayloadHook = async payload => {
		applied = true;
		const hook = opts.onPayload;
		return hook === undefined ? defaultOnlinePayload(payload, prompt) : await hook(payload);
	};
	const result = await backend.complete(MNEMOPI_LLM_ATTEMPT_PLACEHOLDER, { ...opts, onPayload });
	if (!applied) {
		throw new Error("Online Mnemopi host LLM backend did not apply its attempt-time payload hook.");
	}
	return typeof result === "string" ? result : null;
}

export class CallableLlmBackend implements LlmBackend {
	readonly online: boolean;
	readonly supportsAttemptPayload: true | undefined;

	constructor(
		public name: string,
		private readonly fn: (prompt: string, opts?: CompleteOptions) => string | null | Promise<string | null>,
		options: CallableLlmBackendOptions = {},
	) {
		this.online = options.online === true;
		this.supportsAttemptPayload = options.supportsAttemptPayload;
	}

	complete(prompt: string, opts?: CompleteOptions): string | null | Promise<string | null> {
		return this.fn(prompt, opts);
	}
}
