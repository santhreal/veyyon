/**
 * Deterministic, offline prompt-cache counterfactuals.
 *
 * WHY THIS FAMILY EXISTS. Prompt caching is the largest single lever on what a
 * session costs, and it is invisible: a request that forfeits its cached prefix
 * returns the same answer as one that reads it. The only difference is the bill
 * and the latency, and neither is in a transcript. So a change to caching cannot
 * be justified by reading the code and reasoning about it — the reasoning is
 * exactly what has been wrong here before, in both directions:
 *
 *   - A one-hour TTL "obviously" beats five minutes, because a miss costs the
 *     whole prompt. It does not obviously beat it: an hour's retention is bought
 *     by paying 2.0x on EVERY write instead of 1.25x, and whether that trade
 *     wins depends entirely on how the gaps between turns are distributed.
 *   - More breakpoints "obviously" cache more. They do not: Anthropic allows four
 *     markers per request, so a fourth marker spent on a prefix that a later
 *     marker already covers is a marker not spent on the trailing message.
 *
 * Both questions are arithmetic over a turn sequence, and neither needs the
 * network. This harness answers them by driving the REAL request builders (the
 * shipped `applyPromptCaching`, its four-marker trim, and its TTL normalization,
 * reached through each provider's `onPayload` seam) and then billing the result
 * against a modelled provider cache.
 *
 * WHAT IS REAL AND WHAT IS MODELLED, stated because the distinction is the whole
 * validity of the exercise:
 *
 *   REAL      the wire body, every `cache_control` marker on it, where the
 *             production code chose to put them, the four-marker limit, the ttl
 *             ordering rules, and the message content of a growing agentic turn.
 *   MODELLED  the provider's cache itself: byte-exact prefix matching, entry
 *             lifetime, and the published price multipliers. A provider cannot
 *             be run offline, so it is modelled — and every rule modelled here
 *             is one the shipped code and its suites already assert against
 *             recorded traffic (see
 *             `packages/ai/test/anthropic-cache-breakpoints-move-forward.test.ts`).
 *   ESTIMATED token counts, through the product's own `estimateTokensFromText`.
 *             A counterfactual compares two arms over IDENTICAL content, so an
 *             estimator that is consistently wrong cancels; what must not be
 *             wrong is which bytes each arm caches, and that is exact.
 *
 * Determinism rules: no clock is read (a scenario states the gap between turns),
 * no network, no key, and no wall-clock sleep. `Date.now` is never consulted;
 * simulated time is an argument.
 */
import { streamAnthropic } from "@veyyon/ai/providers/anthropic";
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

/**
 * Published Anthropic multipliers over the base input price, as of the
 * `extended-cache-ttl-2025-04-11` beta this repo sends. These are prices, not
 * measurements: they are stated here so a scenario reads as arithmetic and a
 * price change is one edit.
 */
export const PRICE = Object.freeze({
	/** A prompt token the provider had to read normally. */
	input: 1,
	/** A token served from a cache entry. */
	read: 0.1,
	/** A token written into a five-minute entry. */
	write5m: 1.25,
	/** A token written into a one-hour entry. */
	write1h: 2.0,
});

/** Nominal entry lifetimes, in milliseconds of simulated time. */
export const TTL_MS = Object.freeze({ short: 5 * 60_000, long: 60 * 60_000 });

/**
 * The floor below which no supported provider stores an entry at all. Mirrors
 * `MIN_CACHEABLE_TOKENS` in `packages/ai/src/cache/verdict.ts`; a scenario whose
 * prompt sits under it measures nothing, so the harness refuses one.
 */
export const MIN_CACHEABLE_TOKENS = 2048;

const MODEL_SPEC: ModelSpec<"anthropic-messages"> = {
	id: "claude-sonnet-4-5",
	name: "Claude Sonnet 4.5",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: true,
	input: ["text", "image"],
	// Zeroed: this family prices tokens through `PRICE`, and a model-table price
	// here would silently become a second, disagreeing source for the same
	// number.
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
};

