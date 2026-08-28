import * as fs from "node:fs";
import * as path from "node:path";
import { firstRetainedAssistantIndex } from "@veyyon/ai/providers/google-shared";
import { artifactFooter, formatMiddleElisionMarker } from "@veyyon/coding-agent/session/streaming-output";

import {
	type CostBreakdown,
	costShares,
	priceTokens,
	type RateCard,
	REFERENCE_RATE_CARD,
	type TokenMix,
} from "./cost-model";

export type PrefixCategory =
	| "signature"
	| "toolResult"
	| "system"
	| "thinking"
	| "arguments"
	| "assistantText"
	| "userText";

export const PREFIX_CATEGORIES: readonly PrefixCategory[] = [
	"signature",
	"toolResult",
	"system",
	"thinking",
	"arguments",
	"assistantText",
	"userText",
] as const;

export type PrefixMass = Record<PrefixCategory, number>;

export function emptyPrefixMass(): PrefixMass {
	return {
		signature: 0,
		toolResult: 0,
		system: 0,
		thinking: 0,
		arguments: 0,
		assistantText: 0,
		userText: 0,
	};
}

export type PrefixDelta = Partial<Record<PrefixCategory, number>>;

export type PrefixStep = { kind: "grow"; delta: PrefixDelta } | { kind: "billedTurn" };

export function accumulatePrefixMass(steps: Iterable<PrefixStep>, into: PrefixMass = emptyPrefixMass()): PrefixMass {
	const running = emptyPrefixMass();
	for (const step of steps) {
		if (step.kind === "billedTurn") {
			for (const category of PREFIX_CATEGORIES) into[category] += running[category];
			continue;
		}
		for (const category of PREFIX_CATEGORIES) running[category] += step.delta[category] ?? 0;
	}
	return into;
}

export function totalPrefixMass(mass: PrefixMass): number {
	return PREFIX_CATEGORIES.reduce((sum, category) => sum + mass[category], 0);
}

export function prefixShares(mass: PrefixMass): Record<PrefixCategory, number> {
	const total = totalPrefixMass(mass);
	const shares = emptyPrefixMass();
	if (total <= 0) return shares;
	for (const category of PREFIX_CATEGORIES) shares[category] = mass[category] / total;
	return shares;
}

export function predictedBillSaving(mass: PrefixMass, elided: readonly PrefixCategory[], cost: CostBreakdown): number {
	const shares = prefixShares(mass);
	const prefixFraction = elided.reduce((sum, category) => sum + shares[category], 0);
	const lines = costShares(cost);
	const promptShare = lines.input + lines.cacheRead + lines.cacheWrite;
	return prefixFraction * promptShare;
}

export interface TranscriptRecord {
	type?: string;
	systemPrompt?: string;
	tools?: unknown;
	message?: {
		role?: string;
		usage?: unknown;
		toolCallId?: string;
		id?: string;
		toolName?: string;
		content?: Array<{
			type?: string;
			text?: string;
			thinking?: string;
			thoughtSignature?: string;
			arguments?: unknown;
			name?: string;
			toolCallId?: string;
			id?: string;
		}>;
	};
}

export function sessionPrefixSteps(records: Iterable<TranscriptRecord>): PrefixStep[] {
	const steps: PrefixStep[] = [];
	for (const record of records) {
		if (record.type === "session_init") {
			const system = (record.systemPrompt ?? "").length + JSON.stringify(record.tools ?? []).length;
			if (system > 0) steps.push({ kind: "grow", delta: { system } });
			continue;
		}
		if (record.type !== "message") continue;
		const message = record.message;
		if (!message) continue;
		const content = message.content ?? [];
		if (message.role === "assistant") {
			if (message.usage) steps.push({ kind: "billedTurn" });
			const delta: PrefixDelta = {};
			for (const block of content) {
				if (block.type === "toolCall") {
					delta.signature = (delta.signature ?? 0) + (block.thoughtSignature ?? "").length;
					delta.arguments = (delta.arguments ?? 0) + JSON.stringify(block.arguments ?? {}).length;
				} else if (block.type === "thinking") {
					delta.thinking = (delta.thinking ?? 0) + (block.thinking ?? "").length;
				} else if (block.type === "text") {
					delta.assistantText = (delta.assistantText ?? 0) + (block.text ?? "").length;
				}
			}
			steps.push({ kind: "grow", delta });
			continue;
		}
		if (message.role === "toolResult") {
			const toolResult = content.reduce((sum, block) => sum + (block.text ?? "").length, 0);
			steps.push({ kind: "grow", delta: { toolResult } });
			continue;
		}
		if (message.role === "user") {
			const userText = content.reduce(
				(sum, block) => sum + (block.type === "text" ? (block.text ?? "").length : 0),
				0,
			);
			steps.push({ kind: "grow", delta: { userText } });
		}
	}
	return steps;
}

