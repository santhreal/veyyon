import { buildTransformedCodexRequestBody } from "@veyyon/ai/providers/openai-codex-responses";
import type {
	AssistantMessage,
	CacheRetention,
	Context,
	Message,
	Model,
	ModelSpec,
	ToolResultMessage,
} from "@veyyon/ai/types";
import { buildModel } from "@veyyon/catalog/build";
import { emptyUsage } from "@veyyon/catalog/models";
import { estimateTokensFromText } from "@veyyon/utils";
import type { CacheControl, Entry, Prefix, SessionLedger, TurnLedger, WireBlock, WirePayload } from "./harness-helpers";
import {
	BLOCK_SEPARATOR,
	CACHE_SIM_MODEL,
	capturePayload,
	joinedOf,
	MIN_CACHEABLE_TOKENS,
	PRICE,
	prefixesOf,
	TTL_MS,
} from "./harness-helpers";

export type { SessionLedger, WirePayload };
export { PRICE, prefixesOf, TTL_MS };

export class PrefixCache {
	readonly #entries = new Map<string, Entry>();
	readonly #globalWritePremium: number;

	constructor(options?: { globalWritePremium?: number }) {
		this.#globalWritePremium = options?.globalWritePremium ?? 1;
	}

	#key(session: string, prefix: Prefix): string {
		return `${prefix.global ? "" : session}${BLOCK_SEPARATOR}${prefix.joined}`;
	}

	serve(session: string, payload: WirePayload, now: number): TurnLedger {
		const prefixes = prefixesOf(payload);
		const request = joinedOf(payload);
		const promptTokens = estimateTokensFromText(request);
		let read = 0;
		let served: Entry | undefined;
		for (const entry of this.#entries.values()) {
			if (entry.expiresAt <= now) continue;
			if (entry.owner !== undefined && entry.owner !== session) continue;
			if (!request.startsWith(entry.joined)) continue;
			if (entry.tokens <= read) continue;
			read = entry.tokens;
			served = entry;
		}
		if (served) served.expiresAt = now + TTL_MS[served.retention];
		const deepest = prefixes.at(-1);
		const covered = deepest?.tokens ?? 0;
		const write = Math.max(0, covered - read);
		for (const prefix of prefixes) {
			if (prefix.tokens < MIN_CACHEABLE_TOKENS) continue;
			this.#entries.set(this.#key(session, prefix), {
				joined: prefix.joined,
				owner: prefix.global ? undefined : session,
				tokens: prefix.tokens,
				retention: prefix.retention,
				expiresAt: now + TTL_MS[prefix.retention],
			});
		}
		const writePrice = deepest?.retention === "long" ? PRICE.write1h : PRICE.write5m;
		const input = Math.max(0, promptTokens - read - write);
		const deepestGlobal = prefixes.reduce((max, prefix) => (prefix.global ? Math.max(max, prefix.tokens) : max), 0);
		const shared = Math.max(0, Math.min(covered, deepestGlobal) - read);
		const cost =
			read * PRICE.read +
			shared * writePrice * this.#globalWritePremium +
			(write - shared) * writePrice +
			input * PRICE.input;
		return { read, write, input, promptTokens, cost };
	}
}

export function deepAnchor(index: number): Arm {
	return {
		name: `deep-anchor@${index}`,
		remark: payload => {
			const stripped = stripMarkers(payload);
			const system = stripped.system ?? [];
			const marker: CacheControl = { type: "ephemeral" };
			if (system.length > 0) system[system.length - 1].cache_control = marker;
			if (index >= 0 && index < system.length - 1) system[index].cache_control = marker;
			for (const message of (stripped.messages ?? []).slice(-2)) {
				if (!Array.isArray(message.content)) continue;
				const target = markableBlock(message.content);
				if (target) target.cache_control = marker;
			}
			return stripped;
		},
	};
}

export interface Arm {
	readonly name: string;
	readonly cacheRetention?: CacheRetention;
	readonly isOAuth?: boolean;
	readonly remark?: (payload: WirePayload) => WirePayload;
}