export const CACHE_SIM_MODEL: Model<"anthropic-messages"> = buildModel(MODEL_SPEC);

type CacheControl = { type: "ephemeral"; ttl?: "1h"; scope?: "global" };
type WireBlock = { type?: string; cache_control?: CacheControl } & Record<string, unknown>;
type WireMessage = { role?: string; content?: string | WireBlock[] };
export type WirePayload = { system?: WireBlock[]; messages?: WireMessage[]; tools?: WireBlock[] };

/**
 * Capture the body the shipped provider would have sent.
 *
 * The signal is aborted before the call so nothing is dispatched; `onPayload`
 * fires while the body is being assembled, which is after `applyPromptCaching`,
 * its four-marker trim and the ttl normalization have all run. This is the same
 * seam `packages/ai/test` uses, for the same reason: it is the only place the
 * finished request exists without a socket.
 */
export function capturePayload(
	context: Context,
	options: { isOAuth: boolean; cacheRetention?: CacheRetention },
): Promise<WirePayload> {
	const controller = new AbortController();
	controller.abort();
	const { promise, resolve } = Promise.withResolvers<WirePayload>();
	streamAnthropic(CACHE_SIM_MODEL, context, {
		apiKey: "sk-ant-simulation",
		isOAuth: options.isOAuth,
		cacheRetention: options.cacheRetention,
		signal: controller.signal,
		onPayload: payload => resolve(payload as WirePayload),
	});
	return promise;
}

/**
 * One cacheable prefix: everything up to and including a marked block.
 *
 * `joined` is every block of the prefix, serialized and joined by a separator
 * that cannot occur in JSON, so a SHORTER prefix is a literal string prefix of a
 * longer request. That is the whole reason the representation is a join rather
 * than an array's JSON: a provider does not ask whether the new request repeats
 * an old marker, it asks whether an entry it holds is a prefix of what just
 * arrived — which is exactly how an entry written at turn N keeps being read at
 * turns N+1, N+2 and beyond as content is appended after it.
 */
export interface Prefix {
	/** Every block of the prefix, serialized and separator-joined. */
	readonly joined: string;
	/** Estimated tokens the prefix covers. */
	readonly tokens: number;
	/** The retention the marker on its final block asked for. */
	readonly retention: "short" | "long";
	/** Whether the marker asked to share this entry across sessions. */
	readonly global: boolean;
}

/** Separator between serialized blocks; cannot appear inside JSON text. */
const BLOCK_SEPARATOR = "\u0000";

/**
 * A block's content with the caching directive removed.
 *
 * `cache_control` is stripped before any prefix is compared because it is a
 * directive rather than content. The markers legitimately move on every turn as
 * the conversation grows, and the steady state of recorded traffic — a turn
 * reading its predecessor's full prompt while both carry markers in different
 * places — is only possible if the provider excludes them from the match.
 */
function withoutMarker(block: WireBlock): Record<string, unknown> {
	const { cache_control: _directive, ...rest } = block;
	return rest;
}

/**
 * Every block of a payload, serialized, in the order the API bills them: tools,
 * then system blocks, then messages. One walk, so a prefix and the whole prompt
 * can never disagree about what the request contains.
 */
export function blocksOf(payload: WirePayload): Array<{ text: string; marker?: CacheControl }> {
	const blocks: Array<{ text: string; marker?: CacheControl }> = [];
	for (const tool of payload.tools ?? []) {
		blocks.push({ text: JSON.stringify(withoutMarker(tool)), marker: tool.cache_control });
	}
	for (const block of payload.system ?? []) {
		blocks.push({ text: JSON.stringify(withoutMarker(block)), marker: block.cache_control });
	}
	for (const message of payload.messages ?? []) {
		if (!Array.isArray(message.content)) {
			blocks.push({ text: JSON.stringify(message) });
			continue;
		}
		// The role travels with the first block of the message: two messages whose
		// content matches but whose roles do not are different bytes on the wire.
		message.content.forEach((block, index) => {
			const text = JSON.stringify(
				index === 0 ? { role: message.role, ...withoutMarker(block) } : withoutMarker(block),
			);
			blocks.push({ text, marker: block.cache_control });
		});
	}
	return blocks;
}