export function prefixObservations(records: TranscriptRecord[]): PrefixObservation[] {
	const usages: number[] = [];
	for (const record of records) {
		if (record.type !== "message") continue;
		const usage = record.message?.usage as Record<string, number> | undefined;
		if (record.message?.role !== "assistant" || !usage) continue;
		usages.push((usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0));
	}
	const observations: PrefixObservation[] = [];
	let visible = 0;
	let turn = 0;
	for (const step of sessionPrefixSteps(records)) {
		if (step.kind === "billedTurn") {
			const promptTokens = usages[turn++];
			if (promptTokens) observations.push({ visibleChars: visible, promptTokens });
			continue;
		}
		for (const category of PREFIX_CATEGORIES) visible += step.delta[category] ?? 0;
	}
	return observations;
}

export interface CacheEfficiency {
	readonly uncachedTokens: number;
	readonly cachedTokens: number;
	readonly cacheWriteTokens: number;
	readonly newContentTokens: number;
	readonly rebilledTokens: number;
}

export function freshTokens(efficiency: CacheEfficiency): number {
	return efficiency.uncachedTokens + efficiency.cacheWriteTokens;
}

export function cacheHitRate(efficiency: CacheEfficiency): number {
	const prompt = efficiency.cachedTokens + freshTokens(efficiency);
	return prompt > 0 ? efficiency.cachedTokens / prompt : 0;
}

export function freshRate(efficiency: CacheEfficiency, rates: RateCard): number {
	const fresh = freshTokens(efficiency);
	if (fresh <= 0) return rates.input;
	return (efficiency.uncachedTokens * rates.input + efficiency.cacheWriteTokens * rates.cacheWrite) / fresh;
}

export function cacheEfficiency(records: TranscriptRecord[], charsPerToken: number): CacheEfficiency {
	let uncachedTokens = 0;
	let cachedTokens = 0;
	let cacheWriteTokens = 0;
	let newContentTokens = 0;
	let rebilledTokens = 0;
	const usages: { input: number; read: number; write: number }[] = [];
	for (const record of records) {
		if (record.type !== "message" || record.message?.role !== "assistant") continue;
		const usage = record.message.usage as Record<string, number> | undefined;
		if (!usage) continue;
		usages.push({ input: usage.input ?? 0, read: usage.cacheRead ?? 0, write: usage.cacheWrite ?? 0 });
	}
	let visible = 0;
	let lastVisible = 0;
	let turn = 0;
	for (const step of sessionPrefixSteps(records)) {
		if (step.kind === "billedTurn") {
			const usage = usages[turn++];
			if (!usage) continue;
			const added = Math.max(0, (visible - lastVisible) / charsPerToken);
			lastVisible = visible;
			const fresh = usage.input + usage.write;
			uncachedTokens += usage.input;
			cachedTokens += usage.read;
			cacheWriteTokens += usage.write;
			newContentTokens += Math.min(added, fresh);
			rebilledTokens += Math.max(0, fresh - added);
			continue;
		}
		for (const category of PREFIX_CATEGORIES) visible += step.delta[category] ?? 0;
	}
	return { uncachedTokens, cachedTokens, cacheWriteTokens, newContentTokens, rebilledTokens };
}

export function rebilledCostShare(efficiency: CacheEfficiency, cost: CostBreakdown, rates: RateCard): number {
	if (cost.total <= 0) return 0;
	const overpaid = (efficiency.rebilledTokens * (freshRate(efficiency, rates) - rates.cacheRead)) / 1_000_000;
	return overpaid / cost.total;
}

export interface PrefixObservation {
	readonly visibleChars: number;
	readonly promptTokens: number;
}

