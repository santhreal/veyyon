import type { SQLQueryBindings } from "bun:sqlite";
import { collapseWhitespace, DAY_MS, errorMessage, HOUR_MS, logger } from "@veyyon/utils";
import { degradeBatchSize, sleepBatchSize, tier2Days, tier3Days, tier3MaxChars } from "../../config";
import { generateId, stableMemoryId } from "../../util/ids";
import { unicodeWordTokens, WORD_TOKEN_DOT_HYPHEN_RE } from "../../util/regex";
import { escapeLike, sqlPlaceholders } from "../../util/sqlite";
import { aaakEncode } from "../aaak";
import { REGEX_EXTRACTION_MAX_INPUT_CHARS } from "../entities";
import { EpisodicGraph } from "../episodic-graph";
import { type ExtractedFactCategories, heuristicExtractFacts } from "../extraction";
import { clampVeracity } from "../veracity-consolidation";
import { scheduleEmbedding } from "./helpers";
import type { BeamMemoryState, BeamStats, JsonValue, MemoriaRetrieveResult, Metadata, SleepResult } from "./types";

export type Row = Record<string, unknown>;

export type FactCounts = {
	metric: number;
	date: number;
	version: number;
	entity: number;
	sequence: number;
	timeline: number;
	negation: number;
	decision: number;
};

export type ConsolidateOptions = {
	metadata?: Metadata | null;
	validUntil?: string | null;
	scope?: string;
	veracity?: string | null;
};

export const CONTAMINATED_VERACITY: Record<string, true> = {
	inferred: true,
	tool: true,
	imported: true,
	unknown: true,
	false: true,
};

export const EPISODIC_VERACITY_WEIGHT = {
	true: 1.0,
	stated: 1.0,
	unknown: 0.8,
	inferred: 0.7,
	imported: 0.6,
	tool: 0.5,
	false: 0.0,
} as const;

export type EpisodicVeracity = keyof typeof EPISODIC_VERACITY_WEIGHT;

export const SLEEP_BATCH_SIZE = sleepBatchSize();
export const TIER2_DAYS = tier2Days();
export const TIER3_DAYS = tier3Days();
export const DEGRADE_BATCH_SIZE = degradeBatchSize();
export const TIER3_MAX_CHARS = tier3MaxChars();
export const DEFAULT_MAX_EPISODE_CHARS = 100_000;
export const SLEEP_SUMMARY_SEPARATOR = " | ";
export const SLEEP_TRUNCATION_MARKER = "\n[... sleep_consolidation episode truncated by maxEpisodeChars ...]";
export const PATTERN_FACT_EXTRACTION_MAX_INPUT_CHARS = REGEX_EXTRACTION_MAX_INPUT_CHARS;

export type SleepSummary = {
	summary: string;
	originalChars: number;
	truncated: boolean;
	maxChars: number;
};
export type SleepChunk = {
	items: Row[];
	originalChars: number;
};

export function normalizedMaxEpisodeChars(beam: BeamMemoryState): number {
	const configured = Math.trunc(beam.config?.maxEpisodeChars ?? DEFAULT_MAX_EPISODE_CHARS);
	return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_MAX_EPISODE_CHARS;
}

export function markTruncated(content: string, maxChars: number): string {
	if (maxChars <= 0) return "";
	if (maxChars <= SLEEP_TRUNCATION_MARKER.length) return content.slice(0, maxChars);
	const bodyChars = maxChars - SLEEP_TRUNCATION_MARKER.length;
	return `${content.slice(0, bodyChars).trimEnd()}${SLEEP_TRUNCATION_MARKER}`;
}

export function splitSleepItems(beam: BeamMemoryState, source: string, items: readonly Row[]): SleepChunk[] {
	const maxChars = normalizedMaxEpisodeChars(beam);
	const prefixChars = `[${source}] `.length;
	const joinedLimit = Math.max(0, maxChars - prefixChars);
	const chunks: SleepChunk[] = [];
	let current: Row[] = [];
	let currentChars = 0;

	for (const item of items) {
		const contentChars = (rowValue(item, "content") ?? "").length;
		const separatorChars = current.length === 0 ? 0 : SLEEP_SUMMARY_SEPARATOR.length;
		if (current.length > 0 && currentChars + separatorChars + contentChars > joinedLimit) {
			chunks.push({ items: current, originalChars: currentChars });
			current = [];
			currentChars = 0;
		}
		current.push(item);
		currentChars += (current.length === 1 ? 0 : SLEEP_SUMMARY_SEPARATOR.length) + contentChars;
	}
	if (current.length > 0) chunks.push({ items: current, originalChars: currentChars });
	return chunks;
}