/**
 * The prefixes a payload offers the cache, shallowest first.
 *
 * Each marker closes a prefix consisting of every block up to and including the
 * one it sits on, which is what makes a marker deeper in the request strictly
 * more valuable than the same marker earlier.
 */
export function prefixesOf(payload: WirePayload): Prefix[] {
	const prefixes: Prefix[] = [];
	const seen: string[] = [];
	for (const block of blocksOf(payload)) {
		seen.push(block.text);
		if (!block.marker) continue;
		const joined = seen.join(BLOCK_SEPARATOR);
		prefixes.push({
			joined,
			tokens: estimateTokensFromText(joined),
			retention: block.marker.ttl === "1h" ? "long" : "short",
			global: block.marker.scope === "global",
		});
	}
	return prefixes;
}

/** The whole request as one separator-joined string: what a prefix matches against. */
export function joinedOf(payload: WirePayload): string {
	return blocksOf(payload)
		.map(block => block.text)
		.join(BLOCK_SEPARATOR);
}

/** Every byte of a payload, markers removed: the prompt the provider reads. */
export function promptTokensOf(payload: WirePayload): number {
	return estimateTokensFromText(joinedOf(payload));
}

/** What one request cost, in tokens and in base-input-price equivalents. */
export interface TurnLedger {
	readonly read: number;
	readonly write: number;
	readonly input: number;
	readonly promptTokens: number;
	readonly cost: number;
}

/** What a whole simulated session cost. */
export interface SessionLedger {
	readonly turns: readonly TurnLedger[];
	readonly read: number;
	readonly write: number;
	readonly input: number;
	readonly cost: number;
	/** Turns that read nothing although a previous turn had stored a prefix. */
	readonly misses: number;
}

interface Entry {
	/** The prefix content this entry holds. */
	joined: string;
	/**
	 * The session that wrote it, or undefined when the marker asked for
	 * `scope: "global"` and any session may read it.
	 */
	owner: string | undefined;
	tokens: number;
	retention: "short" | "long";
	expiresAt: number;
}

/**
 * A modelled provider prefix cache.
 *
 * The rule that matters, and the one it is easy to model wrongly: a request does
 * NOT look up the markers it happens to carry. It arrives, and the provider finds
 * the longest entry that is a prefix of it. That distinction is the difference
 * between a cache that works and a cache that appears never to hit — an entry
 * written at turn N ends in the middle of turn N+1's request, where turn N+1
 * places no marker at all, and it is read anyway. Everything else follows the
 * documented behavior: longest match wins, entries expire on the retention they
 * were written with, a read refreshes what it served, and `scope: "global"` drops
 * the session from the key, which is what that beta buys.
 */
export class PrefixCache {
	readonly #entries = new Map<string, Entry>();

	#key(session: string, prefix: Prefix): string {
		return `${prefix.global ? "" : session}${BLOCK_SEPARATOR}${prefix.joined}`;
	}

	/**
	 * Bill one request.
	 *
	 * The longest held prefix of this request is read; everything from there to the
	 * deepest marker is written; anything past the deepest marker is ordinary
	 * input. A prefix below the provider's floor is not stored, so it bills as
	 * input rather than as a write nobody could ever read.
	 */
	serve(session: string, payload: WirePayload, now: number): TurnLedger {
		const prefixes = prefixesOf(payload);
		const request = joinedOf(payload);
		const promptTokens = estimateTokensFromText(request);
		let read = 0;
		let served: Entry | undefined;
		for (const entry of this.#entries.values()) {
			if (entry.expiresAt <= now) continue;
			// An entry another session wrote is invisible unless its marker asked to
			// be shared. This is the whole content of the `scope: "global"` beta, and
			// leaving it out makes a session-scoped cache look account-wide — which
			// would credit the shipped anchor with a saving it does not collect.
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
		return {
			read,
			write,
			input,
			promptTokens,
			cost: read * PRICE.read + write * writePrice + input * PRICE.input,
		};
	}
}