export function calibratePrefix(
	observations: readonly PrefixObservation[],
): { charsPerToken: number; unseenChars: number } | null {
	const n = observations.length;
	if (n < 2) return null;
	let sx = 0;
	let sy = 0;
	let sxx = 0;
	let sxy = 0;
	for (const { visibleChars, promptTokens } of observations) {
		sx += visibleChars;
		sy += promptTokens;
		sxx += visibleChars * visibleChars;
		sxy += visibleChars * promptTokens;
	}
	const denominator = n * sxx - sx * sx;
	if (denominator === 0) return null;
	const slope = (n * sxy - sx * sy) / denominator;
	if (slope <= 0) return null;
	const intercept = (sy - slope * sx) / n;
	return { charsPerToken: 1 / slope, unseenChars: intercept / slope };
}

export const SPILL_EXEMPT_TOOLS: readonly string[] = ["read"];

function toolNamesById(records: Iterable<TranscriptRecord>): Map<string, string> {
	const names = new Map<string, string>();
	for (const record of records) {
		if (record.type !== "message" || record.message?.role !== "assistant") continue;
		for (const block of record.message.content ?? []) {
			if (block.type !== "toolCall") continue;
			const id = block.toolCallId ?? block.id;
			if (typeof id === "string" && typeof block.name === "string") names.set(id, block.name);
		}
	}
	return names;
}

export const SPILL_SUBSTITUTION_CHARS = artifactFooter("12").length + formatMiddleElisionMarker(120, 4000).length + 2;

export function simulateToolResultCap(
	records: TranscriptRecord[],
	cap: number,
	exempt: readonly string[] = SPILL_EXEMPT_TOOLS,
): { removed: number; total: number; spilled: number; results: number } {
	const names = toolNamesById(records);
	const exemptSet = new Set(exempt);
	let removed = 0;
	let total = 0;
	let running = 0;
	let spilled = 0;
	let resultCount = 0;
	const results: { chars: number; cappable: boolean }[] = [];
	for (const record of records) {
		if (record.type === "session_init") {
			running += (record.systemPrompt ?? "").length + JSON.stringify(record.tools ?? []).length;
			continue;
		}
		if (record.type !== "message" || !record.message) continue;
		const message = record.message;
		const content = message.content ?? [];
		if (message.role === "assistant") {
			if (message.usage) {
				total += running + results.reduce((sum, r) => sum + r.chars, 0);
				removed += results.reduce((sum, r) => sum + (r.cappable ? spillSaving(r.chars, cap) : 0), 0);
			}
			for (const block of content) {
				if (block.type === "toolCall") {
					running += JSON.stringify(block.arguments ?? {}).length;
					running += (block.thoughtSignature ?? "").length;
				} else if (block.type === "thinking") {
					running += (block.thinking ?? "").length;
				} else if (block.type === "text") {
					running += (block.text ?? "").length;
				}
			}
			continue;
		}
		if (message.role === "toolResult") {
			const chars = content.reduce((sum, block) => sum + (block.text ?? "").length, 0);
			if (chars > 0) {
				const id = message.toolCallId ?? message.id;
				const name = (typeof id === "string" ? names.get(id) : undefined) ?? message.toolName;
				const cappable = !exemptSet.has(name ?? "");
				results.push({ chars, cappable });
				resultCount += 1;
				if (cappable && spillSaving(chars, cap) > 0) spilled += 1;
			}
			continue;
		}
		if (message.role === "user") {
			running += content.reduce((sum, b) => sum + (b.type === "text" ? (b.text ?? "").length : 0), 0);
		}
	}
	return { removed, total, spilled, results: resultCount };
}

function spillSaving(chars: number, cap: number): number {
	if (chars <= cap) return 0;
	return Math.max(0, chars - cap - SPILL_SUBSTITUTION_CHARS);
}

export const CAP_SWEEP = [50_000, 20_000, 10_000, 5000, 2000, 1000] as const;

export interface CapSweepPoint {
	removed: number;
	spilled: number;
	results: number;
}

export const SIGNATURE_CAP_SWEEP = [8000, 4000, 2000, 1000] as const;

export function simulateSignatureCap(records: TranscriptRecord[], cap: number): SignatureSimulation {
	return simulateSignatureLever(records, { kind: "sizeCap", maxLength: cap });
}

export interface SignatureSimulation {
	readonly removed: number;
	readonly total: number;
	readonly touched: number;
	readonly signatures: number;
}

export const SKIP_SIGNATURE_CHARS = 33;

export type SignatureLever =
	| { kind: "stock" }
	| { kind: "sizeCap"; maxLength: number }
	| { kind: "retainLast"; assistantMessages: number };