export function buildSleepSummary(beam: BeamMemoryState, source: string, chunk: SleepChunk): SleepSummary {
	const maxChars = normalizedMaxEpisodeChars(beam);
	const prefix = `[${source}] `;
	const joined = chunk.items.map(item => rowValue(item, "content") ?? "").join(SLEEP_SUMMARY_SEPARATOR);
	const uncapped = `${prefix}${aaakEncode(joined)}`;
	const truncated = uncapped.length > maxChars;
	return {
		summary: truncated ? markTruncated(uncapped, maxChars) : uncapped,
		originalChars: chunk.originalChars,
		truncated,
		maxChars,
	};
}

export function isoNow(): string {
	return new Date().toISOString();
}

export function cutoffIso(amount: number, unitMs: number): string {
	return new Date(Date.now() - amount * unitMs).toISOString();
}

export function json(metadata: Metadata | null | undefined): string {
	return JSON.stringify(metadata ?? {});
}

export function rowValue(row: Row, key: string): string | null {
	const value = row[key];
	return value == null ? null : String(value);
}

export function isEpisodicVeracity(value: string): value is EpisodicVeracity {
	return Object.hasOwn(EPISODIC_VERACITY_WEIGHT, value);
}

export function clampEpisodicVeracity(raw: unknown): EpisodicVeracity {
	if (raw === null || raw === undefined) return "unknown";
	const norm = String(raw).trim().toLowerCase();
	if (norm === "") return "unknown";
	if (isEpisodicVeracity(norm)) return norm;
	const clamped = clampVeracity(raw, "consolidateToEpisodic.veracity");
	return isEpisodicVeracity(clamped) ? clamped : "unknown";
}

export function aggregateEpisodicVeracity(sourceVeracities: readonly string[]): EpisodicVeracity {
	let winner: EpisodicVeracity | null = null;
	let maxCount = 0;
	const counts = new Map<EpisodicVeracity, number>();
	for (const raw of sourceVeracities) {
		const value = clampEpisodicVeracity(raw);
		if (value === "unknown") continue;
		const count = (counts.get(value) ?? 0) + 1;
		counts.set(value, count);
		if (
			count > maxCount ||
			(count === maxCount && (winner === null || EPISODIC_VERACITY_WEIGHT[value] < EPISODIC_VERACITY_WEIGHT[winner]))
		) {
			winner = value;
			maxCount = count;
		}
	}
	if (winner !== null) return winner;
	for (const raw of sourceVeracities) {
		if (clampEpisodicVeracity(raw) === "unknown") return "unknown";
	}
	return "unknown";
}

export function compactWhitespace(text: string): string {
	return collapseWhitespace(text);
}

export function contextSnippet(content: string, index: number, width = 50): string {
	const start = Math.max(0, index - width);
	const end = Math.min(content.length, index + width);
	return compactWhitespace(content.slice(start, end));
}

export function sourceSession(beam: BeamMemoryState): string {
	return beam.sessionId || "default";
}

export function asRows(value: unknown): Row[] {
	return Array.isArray(value) ? (value as Row[]) : [];
}

export function makeQuestionTokens(query: string): string[] {
	const stop = new Set([
		"a",
		"an",
		"and",
		"are",
		"as",
		"at",
		"did",
		"do",
		"does",
		"for",
		"from",
		"how",
		"i",
		"in",
		"is",
		"it",
		"me",
		"my",
		"of",
		"on",
		"or",
		"the",
		"to",
		"was",
		"were",
		"what",
		"when",
		"where",
		"which",
		"who",
		"with",
	]);
	return unicodeWordTokens(query.toLowerCase(), WORD_TOKEN_DOT_HYPHEN_RE)
		.filter(token => token.length > 1 && !stop.has(token))
		.slice(0, 8);
}

export function emitEvent(
	beam: BeamMemoryState,
	type: string,
	memoryId: string,
	content: string,
	source: string,
	importance: number,
	metadata: Metadata,
): void {
	const event = {
		type,
		sessionId: beam.sessionId,
		timestamp: isoNow(),
		memoryId,
		content,
		source,
		importance,
		metadata,
	};
	beam.eventEmitter?.(event);
	void beam.pluginManager?.emit?.(event);
}

