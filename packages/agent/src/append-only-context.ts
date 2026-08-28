import type { Context, Message, Tool } from "@veyyon/ai";
import type { Dialect } from "@veyyon/ai/dialect";
import { normalizeTools } from "./agent-loop";
import type { AgentContext } from "./types";

export interface StablePrefixSnapshot {
	systemPrompt: string[];
	tools: Tool[];
	fingerprint: string;
}

export interface BuildOptions {
	intentTracing: boolean;
	exampleDialect?: Dialect;
	pruneToolDescriptions?: boolean;
}

export class StablePrefix {
	#snapshot: StablePrefixSnapshot | null = null;
	#version = 0;

	get fingerprint(): string {
		return this.#snapshot?.fingerprint ?? "<unbuilt>";
	}
	get version(): number {
		return this.#version;
	}
	get built(): boolean {
		return this.#snapshot !== null;
	}

	build(context: AgentContext, options: BuildOptions): boolean {
		const snapshot = takeSnapshot(context, options);
		if (this.#snapshot && this.#snapshot.fingerprint === snapshot.fingerprint) {
			return false;
		}
		this.#snapshot = snapshot;
		this.#version++;
		return true;
	}

	invalidate(): void {
		this.#snapshot = null;
	}

	toContext(): { systemPrompt: string[]; tools: Tool[] } {
		const s = this.#snapshot;
		if (!s) throw new Error("StablePrefix.toContext() called before build()");
		return { systemPrompt: s.systemPrompt, tools: s.tools };
	}
}

export class AppendOnlyLog {
	#entries: Message[] = [];

	get length(): number {
		return this.#entries.length;
	}

	append(message: Message): void {
		this.#entries.push(message);
	}

	extend(messages: Message[]): void {
		for (const m of messages) this.#entries.push(m);
	}

	replaceTail(replacement: Message): void {
		const idx = this.#entries.length - 1;
		if (idx >= 0) this.#entries[idx] = replacement;
	}

	toMessages(): Message[] {
		return this.#entries.slice();
	}

	entries(): readonly Message[] {
		return this.#entries;
	}

	truncate(count: number): void {
		if (count < 0) count = 0;
		if (count >= this.#entries.length) return;
		this.#entries.length = count;
	}

	clear(): void {
		this.#entries = [];
	}
}

export class AppendOnlyContextManager {
	readonly prefix = new StablePrefix();
	readonly log = new AppendOnlyLog();
	#lastSyncCount = 0;
	#messageDigests: number[] = [];

	build(context: AgentContext, options: BuildOptions): Context {
		this.prefix.build(context, options);
		const { systemPrompt, tools } = this.prefix.toContext();
		return { systemPrompt, messages: this.log.toMessages(), tools };
	}

	syncMessages(normalizedMessages: Message[]): void {
		if (normalizedMessages.length < this.#lastSyncCount) {
			this.log.clear();
			this.#lastSyncCount = 0;
			this.#messageDigests = [];
		}

		if (this.#lastSyncCount > 0) {
			const stableCount = Math.min(this.#longestStablePrefix(normalizedMessages), this.log.length);
			if (stableCount < this.#lastSyncCount) {
				this.log.truncate(stableCount);
				this.#lastSyncCount = stableCount;
				this.#messageDigests.length = stableCount;
			}
		}

		for (let i = this.#lastSyncCount; i < normalizedMessages.length; i++) {
			const msg = normalizedMessages[i];
			this.log.append(msg);
			this.#messageDigests.push(this.#messageDigest(msg));
		}
		this.#lastSyncCount = normalizedMessages.length;
	}

	invalidateForModelChange(): void {
		this.prefix.invalidate();
		this.log.clear();
		this.#lastSyncCount = 0;
		this.#messageDigests = [];
	}

	resetSyncCursor(): void {
		this.log.clear();
		this.#lastSyncCount = 0;
		this.#messageDigests = [];
	}

	appendMessage(message: Message): void {
		this.log.append(message);
	}

	replaceTailMessage(message: Message): void {
		this.log.replaceTail(message);
	}

	invalidate(): void {
		this.prefix.invalidate();
	}

	reset(context: AgentContext, options: BuildOptions): void {
		this.prefix.invalidate();
		this.log.clear();
		this.#lastSyncCount = 0;
		this.#messageDigests = [];
		this.prefix.build(context, options);
	}

	#longestStablePrefix(normalizedMessages: readonly unknown[]): number {
		const bound = Math.min(this.#lastSyncCount, normalizedMessages.length);
		for (let i = 0; i < bound; i++) {
			if (this.#messageDigest(normalizedMessages[i]) !== this.#messageDigests[i]) {
				return i;
			}
		}
		return bound;
	}

	#messageDigest(msg: unknown): number {
		if (!msg || typeof msg !== "object") return 0;
		const m = msg as Record<string, unknown>;
		const payload = JSON.stringify({
			r: m.role ?? null,
			c: m.content ?? null,
			pp: m.providerPayload ?? null,
			tc: m.toolCalls ?? m.tool_calls ?? null,
			tcid: m.toolCallId ?? m.tool_call_id ?? null,
			tn: m.toolName ?? m.name ?? null,
			err: m.isError ?? null,
			id: m.id ?? null,
		});
		let hash = 0;
		for (let j = 0; j < payload.length; j++) {
			hash = ((hash << 5) - hash + payload.charCodeAt(j)) | 0;
		}
		return hash >>> 0;
	}
}

function takeSnapshot(context: AgentContext, options: BuildOptions): StablePrefixSnapshot {
	const systemPrompt = context.systemPrompt.slice();
	const tools =
		normalizeTools(context.tools, options.intentTracing, options.exampleDialect, options.pruneToolDescriptions) ?? [];
	return {
		systemPrompt,
		tools,
		fingerprint: computeFingerprint(systemPrompt, tools, options),
	};
}

function computeFingerprint(systemPrompt: string[], tools: Tool[], options: BuildOptions): string {
	const payload = JSON.stringify({
		s: systemPrompt,
		t: tools.map(t => ({
			n: t.name,
			d: t.description,
			p: t.parameters,
			s: t.strict,
			cf: t.customFormat,
			cw: t.customWireName,
		})),
		i: options.intentTracing,
		ex: options.exampleDialect,
		pd: options.pruneToolDescriptions,
	});
	let hash = 0;
	for (let i = 0; i < payload.length; i++) {
		hash = ((hash << 5) - hash + payload.charCodeAt(i)) | 0;
	}
	return (hash >>> 0).toString(36);
}