export type ThinkingLever = { kind: "thinkingRetainLast"; assistantMessages: number };

export type PrefixLever = SignatureLever | ThinkingLever;

interface SignatureSite {
	readonly assistantIndex: number;
	readonly length: number;
	readonly sentinel: number;
}

function sentLength(lever: PrefixLever, site: SignatureSite, assistantMessagesSoFar: number): number {
	if (lever.kind === "stock") return site.length;
	if (lever.kind === "sizeCap") {
		return site.length > lever.maxLength ? site.sentinel : site.length;
	}
	const retainFrom = assistantMessagesSoFar - lever.assistantMessages;
	return site.assistantIndex < retainFrom ? site.sentinel : site.length;
}

export interface PrefixStability {
	readonly comparisons: number;
	readonly stableComparisons: number;
	readonly rewrittenSignatureChars: number;
	readonly invalidatedCharTurns: number;
}

export function prefixStability(records: TranscriptRecord[], lever: PrefixLever): PrefixStability {
	const items: { site: SignatureSite | null; chars: number }[] = [];
	let assistantMessages = 0;
	let previous: number[] | null = null;
	let comparisons = 0;
	let stableComparisons = 0;
	let rewrittenSignatureChars = 0;
	let invalidatedCharTurns = 0;

	const render = (): number[] =>
		items.map(item => (item.site === null ? item.chars : sentLength(lever, item.site, assistantMessages)));

	for (const record of records) {
		if (record.type === "session_init") {
			const system = (record.systemPrompt ?? "").length + JSON.stringify(record.tools ?? []).length;
			if (system > 0) items.push({ site: null, chars: system });
			continue;
		}
		if (record.type !== "message" || !record.message) continue;
		const message = record.message;
		const content = message.content ?? [];
		if (message.role === "assistant") {
			if (message.usage) {
				const rendered = render();
				if (previous !== null) {
					comparisons += 1;
					let firstChange = -1;
					for (let index = 0; index < previous.length; index++) {
						if (previous[index] !== rendered[index]) {
							firstChange = index;
							break;
						}
					}
					if (firstChange === -1) {
						stableComparisons += 1;
					} else {
						for (let index = firstChange; index < previous.length; index++) {
							invalidatedCharTurns += previous[index] ?? 0;
							if (previous[index] !== rendered[index]) rewrittenSignatureChars += previous[index] ?? 0;
						}
					}
				}
				previous = rendered;
			}
			const leversThinking = lever.kind === "thinkingRetainLast";
			for (const block of content) {
				if (block.type === "toolCall") {
					const length = (block.thoughtSignature ?? "").length;
					if (length > 0) {
						items.push({
							site: leversThinking
								? null
								: { assistantIndex: assistantMessages, length, sentinel: SKIP_SIGNATURE_CHARS },
							chars: length,
						});
					}
					items.push({ site: null, chars: JSON.stringify(block.arguments ?? {}).length });
				} else if (block.type === "thinking") {
					const length = (block.thinking ?? "").length;
					items.push({
						site: leversThinking ? { assistantIndex: assistantMessages, length, sentinel: 0 } : null,
						chars: length,
					});
				} else if (block.type === "text") {
					items.push({ site: null, chars: (block.text ?? "").length });
				}
			}
			assistantMessages += 1;
			continue;
		}
		if (message.role === "toolResult") {
			items.push({ site: null, chars: content.reduce((sum, block) => sum + (block.text ?? "").length, 0) });
			continue;
		}
		if (message.role === "user") {
			items.push({
				site: null,
				chars: content.reduce((sum, block) => sum + (block.type === "text" ? (block.text ?? "").length : 0), 0),
			});
		}
	}
	return { comparisons, stableComparisons, rewrittenSignatureChars, invalidatedCharTurns };
}