/**
 * Mark the deepest system block that does NOT change between turns, instead of
 * the first one.
 *
 * This is the counterfactual for a production change, not a description of one.
 * The shipped placement anchors `system[0]` (or `[2]` under the Claude Code
 * layout) so that a changing project, assignment or Argot block cannot
 * invalidate the harness shared with subagents. That is sound as far as it goes,
 * and it is also as shallow as an anchor can be: when a later system block does
 * change, the deepest prefix that survives covers the harness alone, and every
 * block between it and the change is re-read on every turn.
 *
 * `index` is the block a caller asserts is stable. A simulation can know that; a
 * request cannot, which is exactly what makes this a question to price rather
 * than a patch to apply.
 */
export function deepAnchor(index: number): Arm {
	return {
		name: `deep-anchor@${index}`,
		remark: payload => {
			const stripped = stripMarkers(payload);
			const system = stripped.system ?? [];
			const marker: CacheControl = { type: "ephemeral" };
			// Same budget as production: the trailing system block, one stable
			// anchor, and the last two messages. Only the anchor's depth moves.
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

/**
 * How a turn sequence is marked and billed. An arm changes ONLY this; the
 * content every arm sends is identical, which is what makes a delta between two
 * arms attributable to caching and nothing else.
 */
export interface Arm {
	readonly name: string;
	/** Retention the request asks for, or undefined to take the provider default. */
	readonly cacheRetention?: CacheRetention;
	/** Whether the request uses the Claude Code (OAuth) system layout. */
	readonly isOAuth?: boolean;
	/** Rewrite the markers on a captured payload. Content must not change. */
	readonly remark?: (payload: WirePayload) => WirePayload;
}

/** The production arm: exactly what the shipped code sends today. */
export const PRODUCTION: Arm = { name: "production" };

/**
 * The two retention arms. Both are production placement; only the lifetime the
 * request asks for moves, which is the switch this family exists to price.
 */
export const SHORT_RETENTION: Arm = { name: "5m", cacheRetention: "short" };
export const LONG_RETENTION: Arm = { name: "1h", cacheRetention: "long" };

/**
 * Text of a stated size, in the estimator's own unit.
 *
 * A prompt's SHAPE decides what a cache change is worth: a history-dominant
 * prompt (a long agentic run, where tool results dwarf the system prompt) loses
 * almost everything to a rewritten early message, while a system-dominant one
 * barely notices. A scenario states which shape it means rather than inheriting
 * whatever the fixture happened to be.
 */
export function padding(tokens: number): string {
	// The estimator is bytes+3 >> 2, so four ASCII bytes per token.
	return "pad ".repeat(Math.max(0, tokens));
}

/**
 * The placement this repo was asked to compare against: mark the first two
 * system blocks and the last two non-system messages, five minutes only.
 *
 * Reimplemented here from `applyCaching` in opencode's
 * `packages/opencode/src/provider/transform.ts` rather than imported, because
 * the point is to price the RULE over our content — running their harness would
 * change the content too and the comparison would mean nothing.
 */
export const SIMPLE_PLACEMENT: Arm = {
	name: "simple-placement",
	remark: payload => {
		const stripped = stripMarkers(payload);
		const marker: CacheControl = { type: "ephemeral" };
		for (const block of (stripped.system ?? []).slice(0, 2)) block.cache_control = marker;
		for (const message of (stripped.messages ?? []).slice(-2)) {
			if (!Array.isArray(message.content)) continue;
			const last = message.content.at(-1);
			// A thinking block cannot carry a marker; the provider rejects the
			// request outright. Walking back to a block that can is what the
			// shipped placement does, so the comparison keeps it.
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

/** A deep copy of a payload with every caching directive removed. */
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

/** The content a payload carries, markers excluded: what two arms must share. */
export function contentOf(payload: WirePayload): string {
	return JSON.stringify(stripMarkers(payload));
}

/**
 * One step of a simulated conversation: the request to send, and how much
 * simulated time passed since the previous one.
 */
export interface Step {
	readonly context: Context;
	readonly gapMs: number;
}

/** Run one arm over one sequence of steps and bill every request. */
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

/**
 * The payloads one arm sends, for a scenario that needs to inspect the wire
 * rather than the bill.
 */
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

/**
 * A zeroed usage for the scripted assistant turns. The cost fields have exactly
 * one owner in this repo, so it is imported rather than written out: this family
 * bills tokens itself and never reads these numbers.
 */
const usage = emptyUsage();

/**
 * A system prompt shaped like the one this product sends: a large stable harness
 * shared by every session, then the project context, then a small block that
 * changes as the session runs. The sizes matter — a prefix under
 * `MIN_CACHEABLE_TOKENS` is not stored at all — so each block is padded to a
 * realistic order of magnitude rather than being a label.
 */
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

/**
 * The message list an agentic loop sends: one user message, then an (assistant
 * tool call, tool result) pair per completed step. Two messages appended per
 * turn is the growth pattern recorded traffic shows for the overwhelming
 * majority of healthy adjacent pairs.
 *
 * `bodyFor` exists so a scenario can rewrite the content of an EARLIER step,
 * which is the defect class this family was built to price: the head is
 * unchanged, the prompt still grows, and the prefix is forfeited anyway.
 */
export function conversationAfter(steps: number, bodyFor: (index: number) => string = () => "payload"): Message[] {
	const messages: Message[] = [{ role: "user", content: "Audit the cache placement", timestamp: 0 }];
	for (let index = 1; index <= steps; index++) {
		const body = bodyFor(index);
		messages.push(assistantStep(index), toolResultStep(index, body));
	}
	return messages;
}

/**
 * A growing conversation as a step sequence: turn N sends N completed steps,
 * `gapMs` after turn N-1.
 */
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

/** What one arm cost across a whole fleet of sessions sharing one cache. */
export interface FleetLedger {
	/** Per-session bills, keyed by session id. */
	readonly sessions: Readonly<Record<string, SessionLedger>>;
	readonly read: number;
	readonly write: number;
	readonly input: number;
	readonly cost: number;
}

/**
 * Run one arm over several sessions that share a single provider cache,
 * interleaved by simulated time.
 *
 * This is the only shape in which the shipped anchor's justification can be
 * measured at all: marking the first system block protects the harness a parent
 * shares with its subagents, and a single-session scenario has no second reader
 * for that prefix to be worth anything to. Whether the second reader can ACTUALLY
 * read it is a property of the marker, not of the bytes — an entry is keyed by
 * session unless the marker says `scope: "global"` — so the fleet runner is also
 * what shows an unset field turning the whole argument off.
 */
export async function runFleet(arm: Arm, sessions: Readonly<Record<string, readonly Step[]>>): Promise<FleetLedger> {
	const cache = new PrefixCache();
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
	// Ties break on session id so the interleaving is a property of the fixture
	// rather than of object key order.
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

/**
 * The same arm, with every system marker asking to be shared across sessions.
 *
 * `scope: "global"` is the Claude Code prompt-caching-scope beta. This repo
 * already sends the beta header on both Anthropic layouts
 * (`packages/ai/src/providers/anthropic.ts:152,160`) and the field is first-class
 * on the wire type (`anthropic-wire.ts:23`), but nothing sets it, which is why
 * this is a counterfactual arm rather than a description of production.
 */
export function sharedGlobally(arm: Arm): Arm {
	return {
		...arm,
		name: `${arm.name}+global`,
		remark: payload => {
			const marked = arm.remark ? arm.remark(payload) : payload;
			for (const block of marked.system ?? []) {
				if (block.cache_control) block.cache_control = { ...block.cache_control, scope: "global" };
			}
			return marked;
		},
	};
}