export const PRODUCTION: Arm = { name: "production" };

export const SHORT_RETENTION: Arm = { name: "5m", cacheRetention: "short" };
export const LONG_RETENTION: Arm = { name: "1h", cacheRetention: "long" };

export function padding(tokens: number): string {
	return "pad ".repeat(Math.max(0, tokens));
}

export const SIMPLE_PLACEMENT: Arm = {
	name: "simple-placement",
	remark: payload => {
		const stripped = stripMarkers(payload);
		const marker: CacheControl = { type: "ephemeral" };
		for (const block of (stripped.system ?? []).slice(0, 2)) block.cache_control = marker;
		for (const message of (stripped.messages ?? []).slice(-2)) {
			if (!Array.isArray(message.content)) continue;
			const last = message.content.at(-1);
			const target = markableBlock(message.content) ?? last;
			if (target) target.cache_control = marker;
		}
		return stripped;
	},
};

function markableBlock(blocks: WireBlock[]): WireBlock | undefined {
	for (let index = blocks.length - 1; index >= 0; index--) {
		const block = blocks[index];
		if (block.type === "thinking" || block.type === "redacted_thinking") continue;
		return block;
	}
	return undefined;
}

export function stripMarkers(payload: WirePayload): WirePayload {
	const clone = JSON.parse(JSON.stringify(payload)) as WirePayload;
	for (const tool of clone.tools ?? []) delete tool.cache_control;
	for (const block of clone.system ?? []) delete block.cache_control;
	for (const message of clone.messages ?? []) {
		if (!Array.isArray(message.content)) continue;
		for (const block of message.content) delete block.cache_control;
	}
	return clone;
}

export function contentOf(payload: WirePayload): string {
	return JSON.stringify(stripMarkers(payload));
}

export interface Step {
	readonly context: Context;
	readonly gapMs: number;
}

export async function runArm(arm: Arm, steps: readonly Step[], session = "sim-session"): Promise<SessionLedger> {
	const cache = new PrefixCache();
	const turns: TurnLedger[] = [];
	let now = 0;
	let stored = false;
	let misses = 0;
	for (const step of steps) {
		now += step.gapMs;
		const captured = await capturePayload(step.context, {
			isOAuth: arm.isOAuth ?? false,
			cacheRetention: arm.cacheRetention,
		});
		const payload = arm.remark ? arm.remark(captured) : captured;
		const ledger = cache.serve(session, payload, now);
		if (stored && ledger.read === 0) misses++;
		if (ledger.write > 0) stored = true;
		turns.push(ledger);
	}
	return {
		turns,
		read: turns.reduce((sum, turn) => sum + turn.read, 0),
		write: turns.reduce((sum, turn) => sum + turn.write, 0),
		input: turns.reduce((sum, turn) => sum + turn.input, 0),
		cost: turns.reduce((sum, turn) => sum + turn.cost, 0),
		misses,
	};
}

export async function armPayloads(arm: Arm, steps: readonly Step[]): Promise<WirePayload[]> {
	const payloads: WirePayload[] = [];
	for (const step of steps) {
		const captured = await capturePayload(step.context, {
			isOAuth: arm.isOAuth ?? false,
			cacheRetention: arm.cacheRetention,
		});
		payloads.push(arm.remark ? arm.remark(captured) : captured);
	}
	return payloads;
}

const usage = emptyUsage();

export function systemPrompt(options?: { volatileSuffix?: string }): string[] {
	return [
		`STABLE HARNESS\n${"tool and policy text that every session shares. ".repeat(400)}`,
		`PROJECT\n${"repository conventions that change when the project changes. ".repeat(120)}`,
		`SESSION\n${options?.volatileSuffix ?? "handle table"}`,
	];
}