export function simulateSignatureLever(records: TranscriptRecord[], lever: SignatureLever): SignatureSimulation {
	let removed = 0;
	let total = 0;
	let running = 0;
	let signatures = 0;
	let assistantMessages = 0;
	const sites: SignatureSite[] = [];
	const everElided = new Set<number>();
	for (const record of records) {
		if (record.type === "session_init") {
			running += (record.systemPrompt ?? "").length + JSON.stringify(record.tools ?? []).length;
			continue;
		}
		if (record.type !== "message" || !record.message) continue;
		const message = record.message;
		const content = message.content ?? [];
		if (message.role === "assistant") {
			if (message.usage) {
				total += running;
				for (let index = 0; index < sites.length; index++) {
					const site = sites[index];
					if (!site) continue;
					total += site.length;
					const sent = sentLength(lever, site, assistantMessages);
					removed += site.length - sent;
					if (sent < site.length) everElided.add(index);
				}
			}
			for (const block of content) {
				if (block.type === "toolCall") {
					const length = (block.thoughtSignature ?? "").length;
					if (length > 0) {
						sites.push({ assistantIndex: assistantMessages, length, sentinel: SKIP_SIGNATURE_CHARS });
						signatures += 1;
					}
					running += JSON.stringify(block.arguments ?? {}).length;
				} else if (block.type === "thinking") {
					running += (block.thinking ?? "").length;
				} else if (block.type === "text") {
					running += (block.text ?? "").length;
				}
			}
			assistantMessages += 1;
			continue;
		}
		if (message.role === "toolResult") {
			running += content.reduce((sum, block) => sum + (block.text ?? "").length, 0);
			continue;
		}
		if (message.role === "user") {
			running += content.reduce((sum, b) => sum + (b.type === "text" ? (b.text ?? "").length : 0), 0);
		}
	}
	return { removed, total, touched: everElided.size, signatures };
}

export function simulateThinkingRetention(
	records: TranscriptRecord[],
	retention: number,
): { removed: number; total: number; touched: number; blocks: number } {
	let removed = 0;
	let total = 0;
	let running = 0;
	const roles: { role: string }[] = [];
	const sites: { messageIndex: number; chars: number }[] = [];
	const everElided = new Set<number>();
	for (const record of records) {
		if (record.type === "session_init") {
			running += (record.systemPrompt ?? "").length + JSON.stringify(record.tools ?? []).length;
			continue;
		}
		if (record.type !== "message" || !record.message) continue;
		const message = record.message;
		const content = message.content ?? [];
		if (message.role === "assistant") {
			if (message.usage) {
				total += running;
				const boundary = firstRetainedAssistantIndex(roles as never, retention);
				for (let index = 0; index < sites.length; index++) {
					const site = sites[index];
					if (!site) continue;
					total += site.chars;
					if (site.messageIndex < boundary) {
						removed += site.chars;
						everElided.add(index);
					}
				}
			}
			const messageIndex = roles.length;
			for (const block of content) {
				if (block.type === "toolCall") {
					running += JSON.stringify(block.arguments ?? {}).length;
					running += (block.thoughtSignature ?? "").length;
				} else if (block.type === "thinking") {
					const chars = (block.thinking ?? "").length;
					if (chars > 0) sites.push({ messageIndex, chars });
				} else if (block.type === "text") {
					running += (block.text ?? "").length;
				}
			}
			roles.push({ role: "assistant" });
			continue;
		}
		if (message.role === "toolResult") {
			running += content.reduce((sum, block) => sum + (block.text ?? "").length, 0);
			roles.push({ role: "toolResult" });
			continue;
		}
		if (message.role === "user") {
			running += content.reduce((sum, b) => sum + (b.type === "text" ? (b.text ?? "").length : 0), 0);
			roles.push({ role: "user" });
		}
	}
	return { removed, total, touched: everElided.size, blocks: sites.length };
}

export function conversationMassPerSession(mass: PrefixMass, sessions: number): number {
	if (sessions <= 0) return 0;
	return (totalPrefixMass(mass) - mass.system) / sessions;
}

export const COLLAPSED_CONVERSATION_SHARE = 0.1;

export function conversationCollapsed(
	baselineMass: PrefixMass,
	baselineSessions: number,
	treatedMass: PrefixMass,
	treatedSessions: number,
): boolean {
	const reference = conversationMassPerSession(baselineMass, baselineSessions);
	if (reference <= 0) return false;
	return conversationMassPerSession(treatedMass, treatedSessions) < reference * COLLAPSED_CONVERSATION_SHARE;
}