export function insertFactRows(
	beam: BeamMemoryState,
	messageIdx: number,
	factType: string,
	key: string,
	value: string,
	context: string,
	importance: number,
	sourceMemoryId: string | null,
): void {
	const timestamp = isoNow();
	beam.db.run(
		`INSERT INTO memoria_facts
		 (session_id, message_idx, fact_type, key, value, context_snippet, importance, timestamp, source_memory_id)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[sourceSession(beam), messageIdx, factType, key, value, context, importance, timestamp, sourceMemoryId],
	);

	const factId = stableMemoryId(`${sourceSession(beam)}\0${factType}\0${key}\0${value}`, sourceMemoryId ?? "");
	beam.db.run(
		`INSERT OR IGNORE INTO facts
		 (fact_id, session_id, subject, predicate, object, timestamp, source_msg_id, confidence)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		[factId, sourceSession(beam), key, factType, value, timestamp, sourceMemoryId, importance],
	);
}

export function insertTimeline(
	beam: BeamMemoryState,
	messageIdx: number,
	date: string | null,
	description: string,
	sourceMemoryId: string | null,
): void {
	beam.db.run(
		`INSERT INTO memoria_timelines (session_id, date, message_idx, description, source, source_memory_id)
		 VALUES (?, ?, ?, ?, ?, ?)`,
		[sourceSession(beam), date, messageIdx, description, "extraction", sourceMemoryId],
	);
}

export function insertKg(
	beam: BeamMemoryState,
	messageIdx: number,
	subject: string,
	predicate: string,
	object: string,
	sourceMemoryId: string | null,
): void {
	beam.db.run(
		`INSERT INTO memoria_kg (session_id, subject, predicate, object, message_idx, confidence, source_memory_id)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		[sourceSession(beam), subject, predicate, object, messageIdx, 0.65, sourceMemoryId],
	);
	beam.db.run(
		`INSERT INTO triples (subject, predicate, object, valid_from, source, confidence)
		 VALUES (?, ?, ?, ?, ?, ?)`,
		[subject, predicate, object, isoNow(), sourceMemoryId ?? "extraction", 0.65],
	);
	void beam.triples?.add?.(subject, predicate, object, {
		source: sourceMemoryId ?? "extraction",
		confidence: 0.65,
	});
}

export function insertPreference(
	beam: BeamMemoryState,
	messageIdx: number,
	preference: string,
	topic: string | null,
	sourceMemoryId: string | null,
): void {
	beam.db.run(
		`INSERT INTO memoria_preferences (session_id, message_idx, preference, topic, evolution, context_snippet, source_memory_id)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		[sourceSession(beam), messageIdx, preference, topic, null, preference, sourceMemoryId],
	);
}

export function insertInstruction(
	beam: BeamMemoryState,
	messageIdx: number,
	instruction: string,
	context: string,
	sourceMemoryId: string | null,
): void {
	beam.db.run(
		`INSERT INTO memoria_instructions (session_id, message_idx, instruction, active, topic, context_snippet, source_memory_id)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		[sourceSession(beam), messageIdx, instruction, 1, null, context, sourceMemoryId],
	);
}

export function timelineDate(description: string): string | null {
	return /\b\d{4}-\d{2}-\d{2}\b/.exec(description)?.[0] ?? null;
}

/** Populate episodic graph for freshly consolidated memory. */
export function ingestIntoEpisodicGraph(beam: BeamMemoryState, memoryId: string, summary: string): void {
	try {
		const graph =
			beam.episodicGraph instanceof EpisodicGraph
				? beam.episodicGraph
				: new EpisodicGraph({ db: beam.db, dbPath: beam.dbPath });
		graph.ingestMemory(summary, memoryId, {
			sessionId: sourceSession(beam),
			linkExisting: true,
			extractEntities: true,
		});
	} catch (error) {
		logger.warn("mnemopi: episodic-graph enrichment failed; consolidated memory stored without graph edges", {
			memoryId,
			error: errorMessage(error),
		});
	}
}

export function consolidateToEpisodic(
	beam: BeamMemoryState,
	summary: string,
	sourceWmIds: readonly string[],
	source = "consolidation",
	importance = 0.6,
	options: ConsolidateOptions = {},
): string {
	const memoryId = generateId(summary);
	const timestamp = isoNow();
	const scope = options.scope ?? "session";
	const veracity = clampEpisodicVeracity(options.veracity ?? "unknown");
	const metadata = options.metadata ?? {};
	beam.db.run(
		`INSERT INTO episodic_memory
		 (id, content, source, timestamp, session_id, importance, metadata_json, summary_of,
		  valid_until, scope, author_id, author_type, channel_id, memory_type, veracity, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			memoryId,
			summary,
			source,
			timestamp,
			sourceSession(beam),
			importance,
			json(metadata),
			sourceWmIds.join(","),
			options.validUntil ?? null,
			scope,
			beam.authorId,
			beam.authorType,
			beam.channelId,
			"unknown",
			veracity,
			timestamp,
		],
	);
	extractAndStoreFacts(beam, summary, 0, memoryId);
	ingestIntoEpisodicGraph(beam, memoryId, summary);
	scheduleEmbedding(beam, [{ memoryId, content: summary }]);
	emitEvent(beam, "MEMORY_CONSOLIDATED", memoryId, summary, source, importance, {
		summary_of: Array.from(sourceWmIds),
		...metadata,
	});
	return memoryId;
}
export type StoreFactStringOptions = {
	routeHeuristicCategories?: boolean;
};