function assistantStep(index: number): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: `deliberation ${index}`, thinkingSignature: `sig_${index}` },
			{ type: "toolCall", id: `toolu_${index}`, name: "read", arguments: { path: `file-${index}.ts` } },
		],
		api: "anthropic-messages",
		provider: "anthropic",
		model: CACHE_SIM_MODEL.id,
		usage,
		stopReason: "toolUse",
		timestamp: index * 2,
	};
}

function toolResultStep(index: number, body: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: `toolu_${index}`,
		toolName: "read",
		content: [{ type: "text", text: `contents of file-${index}.ts\n${body}` }],
		isError: false,
		timestamp: index * 2 + 1,
	};
}

export function conversationAfter(steps: number, bodyFor: (index: number) => string = () => "payload"): Message[] {
	const messages: Message[] = [{ role: "user", content: "Audit the cache placement", timestamp: 0 }];
	for (let index = 1; index <= steps; index++) {
		const body = bodyFor(index);
		messages.push(assistantStep(index), toolResultStep(index, body));
	}
	return messages;
}

export function growingSession(options: {
	turns: number;
	gapMs: number;
	system?: string[];
	bodyFor?: (index: number) => string;
}): Step[] {
	const system = options.system ?? systemPrompt();
	const steps: Step[] = [];
	for (let turn = 1; turn <= options.turns; turn++) {
		steps.push({
			context: { systemPrompt: system, messages: conversationAfter(turn, options.bodyFor) },
			gapMs: turn === 1 ? 0 : options.gapMs,
		});
	}
	return steps;
}

export interface FleetLedger {
	readonly sessions: Readonly<Record<string, SessionLedger>>;
	readonly read: number;
	readonly write: number;
	readonly input: number;
	readonly cost: number;
}

export async function runFleet(
	arm: Arm,
	sessions: Readonly<Record<string, readonly Step[]>>,
	options?: { globalWritePremium?: number },
): Promise<FleetLedger> {
	const cache = new PrefixCache({ globalWritePremium: options?.globalWritePremium });
	const events: Array<{ at: number; session: string; payload: WirePayload }> = [];
	for (const [session, steps] of Object.entries(sessions)) {
		let at = 0;
		for (const step of steps) {
			at += step.gapMs;
			const captured = await capturePayload(step.context, {
				isOAuth: arm.isOAuth ?? false,
				cacheRetention: arm.cacheRetention,
			});
			events.push({ at, session, payload: arm.remark ? arm.remark(captured) : captured });
		}
	}
	events.sort((left, right) => left.at - right.at || left.session.localeCompare(right.session));

	const turns = new Map<string, TurnLedger[]>();
	const stored = new Set<string>();
	const misses = new Map<string, number>();
	for (const event of events) {
		const ledger = cache.serve(event.session, event.payload, event.at);
		const billed = turns.get(event.session) ?? [];
		billed.push(ledger);
		turns.set(event.session, billed);
		if (stored.has(event.session) && ledger.read === 0)
			misses.set(event.session, (misses.get(event.session) ?? 0) + 1);
		if (ledger.write > 0) stored.add(event.session);
	}

	const ledgers: Record<string, SessionLedger> = {};
	for (const [session, billed] of turns) {
		ledgers[session] = {
			turns: billed,
			read: billed.reduce((sum, turn) => sum + turn.read, 0),
			write: billed.reduce((sum, turn) => sum + turn.write, 0),
			input: billed.reduce((sum, turn) => sum + turn.input, 0),
			cost: billed.reduce((sum, turn) => sum + turn.cost, 0),
			misses: misses.get(session) ?? 0,
		};
	}
	const all = Object.values(ledgers);
	return {
		sessions: ledgers,
		read: all.reduce((sum, one) => sum + one.read, 0),
		write: all.reduce((sum, one) => sum + one.write, 0),
		input: all.reduce((sum, one) => sum + one.input, 0),
		cost: all.reduce((sum, one) => sum + one.cost, 0),
	};
}