export function measureRunPrefix(
	jobsRoot: string,
	armPrefix = "baseline__",
): {
	mass: PrefixMass;
	sessions: number;
	usage: TokenMix;
	caps: Map<number, CapSweepPoint>;
	observations: PrefixObservation[];
	perSession: TranscriptRecord[][];
} {
	let mass = emptyPrefixMass();
	let sessions = 0;
	const observations: PrefixObservation[] = [];
	const perSession: TranscriptRecord[][] = [];
	const capRemoved = new Map<number, CapSweepPoint>(
		CAP_SWEEP.map(cap => [cap, { removed: 0, spilled: 0, results: 0 }]),
	);
	const usage = { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };
	for (const jobName of fs.readdirSync(jobsRoot)) {
		if (!jobName.startsWith(armPrefix)) continue;
		const jobDir = path.join(jobsRoot, jobName);
		if (!fs.statSync(jobDir).isDirectory()) continue;
		for (const trialName of fs.readdirSync(jobDir)) {
			const sessionsDir = path.join(jobDir, trialName, "agent", "sessions");
			if (!fs.existsSync(sessionsDir)) continue;
			for (const file of fs.readdirSync(sessionsDir)) {
				if (!file.endsWith(".jsonl")) continue;
				sessions++;
				const records: TranscriptRecord[] = [];
				for (const line of fs.readFileSync(path.join(sessionsDir, file), "utf8").split("\n")) {
					if (line === "") continue;
					try {
						records.push(JSON.parse(line) as TranscriptRecord);
					} catch {}
				}
				mass = accumulatePrefixMass(sessionPrefixSteps(records), mass);
				const po = prefixObservations(records);
				for (let oi = 0; oi < po.length; oi++) observations.push(po[oi]!);
				perSession.push(records);
				for (const cap of CAP_SWEEP) {
					const point = capRemoved.get(cap);
					const sim = simulateToolResultCap(records, cap);
					if (point) {
						point.removed += sim.removed;
						point.spilled += sim.spilled;
						point.results += sim.results;
					}
				}
				for (const record of records) {
					const u = record.message?.usage as Record<string, number> | undefined;
					if (!u) continue;
					usage.inputTokens += u.input ?? 0;
					usage.cacheReadTokens += u.cacheRead ?? 0;
					usage.cacheWriteTokens += u.cacheWrite ?? 0;
					usage.outputTokens += u.output ?? 0;
				}
			}
		}
	}
	return { mass, sessions, usage, caps: capRemoved, observations, perSession };
}