export function storeFactStrings(
	beam: BeamMemoryState,
	facts: readonly string[],
	messageIdx = 0,
	sourceMemoryId: string | null = null,
	importance = 0.7,
	options: StoreFactStringOptions = {},
): number {
	const routeHeuristicCategories = options.routeHeuristicCategories ?? true;
	let stored = 0;
	for (const fact of facts) {
		insertFactRows(beam, messageIdx, "entity", "fact", fact, fact, importance, sourceMemoryId);
		stored++;
		if (!routeHeuristicCategories) continue;
		const pref = /^The user (prefers|dislikes) (.+)$/i.exec(fact);
		if (pref?.[2]) {
			insertPreference(beam, messageIdx, fact, pref[2], sourceMemoryId);
		}
		const instruction = /^Instruction: (.+)$/i.exec(fact);
		if (instruction?.[1]) {
			insertInstruction(beam, messageIdx, instruction[1], fact, sourceMemoryId);
		}
	}
	return stored;
}

/** Store category-preserving LLM extraction output in MEMORIA and KG tables. */
export function storeExtractedFactCategories(
	beam: BeamMemoryState,
	extracted: ExtractedFactCategories,
	messageIdx = 0,
	sourceMemoryId: string | null = null,
	importance = 0.7,
): number {
	let stored = storeFactStrings(beam, extracted.facts, messageIdx, sourceMemoryId, importance);
	stored += storeFactStrings(beam, extracted.instructions, messageIdx, sourceMemoryId, importance, {
		routeHeuristicCategories: false,
	});
	stored += storeFactStrings(beam, extracted.preferences, messageIdx, sourceMemoryId, importance, {
		routeHeuristicCategories: false,
	});
	stored += storeFactStrings(beam, extracted.timelines, messageIdx, sourceMemoryId, importance, {
		routeHeuristicCategories: false,
	});
	for (const instruction of extracted.instructions) {
		insertInstruction(beam, messageIdx, instruction, instruction, sourceMemoryId);
	}
	for (const preference of extracted.preferences) {
		insertPreference(beam, messageIdx, preference, null, sourceMemoryId);
	}
	for (const timeline of extracted.timelines) {
		insertTimeline(beam, messageIdx, timelineDate(timeline), timeline, sourceMemoryId);
	}
	for (const triple of extracted.kg) {
		insertKg(beam, messageIdx, triple.subject, triple.predicate, triple.object, sourceMemoryId);
	}
	return stored;
}
export function extractAndStoreFacts(
	beam: BeamMemoryState,
	content: string,
	messageIdx = 0,
	sourceMemoryId: string | null = null,
): FactCounts {
	const counts: FactCounts = {
		metric: 0,
		date: 0,
		version: 0,
		entity: 0,
		sequence: 0,
		timeline: 0,
		negation: 0,
		decision: 0,
	};
	const text = String(content ?? "");
	if (text.length > PATTERN_FACT_EXTRACTION_MAX_INPUT_CHARS) return counts;
	for (const match of text.matchAll(
		/(\d+(?:[.,]\d+)?)\s*(ms|sec|seconds?|minutes?|hours?|days?|weeks?|months?|%|KB|MB|GB|TB|rows?|columns?|roles?|features?|bugs?|commits?|cards?|users?|items?|tests?|APIs?|endpoints?|sprints?|tickets?)\b/gi,
	)) {
		const rawUnit = match[2] ?? "";
		let unit = rawUnit.toLowerCase();
		if (unit.endsWith("s") && !unit.endsWith("ms")) unit = unit.slice(0, -1);
		const prefixWords = text
			.slice(Math.max(0, (match.index ?? 0) - 50), match.index ?? 0)
			.replace(/`[^`]*`/g, " ")
			.split(/\s+/)
			.map(w => w.replace(/[.,:;!?()[\]"'`*_]/g, ""))
			.filter(w => w.length > 2 && !/^(the|and|for|was|of|to|an?|in|on|at|by|is|are|has|had|not|but|or)$/i.test(w))
			.slice(-3)
			.join("_")
			.toLowerCase();
		let key = prefixWords === "" ? unit : `${prefixWords}_${unit}`;
		if (unit === "%") key = prefixWords === "" ? "pct" : `${prefixWords}_pct`;
		insertFactRows(
			beam,
			messageIdx,
			"metric",
			key,
			`${match[1]}${rawUnit}`,
			contextSnippet(text, match.index ?? 0),
			0.65,
			sourceMemoryId,
		);
		counts.metric++;
		if (counts.metric >= 10) break;
	}

	for (const match of text.matchAll(/\b(\d{4}-\d{2}-\d{2})\b/g)) {
		const date = match[1] ?? "";
		const ctx = contextSnippet(text, match.index ?? 0, 100);
		insertFactRows(beam, messageIdx, "date", "iso_date", date, ctx, 0.5, sourceMemoryId);
		counts.date++;
		if (/\b(release|deadline|meeting|launch|ship|shipped|due|start|started|finish|finished)\b/i.test(ctx)) {
			insertTimeline(beam, messageIdx, date, ctx, sourceMemoryId);
			counts.timeline++;
		}
	}

	for (const match of text.matchAll(/\b(v?\d+\.\d+(?:\.\d+)?(?:[-+][A-Za-z0-9.]+)?)\b/g)) {
		const value = match[1] ?? "";
		if (/^\d{4}-\d{2}$/.test(value)) continue;
		insertFactRows(
			beam,
			messageIdx,
			"version",
			"version",
			value,
			contextSnippet(text, match.index ?? 0),
			0.6,
			sourceMemoryId,
		);
		counts.version++;
	}

	counts.entity += storeFactStrings(beam, heuristicExtractFacts(text), messageIdx, sourceMemoryId);

	for (const match of text.matchAll(
		/\b([A-Z][A-Za-z0-9_-]{2,})\s+(?:is|uses|runs|owns|depends on)\s+([^.!?;]{2,80})/g,
	)) {
		insertKg(beam, messageIdx, match[1] ?? "", "related_to", compactWhitespace(match[2] ?? ""), sourceMemoryId);
	}
	if (/\b(no longer|not|never|don't|do not|isn't|wasn't)\b/i.test(text)) counts.negation++;
	if (/\b(decided|decision|choose|chose|approved|rejected)\b/i.test(text)) counts.decision++;
	return counts;
}
export function classifyAbility(query: string): string {
	const q = query.toLowerCase();
	if (
		[
			"how many days",
			"how many weeks",
			"how many months",
			"how long",
			"what date",
			"what day",
			"when did",
			"when does",
			"deadline",
			"timeline",
			"how far apart",
		].some(w => q.includes(w))
	)
		return "TR";
	if (
		["list the order", "walk me through", "chronological", "in what order", "sequence of events"].some(w =>
			q.includes(w),
		)
	)
		return "EO";
	if (["have i", "did i", "am i", "has this", "contradict", "contradiction", "conflict"].some(w => q.includes(w)))
		return "CR";
	if (["across my", "across all", "in my project", "in my sessions", "across sessions"].some(w => q.includes(w)))
		return "MR";
	if (
		/^(what|when|where|which|who|how)\s/.test(q) ||
		["how many", "what is", "what was", "which version", "how much"].some(w => q.includes(w))
	)
		return "IE";
	return "";
}

// circular import: functions moved to helpers
export {
	memoriaRetrieve,
	getEpisodicStats,
	getMemoriaStats,
	degradeEpisodic,
	getContaminated,
	health,
	sleep,
	sleepAllSessions,
	getConsolidationLog,
} from "./consolidate-helpers";