export function sharedGlobally(arm: Arm, options?: { everySystemMarker?: boolean }): Arm {
	const everyMarker = options?.everySystemMarker ?? false;
	return {
		...arm,
		name: `${arm.name}+global${everyMarker ? "-everywhere" : ""}`,
		remark: payload => {
			const marked = arm.remark ? arm.remark(payload) : payload;
			for (const block of marked.system ?? []) {
				if (!block.cache_control) continue;
				block.cache_control = { ...block.cache_control, scope: "global" };
				if (!everyMarker) break;
			}
			return marked;
		},
	};
}

const CODEX_MODEL_SPEC: ModelSpec<"openai-codex-responses"> = {
	id: "gpt-5.1-codex",
	name: "GPT-5.1 Codex",
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: "https://chatgpt.com/backend-api/codex",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 400_000,
	maxTokens: 128_000,
};

export const IMPLICIT_SIM_MODEL: Model<"openai-codex-responses"> = buildModel(CODEX_MODEL_SPEC);

export const IMPLICIT = Object.freeze({ minTokens: 1024, blockTokens: 128 });

export async function captureImplicitBody(context: Context, options?: { sessionId?: string }): Promise<CodexBody> {
	return (await buildTransformedCodexRequestBody(IMPLICIT_SIM_MODEL, context, {
		sessionId: options?.sessionId ?? "sim-session",
	})) as CodexBody;
}

export type CodexBody = { instructions?: string; input?: unknown[]; prompt_cache_key?: string } & Record<
	string,
	unknown
>;

export function implicitBlocksOf(body: CodexBody): string[] {
	const blocks: string[] = [];
	if (body.instructions !== undefined) blocks.push(JSON.stringify(body.instructions));
	for (const item of body.input ?? []) blocks.push(JSON.stringify(item));
	return blocks;
}

export class ImplicitCache {
	readonly #entries = new Map<string, { blocks: string[]; expiresAt: number }>();

	serve(key: string | undefined, body: CodexBody, now: number): TurnLedger {
		const blocks = implicitBlocksOf(body);
		const promptTokens = estimateTokensFromText(blocks.join(BLOCK_SEPARATOR));
		const entry = key === undefined ? undefined : this.#entries.get(key);
		let shared = 0;
		if (entry && entry.expiresAt > now) {
			while (shared < blocks.length && shared < entry.blocks.length && blocks[shared] === entry.blocks[shared]) {
				shared++;
			}
		}
		const sharedTokens = estimateTokensFromText(blocks.slice(0, shared).join(BLOCK_SEPARATOR));
		const credited =
			sharedTokens < IMPLICIT.minTokens ? 0 : Math.floor(sharedTokens / IMPLICIT.blockTokens) * IMPLICIT.blockTokens;
		if (key !== undefined && promptTokens >= IMPLICIT.minTokens) {
			this.#entries.set(key, { blocks, expiresAt: now + TTL_MS.short });
		}
		const input = Math.max(0, promptTokens - credited);
		return {
			read: credited,
			write: 0,
			input,
			promptTokens,
			cost: credited * PRICE.read + input * PRICE.input,
		};
	}
}

export async function runImplicit(
	steps: readonly Step[],
	options?: { sessionIdFor?: (index: number) => string | undefined },
): Promise<SessionLedger> {
	const cache = new ImplicitCache();
	const turns: TurnLedger[] = [];
	let now = 0;
	let stored = false;
	let misses = 0;
	for (const [index, step] of steps.entries()) {
		now += step.gapMs;
		const key = options?.sessionIdFor ? options.sessionIdFor(index + 1) : "sim-session";
		const body = await captureImplicitBody(step.context, key === undefined ? {} : { sessionId: key });
		const ledger = cache.serve(key, body, now);
		if (stored && ledger.read === 0) misses++;
		if (ledger.promptTokens >= IMPLICIT.minTokens) stored = true;
		turns.push(ledger);
	}
	return {
		turns,
		read: turns.reduce((sum, turn) => sum + turn.read, 0),
		write: 0,
		input: turns.reduce((sum, turn) => sum + turn.input, 0),
		cost: turns.reduce((sum, turn) => sum + turn.cost, 0),
		misses,
	};
}