if (import.meta.main) {
	const jobsRoot = process.argv[2];
	if (!jobsRoot) {
		console.error("usage: bun prefix-composition.ts <run>/jobs [arm-prefix]");
		console.error("  Decomposes what cache-read tokens are spent on, and what eliding each part would buy.");
		process.exit(2);
	}
	const armPrefix = process.argv[3] ?? "baseline__";
	const { mass, sessions, usage, caps, observations, perSession } = measureRunPrefix(jobsRoot, armPrefix);
	const total = totalPrefixMass(mass);
	const shares = prefixShares(mass);
	console.log(`arm "${armPrefix}"  sessions ${sessions}  prefix ${total.toLocaleString()} char-turns`);
	console.log("");
	for (const category of [...PREFIX_CATEGORIES].sort((a, b) => mass[b] - mass[a])) {
		const pct = (100 * shares[category]).toFixed(1).padStart(5);
		console.log(`  ${category.padEnd(14)} ${mass[category].toLocaleString().padStart(16)}  ${pct}%`);
	}
	const cost = priceTokens(usage);
	const lines = costShares(cost);
	console.log("");
	console.log(
		`priced bill $${cost.total.toFixed(2)} at reference rates  ` +
			`(prompt lines ${(100 * (lines.input + lines.cacheRead + lines.cacheWrite)).toFixed(1)}%, ` +
			`output ${(100 * lines.output).toFixed(1)}%)`,
	);
	console.log("");
	console.log("upper bound on what eliding each part would save, as a share of the bill:");
	for (const set of [["signature"], ["thinking"], ["signature", "thinking"], ["system"], ["toolResult"]] as const) {
		const saving = predictedBillSaving(mass, set as unknown as PrefixCategory[], cost);
		console.log(`  ${set.join(" + ").padEnd(24)} ${(100 * saving).toFixed(1)}%`);
	}
	const calibration = calibratePrefix(observations);
	if (calibration) {
		const unseenShare = total > 0 ? (calibration.unseenChars * observations.length) / total : 0;
		console.log("");
		console.log(
			`calibration against billed tokens: ${calibration.charsPerToken.toFixed(2)} chars/token, ` +
				`${Math.round(calibration.unseenChars).toLocaleString()} chars of prefix not in the transcript ` +
				`(${(100 * unseenShare).toFixed(1)}% of the total above)`,
		);
	}
	if (calibration) {
		const efficiency = perSession.reduce(
			(acc, records) => {
				const e = cacheEfficiency(records, calibration.charsPerToken);
				return {
					uncachedTokens: acc.uncachedTokens + e.uncachedTokens,
					cachedTokens: acc.cachedTokens + e.cachedTokens,
					cacheWriteTokens: acc.cacheWriteTokens + e.cacheWriteTokens,
					newContentTokens: acc.newContentTokens + e.newContentTokens,
					rebilledTokens: acc.rebilledTokens + e.rebilledTokens,
				};
			},
			{ uncachedTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, newContentTokens: 0, rebilledTokens: 0 },
		);
		const share = rebilledCostShare(efficiency, cost, REFERENCE_RATE_CARD);
		const fresh = freshTokens(efficiency);
		console.log("");
		console.log("prompt cache, the lever that removes nothing from the context:");
		console.log(
			`  hit rate            ${(100 * cacheHitRate(efficiency)).toFixed(1)}%  (reads only; a write is not a hit)`,
		);
		console.log(
			`  billed fresh        ${Math.round(fresh).toLocaleString()} tokens ` +
				`(${Math.round(efficiency.uncachedTokens).toLocaleString()} input + ` +
				`${Math.round(efficiency.cacheWriteTokens).toLocaleString()} write), of which ` +
				`${Math.round(efficiency.rebilledTokens).toLocaleString()} was content already sent`,
		);
		console.log(`  paying the fresh rate on re-reads costs ${(100 * share).toFixed(1)}% of the bill, for nothing`);
		const rates = perSession
			.map(records => cacheHitRate(cacheEfficiency(records, calibration.charsPerToken)))
			.filter(rate => rate > 0)
			.sort((a, b) => a - b);
		if (rates.length > 1) {
			const at = (q: number) => rates[Math.min(rates.length - 1, Math.floor(q * rates.length))] ?? 0;
			console.log(
				`  across ${rates.length} sessions   min ${(100 * (rates[0] ?? 0)).toFixed(1)}%` +
					`  p25 ${(100 * at(0.25)).toFixed(1)}%  median ${(100 * at(0.5)).toFixed(1)}%` +
					`  p75 ${(100 * at(0.75)).toFixed(1)}%  max ${(100 * (rates[rates.length - 1] ?? 0)).toFixed(1)}%`,
			);
		}
	}
	console.log("");
	console.log("what an inline-output CAP would actually reach, which is not the toolResult total:");
	const promptShare = lines.input + lines.cacheRead + lines.cacheWrite;
	for (const cap of CAP_SWEEP) {
		const point = caps.get(cap) ?? { removed: 0, spilled: 0, results: 0 };
		const ofPrefix = total > 0 ? point.removed / total : 0;
		const spillRate = point.results > 0 ? point.spilled / point.results : 0;
		console.log(
			`  cap ${cap.toLocaleString().padStart(6)} chars  ${(100 * ofPrefix).toFixed(1).padStart(5)}% of prefix` +
				`  ->  ${(100 * ofPrefix * promptShare).toFixed(1).padStart(5)}% of bill` +
				`   (spills ${(100 * spillRate).toFixed(0).padStart(3)}% of tool results)`,
		);
	}
	console.log("");
	if (perSession.length > 1) {
		console.log("");
		console.log("how much each share moves between sessions (a short run is not one number):");
		const perSessionShares = perSession
			.map(records => prefixShares(accumulatePrefixMass(sessionPrefixSteps(records))))
			.filter(shares => PREFIX_CATEGORIES.some(category => shares[category] > 0));
		for (const category of PREFIX_CATEGORIES) {
			const values = perSessionShares.map(shares => shares[category]).sort((a, b) => a - b);
			if (values.length === 0 || (values[values.length - 1] ?? 0) === 0) continue;
			const at = (q: number) => values[Math.min(values.length - 1, Math.floor(q * values.length))] ?? 0;
			console.log(
				`  ${category.padEnd(14)} pooled ${(100 * shares[category]).toFixed(1).padStart(5)}%` +
					`   per-session min ${(100 * (values[0] ?? 0)).toFixed(1).padStart(5)}%` +
					`  median ${(100 * at(0.5)).toFixed(1).padStart(5)}%` +
					`  max ${(100 * (values[values.length - 1] ?? 0)).toFixed(1).padStart(5)}%`,
			);
		}
	}

	console.log("");
	console.log("what a SIGNATURE length cap would reach, and how much reasoning it gives up:");
	for (const cap of SIGNATURE_CAP_SWEEP) {
		const sim = perSession.reduce(
			(acc, records) => {
				const s = simulateSignatureCap(records, cap);
				return {
					removed: acc.removed + s.removed,
					touched: acc.touched + s.touched,
					signatures: acc.signatures + s.signatures,
				};
			},
			{ removed: 0, touched: 0, signatures: 0 },
		);
		const ofPrefix = total > 0 ? sim.removed / total : 0;
		const share = sim.signatures > 0 ? sim.touched / sim.signatures : 0;
		console.log(
			`  cap ${cap.toLocaleString().padStart(5)} chars  ${(100 * ofPrefix).toFixed(1).padStart(5)}% of prefix` +
				`  ->  ${(100 * ofPrefix * promptShare).toFixed(1).padStart(5)}% of bill` +
				`   (touches ${(100 * share).toFixed(0).padStart(3)}% of tool calls)`,
		);
	}

	console.log("");
	console.log("what each CONTEXT lever saves, net of the cache it invalidates:");
	const promptShareForLevers = lines.input + lines.cacheRead + lines.cacheWrite;
	const levers: { label: string; lever: PrefixLever; unit: string }[] = [
		{ label: "stock", lever: { kind: "stock" }, unit: "signatures" },
		{ label: "sig-max4000", lever: { kind: "sizeCap", maxLength: 4000 }, unit: "signatures" },
		{ label: "sig-last1", lever: { kind: "retainLast", assistantMessages: 1 }, unit: "signatures" },
		{ label: "sig-last5", lever: { kind: "retainLast", assistantMessages: 5 }, unit: "signatures" },
		{ label: "sig-last8", lever: { kind: "retainLast", assistantMessages: 8 }, unit: "signatures" },
		{ label: "think-last1", lever: { kind: "thinkingRetainLast", assistantMessages: 1 }, unit: "thinking" },
		{ label: "think-last8", lever: { kind: "thinkingRetainLast", assistantMessages: 8 }, unit: "thinking" },
	];
	for (const { label, lever, unit } of levers) {
		const totals = perSession.reduce(
			(acc, records) => {
				const s = prefixStability(records, lever);
				const sim =
					lever.kind === "thinkingRetainLast"
						? (({ removed, touched, blocks }) => ({ removed, touched, signatures: blocks }))(
								simulateThinkingRetention(records, lever.assistantMessages),
							)
						: simulateSignatureLever(records, lever);
				return {
					comparisons: acc.comparisons + s.comparisons,
					stableComparisons: acc.stableComparisons + s.stableComparisons,
					invalidatedCharTurns: acc.invalidatedCharTurns + s.invalidatedCharTurns,
					removed: acc.removed + sim.removed,
					touched: acc.touched + sim.touched,
					signatures: acc.signatures + sim.signatures,
				};
			},
			{ comparisons: 0, stableComparisons: 0, invalidatedCharTurns: 0, removed: 0, touched: 0, signatures: 0 },
		);
		const stable = totals.comparisons > 0 ? totals.stableComparisons / totals.comparisons : 1;
		const lostShare = total > 0 ? totals.invalidatedCharTurns / total : 0;
		const rateLoss =
			(REFERENCE_RATE_CARD.input - REFERENCE_RATE_CARD.cacheRead) / Math.max(REFERENCE_RATE_CARD.input, 1e-9);
		const gross = (total > 0 ? totals.removed / total : 0) * promptShareForLevers;
		const givenBack = lostShare * promptShareForLevers * rateLoss;
		const touchedShare = totals.signatures > 0 ? totals.touched / totals.signatures : 0;
		console.log(
			`  ${label.padEnd(12)} gross ${(100 * gross).toFixed(1).padStart(5)}%` +
				`  - cache ${(100 * givenBack).toFixed(1).padStart(4)}%` +
				`  = NET ${(100 * (gross - givenBack)).toFixed(1).padStart(5)}% of bill` +
				`   |  ${(100 * stable).toFixed(0).padStart(3)}% of turns keep the prefix intact` +
				`, touches ${(100 * touchedShare).toFixed(0).padStart(3)}% of ${unit}`,
		);
	}

	console.log("");
	console.log("Upper bounds. A real lever substitutes something smaller rather than nothing, and");
	console.log("none of this says the model still solves the task: only the reward gate answers that.");
}
