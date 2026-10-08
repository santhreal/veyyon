import { batched } from "@veyyon/utils/array";
import { clamp, clamp01 } from "@veyyon/utils/math";
import { type HybridWeights, normalizedRecallWeights, temporalHalflifeHours } from "../../config";
import { parseQueryTime, recencyDecay, temporalBoost, toUtcIso } from "../../util/datetime";

// Temporal scoring has one owner (util/datetime.ts). Re-export the two helpers
// the recall surface has always exposed so callers keep importing them here.
export { parseQueryTime, temporalBoost } from "../../util/datetime";

import { unicodeWordTokens } from "../../util/regex";
import { SQLITE_IN_CLAUSE_BATCH, sqlPlaceholders, tableExists as tableExistsIn } from "../../util/sqlite";
import { embedQuery } from "../embeddings";
import { mmrRerank } from "../mmr";
import { adjustWeights, classifyIntent } from "../query-intent";
import { CORE_QUERY_STOP_WORDS, getSynonyms, normalizeQuery, STOP_WORDS as QUERY_STOP_WORDS } from "../synonyms";
import { extractTemporal } from "../temporal-parser";
import { cosineScorer, decodeEmbeddingJson } from "../vector-math";
import { weightForVeracity } from "../veracity";
import type { BeamMemoryState, RecallEnhancedOptions, RecallOptions, RecallResult } from "./types";

type DbValue = string | number | null | Uint8Array;
type Row = Record<string, unknown>;
type TierLabel = "working" | "episodic";

type RecallOptionsInternal = RecallOptions & {
	source?: string | null;
	topic?: string | null;
	veracity?: string | null;
	memoryType?: string | null;
	temporalWeight?: number;
	temporalHalflife?: number;
	vecWeight?: number;
	ftsWeight?: number;
	importanceWeight?: number;
	queryEmbedding?: readonly number[] | null;
	useSynonyms?: boolean;
	useIntent?: boolean;
	useMmr?: boolean;
	mmrLambda?: number;
	ignoreSessionScope?: boolean;
	currentSensitive?: boolean;
	updateRecallCounts?: boolean;
};

type CandidateSignals = {
	fts: number;
	ftsMatched: boolean;
	dense: number;
	keyword: number;
	candidateSource: "fts" | "vec" | "fallback";
};

type MemoryCandidate = {
	row: Row;
	tierLabel: TierLabel;
	signals: CandidateSignals;
};

type FactRecallResult = RecallResult & {
	fact_id?: string;
	subject?: string;
	predicate?: string;
};

type RecallMmrItem = {
	readonly content?: string;
	readonly score?: number;
	readonly result: RecallResult;
	readonly [key: string]: unknown;
};

/**
 * Default per-result content preview cap enforced by {@link recall}. Content
 * longer than this is clipped and the last character replaced with `…` so
 * callers see the truncation; the full row remains reachable via
 * `Mnemopi.get()` (and, in the coding-agent, `memory://<id>`). Overridable per
 * call via {@link RecallOptions.contentPreviewChars}.
 */
export const RECALL_CONTENT_PREVIEW_CHARS = 500;

/**
 * Clip `content` to at most `limit` characters, replacing the tail with `…`
 * when truncated so agents can distinguish a preview from a full row. Returns
 * the original string (and `truncated: false`) when the limit is 0/negative or
 * the content already fits. The single `…` occupies one character of the cap,
 * so a 500-char cap yields at most 499 real characters plus the marker.
 */
export function clipRecallContent(
	content: string,
	limit: number = RECALL_CONTENT_PREVIEW_CHARS,
): { content: string; truncated: boolean; fullLength: number } {
	const fullLength = content.length;
	if (limit <= 0 || fullLength <= limit) {
		return { content, truncated: false, fullLength };
	}
	const head = content.slice(0, Math.max(0, limit - 1));
	return { content: `${head}…`, truncated: true, fullLength };
}

const DEFAULT_LIMIT = 500;
// Symmetric query↔content token-overlap filtering uses the minimal core
// function-word list owned by synonyms.ts (CORE_QUERY_STOP_WORDS). Keeping the
// tighter core here (not the full query STOP_WORDS) preserves recall: only the
// most common function words are dropped so topical tokens survive matching.
const STOP_WORDS = CORE_QUERY_STOP_WORDS;

const FACT_QUERY_FILLER_WORDS = new Set([
	...QUERY_STOP_WORDS,
	..."active current currently d know latest ll m please present re recent remind remember s t tell today ve".split(
		" ",
	),
]);

const FACT_CLITIC_FRAGMENTS = new Set(["d", "ll", "m", "re", "s", "t", "ve"]);
const FLAT_FACT_SEARCH_NOISE: Record<string, true> = { entity: true, fact: true };

function numberOrDefault(value: unknown, fallback = 0): number {
	const n = typeof value === "number" ? value : Number(value);
	return Number.isFinite(n) ? n : fallback;
}

function stringOrEmpty(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function nullableString(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

function round4(value: number): number {
	return Math.round(value * 10000) / 10000;
}

function tokenize(text: string): string[] {
	const tokens: string[] = [];
	for (const token of unicodeWordTokens(text.toLowerCase())) {
		if (STOP_WORDS.has(token)) continue;
		tokens.push(token);
	}
	return tokens;
}

function recallSynonyms(token: string, useSynonyms: boolean): string[] {
	if (!useSynonyms) return [token];
	const variants = getSynonyms(token);
	switch (token) {
		case "branding":
			return variants.concat(["positioning", "wording", "headline"]);
		case "preference":
		case "prefer":
		case "preferred":
			return variants.concat(["wants", "want", "prefers"]);
		default:
			return variants;
	}
}

/** Add to `into` the tokens of `token`'s synonyms, only those `keep` admits when it is given. */
function addSynonymParts(
	into: Set<string>,
	token: string,
	useSynonyms: boolean,
	keep?: (part: string) => boolean,
): void {
	for (const variant of recallSynonyms(token, useSynonyms)) {
		for (const part of tokenize(variant)) if (keep === undefined || keep(part)) into.add(part);
	}
}

function expandedTokens(query: string, useSynonyms = true): string[] {
	const seen = new Set<string>();
	for (const token of tokenize(query)) addSynonymParts(seen, token, useSynonyms);
	return Array.from(seen);
}

function expandedTokenGroups(query: string, useSynonyms = true): string[][] {
	const groups: string[][] = [];
	for (const token of tokenize(query)) {
		const seen = new Set<string>();
		addSynonymParts(seen, token, useSynonyms);
		if (seen.size > 0) groups.push(Array.from(seen));
	}
	return groups;
}

function factExpandedTokenGroups(query: string, content: string): string[][] {
	const contentTokens = new Set(tokenize(content.toLowerCase()));
	// A filler word counts toward a fact match only when the fact uses it and it is no clitic fragment.
	const keep = (part: string): boolean =>
		!FACT_QUERY_FILLER_WORDS.has(part) || (!FACT_CLITIC_FRAGMENTS.has(part) && contentTokens.has(part));
	const groups: string[][] = [];
	for (const token of tokenize(query)) {
		if (!keep(token)) continue;
		const seen = new Set<string>();
		addSynonymParts(seen, token, true, keep);
		if (seen.size > 0) groups.push(Array.from(seen));
	}
	return groups;
}

function contentMatchesToken(contentLower: string, contentTokens: ReadonlySet<string>, token: string): boolean {
	if (contentTokens.has(token) || contentLower.includes(token)) return true;
	for (const contentToken of contentTokens) {
		if (
			contentToken.length >= 4 &&
			token.length >= 4 &&
			(contentToken.includes(token) || token.includes(contentToken))
		) {
			return true;
		}
	}
	return false;
}

function lexicalGroupRelevance(
	queryGroups: readonly (readonly string[])[],
	content: string,
	normalizedQuery: string,
): number {
	if (queryGroups.length === 0) return 0;
	const contentLower = content.toLowerCase();
	if (queryGroups.length > 1 && normalizedQuery.length > 0 && contentLower.includes(normalizedQuery)) return 1;
	const contentTokens = new Set(tokenize(contentLower));
	// contentMatchesToken covers the exact-token, substring and >=4-char partial-substring cases; a group counts
	// once when any of its tokens matches.
	const matched = queryGroups.filter(group =>
		group.some(token => contentMatchesToken(contentLower, contentTokens, token)),
	).length;
	if (queryGroups.length > 1) return clamp01(matched / queryGroups.length);
	if (matched === 0) return 0;
	return clamp01(0.7 + clamp(occurrences(contentLower, queryGroups[0]?.[0] ?? "") - 1, 0, 3) * 0.1);
}

/** The non-overlapping occurrences of `token` in `text`; 0 for an empty token. */
function occurrences(text: string, token: string): number {
	if (token.length === 0) return 0;
	let count = 0;
	for (let idx = text.indexOf(token); idx >= 0; idx = text.indexOf(token, idx + token.length)) count += 1;
	return count;
}

function queryAsksCurrent(query: string): boolean {
	return /\b(?:now|current|currently|latest|recent|today|active|present)\b/i.test(query);
}

function currentContentAdjustment(content: string, currentSensitive: boolean): number {
	if (!currentSensitive) return 1;
	const lowered = content.toLowerCase();
	let factor = 1;
	if (/\b(?:current|currently|latest|now|active|present)\b/.test(lowered)) factor *= 1.35;
	if (/\b(?:was|previous|previously|legacy|old|stale|former|deprecated)\b/.test(lowered)) factor *= 0.72;
	return factor;
}

function minimumRelevance(tokens: readonly string[]): number {
	if (tokens.length <= 1) return 0.08;
	if (tokens.length === 2) return 0.18;
	if (tokens.length === 3) return 0.34;
	return 0.22;
}

function inferTemporalOptions(query: string, options: RecallOptionsInternal): RecallOptionsInternal {
	const copy: RecallOptionsInternal = { ...options };
	const info = extractTemporal(query, options.queryTime ?? undefined);
	if (info.event_date !== null) {
		copy.queryTime ??= info.event_date;
		copy.temporalWeight ??= 0.35;
	}
	return copy;
}

function ftsPhrase(token: string): string {
	return `"${token.replaceAll('"', '""')}"`;
}

function ftsQuery(query: string, useSynonyms = true): string {
	const tokens = expandedTokens(query, useSynonyms).slice(0, 12);
	if (tokens.length === 0) return ftsPhrase(query.trim());
	return tokens.map(ftsPhrase).join(" OR ");
}

function queryAll(beam: BeamMemoryState, sql: string, params: readonly DbValue[] = []): Row[] {
	return beam.db.query(sql).all(...params) as Row[];
}

function tableExists(beam: BeamMemoryState, table: string): boolean {
	return tableExistsIn(beam.db, table);
}

function factsHaveScopeColumn(beam: BeamMemoryState): boolean {
	const rows = queryAll(beam, "PRAGMA table_info(facts)");
	return rows.some(row => stringOrEmpty(row.name) === "scope");
}

function factVisibilityWhere(beam: BeamMemoryState, tableAlias: string): { where: string; params: DbValue[] } {
	const prefix = tableAlias.length === 0 ? "" : `${tableAlias}.`;
	if (factsHaveScopeColumn(beam)) {
		return { where: `(${prefix}session_id = ? OR ${prefix}scope = 'global')`, params: [beam.sessionId] };
	}
	return { where: `${prefix}session_id = ?`, params: [beam.sessionId] };
}

/** The session-scope clause: every session, a channel, an author filter, or this session and global memories. */
function scopeClause(
	beam: BeamMemoryState,
	prefix: string,
	options: RecallOptionsInternal,
): { clause: string; params: DbValue[] } {
	if (options.ignoreSessionScope === true) return { clause: "1=1", params: [] };
	const channelId = options.channelId ?? null;
	if (channelId !== null && channelId !== "") {
		return {
			clause: `(${prefix}session_id = ? OR ${prefix}scope = 'global' OR ${prefix}channel_id = ?)`,
			params: [beam.sessionId, channelId],
		};
	}
	if ((options.authorId ?? null) !== null || (options.authorType ?? null) !== null)
		return { clause: "1=1", params: [] };
	return { clause: `(${prefix}session_id = ? OR ${prefix}scope = 'global')`, params: [beam.sessionId] };
}

/** Each optional recall filter: its condition on one column and the bound value, null when the filter is unset. */
const RECALL_FILTERS: readonly (readonly [string, (options: RecallOptionsInternal) => string | null])[] = [
	["timestamp >= ?", options => (options.fromDate == null ? null : `${options.fromDate}T00:00:00`)],
	["timestamp <= ?", options => (options.toDate == null ? null : `${options.toDate}T23:59:59`)],
	["source = ?", options => options.source || null],
	["veracity = ?", options => options.veracity ?? null],
	["memory_type = ?", options => options.memoryType ?? null],
	["author_id = ?", options => options.authorId ?? null],
	["author_type = ?", options => options.authorType ?? null],
	["channel_id = ?", options => options.channelId || null],
];

function buildWhere(
	beam: BeamMemoryState,
	tableAlias: string,
	options: RecallOptionsInternal,
): { where: string; params: DbValue[] } {
	// `topic` FAILS CLOSED rather than filtering something else. Neither `working_memory` nor
	// `episodic_memory` has a topic column (only the `memoria_*` tables do), and this clause used
	// to push `source = ?` bound to the topic value. That is a silent alias with two consequences,
	// both invisible to the caller: `{ topic: "x" }` alone returned memories whose SOURCE is "x",
	// which is a plausible-looking result set that answers a different question, and
	// `{ source: "a", topic: "b" }` emitted `source = 'a' AND source = 'b'`, a self-contradicting
	// filter that is always empty and reads as "no memories match" rather than as a bug.
	if (options.topic) {
		throw new Error(
			`recall() was given topic ${JSON.stringify(options.topic)}, but working and episodic memory have no ` +
				"topic column, so the filter cannot be applied. Filter on `source` if that is what you meant, " +
				"or query the memoria_preferences / memoria_instructions tables, which are the ones that carry " +
				"a topic.",
		);
	}
	const prefix = tableAlias.length === 0 ? "" : `${tableAlias}.`;
	const scope = scopeClause(beam, prefix, options);
	const clauses = [
		`(${prefix}valid_until IS NULL OR ${prefix}valid_until > ?)`,
		`${prefix}superseded_by IS NULL`,
		scope.clause,
	];
	const params: DbValue[] = [toUtcIso(), ...scope.params];
	for (const [condition, read] of RECALL_FILTERS) {
		const value = read(options);
		if (value === null) continue;
		clauses.push(`${prefix}${condition}`);
		params.push(value);
	}
	return { where: clauses.join(" AND "), params };
}

const MEMORY_COLUMNS =
	"id, content, source, timestamp, session_id, importance, metadata_json, veracity, memory_type, recall_count, last_recalled, valid_until, superseded_by, scope, author_id, author_type, channel_id, event_date, event_date_precision, temporal_tags";
const WORKING_MEMORY_COLUMNS =
	"id, content, embed_text, source, timestamp, session_id, importance, metadata_json, veracity, memory_type, recall_count, last_recalled, valid_until, superseded_by, scope, author_id, author_type, channel_id, event_date, event_date_precision, temporal_tags";
const EPISODIC_COLUMNS = `${MEMORY_COLUMNS}, rowid, summary_of, tier`;

function ftsRows(
	beam: BeamMemoryState,
	table: "fts_working" | "fts_episodes",
	query: string,
	limit: number,
	useSynonyms = true,
): Row[] {
	if (!tableExists(beam, table)) return [];
	if (table === "fts_working") {
		return queryAll(beam, "SELECT id, rank FROM fts_working WHERE fts_working MATCH ? ORDER BY rank, id LIMIT ?", [
			ftsQuery(query, useSynonyms),
			limit,
		]);
	}
	return queryAll(
		beam,
		"SELECT rowid, rank FROM fts_episodes WHERE fts_episodes MATCH ? ORDER BY rank, rowid LIMIT ?",
		[ftsQuery(query, useSynonyms), limit],
	);
}

function normalizeRanks(rows: readonly Row[], key: string): Map<string | number, number> {
	const out = new Map<string | number, number>();
	if (rows.length === 0) return out;
	let min = Number.POSITIVE_INFINITY;
	let max = Number.NEGATIVE_INFINITY;
	for (const row of rows) {
		const rank = numberOrDefault(row.rank, 0);
		if (rank < min) min = rank;
		if (rank > max) max = rank;
	}
	const range = max === min ? 1 : max - min;
	for (const row of rows) {
		const id = row[key] as string | number | undefined;
		if (id === undefined) continue;
		out.set(id, 1 - (numberOrDefault(row.rank, 0) - min) / range);
	}
	return out;
}

function vectorSimilarities(
	beam: BeamMemoryState,
	memoryIds: readonly string[],
	queryEmbedding: readonly number[] | null | undefined,
): Map<string, number> {
	const out = new Map<string, number>();
	if (
		queryEmbedding == null ||
		queryEmbedding.length === 0 ||
		memoryIds.length === 0 ||
		!tableExists(beam, "memory_embeddings")
	) {
		return out;
	}
	// One scorer for the whole sweep: the query norm and finite-value check are
	// computed once here, not per candidate. cosineScorer is byte-identical to
	// cosineSimilarity(queryEmbedding, vector).
	const score = cosineScorer(queryEmbedding);
	for (const chunk of batched(memoryIds, SQLITE_IN_CLAUSE_BATCH)) {
		const rows = queryAll(
			beam,
			`SELECT memory_id, embedding_json FROM memory_embeddings WHERE memory_id IN (${sqlPlaceholders(chunk.length)})`,
			chunk,
		);
		for (const row of rows) {
			const vector = decodeEmbeddingJson(row.embedding_json);
			const id = stringOrEmpty(row.memory_id);
			if (vector !== null && id.length > 0) out.set(id, Math.max(0, score(vector)));
		}
	}
	return out;
}

function allVisibleIds(
	beam: BeamMemoryState,
	table: "working_memory" | "episodic_memory",
	options: RecallOptionsInternal,
): string[] {
	const { where, params } = buildWhere(beam, "", options);
	const rows = queryAll(beam, `SELECT id FROM ${table} WHERE ${where} ORDER BY timestamp DESC LIMIT ?`, [
		...params,
		DEFAULT_LIMIT,
	]);
	return rows.map(row => stringOrEmpty(row.id)).filter(Boolean);
}

function fetchCandidates(
	beam: BeamMemoryState,
	tierLabel: TierLabel,
	idsOrRowids: readonly (string | number)[],
	ftsScores: Map<string | number, number>,
	vecScores: Map<string, number>,
	options: RecallOptionsInternal,
): MemoryCandidate[] {
	if (idsOrRowids.length === 0) return [];
	const table = tierLabel === "working" ? "working_memory" : "episodic_memory";
	const keyColumn = tierLabel === "working" ? "id" : "rowid";
	const columns = tierLabel === "working" ? WORKING_MEMORY_COLUMNS : EPISODIC_COLUMNS;
	const { where, params } = buildWhere(beam, "m", options);
	const rows = queryAll(
		beam,
		`SELECT ${columns
			.split(", ")
			.map(column => `m.${column}`)
			.join(", ")} FROM ${table} m WHERE m.${keyColumn} IN (${sqlPlaceholders(idsOrRowids.length)}) AND ${where}`,
		[...idsOrRowids, ...params],
	);
	const out: MemoryCandidate[] = [];
	for (const row of rows) {
		const rowKey = tierLabel === "working" ? stringOrEmpty(row.id) : numberOrDefault(row.rowid);
		const id = stringOrEmpty(row.id);
		const fts = ftsScores.get(rowKey) ?? 0;
		const ftsMatched = ftsScores.has(rowKey);
		const dense = vecScores.get(id) ?? 0;
		out.push({
			row,
			tierLabel,
			signals: {
				fts,
				ftsMatched,
				dense,
				keyword: 0,
				candidateSource: ftsMatched ? "fts" : dense > 0 ? "vec" : "fallback",
			},
		});
	}
	return out;
}

function fallbackCandidates(
	beam: BeamMemoryState,
	tierLabel: TierLabel,
	options: RecallOptionsInternal,
): MemoryCandidate[] {
	const table = tierLabel === "working" ? "working_memory" : "episodic_memory";
	const columns = tierLabel === "working" ? WORKING_MEMORY_COLUMNS : EPISODIC_COLUMNS;
	const { where, params } = buildWhere(beam, "", options);
	const rows = queryAll(beam, `SELECT ${columns} FROM ${table} WHERE ${where} ORDER BY timestamp DESC LIMIT ?`, [
		...params,
		Math.min(DEFAULT_LIMIT, 2000),
	]);
	return rows.map(row => ({
		row,
		tierLabel,
		signals: { fts: 0, ftsMatched: false, dense: 0, keyword: 0, candidateSource: "fallback" },
	}));
}

/** The tier's blend of the dense, full-text, keyword and importance signals. */
function baseRelevance(
	candidate: MemoryCandidate,
	lexical: number,
	importance: number,
	weights: readonly [number, number, number],
): number {
	const [vecWeight, ftsWeight, importanceWeight] = weights;
	const { dense, fts } = candidate.signals;
	if (candidate.tierLabel === "episodic") {
		return Math.max(dense * vecWeight + fts * ftsWeight + importance * importanceWeight, lexical * 0.8);
	}
	const keyword = Math.max(lexical, fts * 0.6);
	const score = keyword * ((1 - importanceWeight) * 0.6) + importance * importanceWeight + keyword * keyword * 0.08;
	return dense > 0 ? score * 0.8 + dense * 0.2 : score;
}

/** How near the memory's timestamp, or its event date at twice the half-life, is to the query time. */
function temporalSignal(row: Row, options: RecallOptionsInternal): number {
	const queryTime = parseQueryTime(options.queryTime);
	const halflife = options.temporalHalflife ?? temporalHalflifeHours();
	return Math.max(
		temporalBoost(stringOrEmpty(row.timestamp), queryTime, halflife),
		temporalBoost(stringOrEmpty(row.event_date), queryTime, halflife * 2),
	);
}

/** How recent the memory is: its decay from now, or its nearness to the query time when one is set. */
function recencySignal(row: Row, options: RecallOptionsInternal): number {
	const timestamp = stringOrEmpty(row.timestamp);
	return options.queryTime == null
		? recencyDecay(timestamp, 72, undefined, 0)
		: temporalBoost(timestamp, parseQueryTime(options.queryTime), 72);
}

/** The weight of an episodic memory's degradation tier: 1, 0.85, then 0.7; 1 for a working memory. */
function degradationWeight(tier: number | undefined): number {
	if (tier === undefined || tier === 1) return 1;
	return tier === 2 ? 0.85 : 0.7;
}

function scoreCandidate(
	candidate: MemoryCandidate,
	queryTokens: readonly string[],
	queryGroups: readonly (readonly string[])[],
	normalizedQueryLower: string,
	weights: readonly [number, number, number],
	options: RecallOptionsInternal,
): RecallResult | null {
	const content = stringOrEmpty(candidate.row.content);
	const searchableContent = stringOrEmpty(candidate.row.embed_text) || content;
	// lexicalGroupRelevance is the single lexical scorer. When queryGroups is
	// empty the query produced no lexical tokens at all (expandedTokens and
	// expandedTokenGroups share one token/synonym loop, so a token joins both or
	// neither), which means there is no lexical signal to score: the contribution
	// is 0 and scoring falls to the dense/importance terms.
	const lexical =
		queryGroups.length > 0 ? lexicalGroupRelevance(queryGroups, searchableContent, normalizedQueryLower) : 0;
	const minRel = minimumRelevance(queryTokens);
	if (lexical < minRel && candidate.signals.dense < 0.65) return null;
	const importance = numberOrDefault(candidate.row.importance, 0.5);
	const decay = recencySignal(candidate.row, options);
	let score = baseRelevance(candidate, lexical, importance, weights) * (0.7 + 0.3 * decay);
	const temporalWeight = options.temporalWeight ?? 0;
	const temporalScore = temporalWeight > 0 ? temporalSignal(candidate.row, options) : 0;
	if (temporalWeight > 0) score *= 1 + temporalWeight * temporalScore;
	// Was a private eight-value table plus `?? VERACITY_WEIGHTS.unknown ?? 0.8`. The chain
	// scored any value outside that table exactly like an unlabelled memory, without a word,
	// which is what `contested` got for the whole time it was a member of the union in
	// `./types`. `weightForVeracity` reads the one vocabulary and names what it does not know.
	const veracityWeight = weightForVeracity(candidate.row.veracity);
	const degradationTier = candidate.tierLabel === "episodic" ? numberOrDefault(candidate.row.tier, 1) : undefined;
	score *= degradationWeight(degradationTier);
	score *= veracityWeight * currentContentAdjustment(searchableContent, options.currentSensitive === true);
	const preview = clipRecallContent(content, options.contentPreviewChars ?? RECALL_CONTENT_PREVIEW_CHARS);
	const result: RecallResult = {
		...candidate.row,
		id: stringOrEmpty(candidate.row.id),
		content: preview.content,
		source: nullableString(candidate.row.source),
		timestamp: nullableString(candidate.row.timestamp),
		importance,
		score: round4(score),
		rank: candidate.signals.fts,
		tier: candidate.tierLabel,
		tier_label: candidate.tierLabel,
		degradation_tier: degradationTier,
		keyword_score: round4(lexical),
		dense_score: round4(candidate.signals.dense),
		fts_score: round4(candidate.signals.fts),
		importance_score: round4(importance),
		recency_score: round4(decay),
		temporal_score: round4(temporalScore),
		recall_count: numberOrDefault(candidate.row.recall_count, 0),
		last_recalled: nullableString(candidate.row.last_recalled),
		explanation: explain(candidate.tierLabel, candidate.signals, lexical, temporalScore),
		voice_scores: {
			vec: round4(candidate.signals.dense),
			fts: round4(candidate.signals.fts),
			keyword: round4(lexical),
			importance: round4(importance),
			recency_decay: round4(decay),
			temporal: round4(temporalScore),
		},
		truncated: preview.truncated,
		full_length: preview.fullLength,
	};
	return result;
}

function explain(tierLabel: TierLabel, signals: CandidateSignals, lexical: number, temporalScore: number): string {
	const parts: string[] = [tierLabel, signals.candidateSource];
	if (lexical > 0) parts.push(`keyword=${round4(lexical)}`);
	if (signals.dense > 0) parts.push(`dense=${round4(signals.dense)}`);
	if (temporalScore > 0) parts.push(`temporal=${round4(temporalScore)}`);
	return parts.join(" ");
}

function dedupeResults(results: readonly RecallResult[]): RecallResult[] {
	const seen = new Set<string>();
	const out: RecallResult[] = [];
	for (const result of results) {
		const key = `${result.tier_label ?? ""}:${result.id}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(result);
	}
	return out;
}

/** Drop each episodic summary recalled beside a working memory it summarizes. */
function dedupCrossTierSummaryLinks(beam: BeamMemoryState, results: readonly RecallResult[]): RecallResult[] {
	const workingIds = new Set<string>();
	const episodicIds = new Set<string>();
	for (const result of results) {
		const tier = result.tier_label ?? result.tier;
		if (tier === "working") workingIds.add(result.id);
		else if (tier === "episodic" && result.id.length > 0) episodicIds.add(result.id);
	}
	if (workingIds.size === 0 || episodicIds.size === 0) return results.slice();

	const ids = Array.from(episodicIds);
	const summaryRows = queryAll(
		beam,
		`SELECT id, summary_of FROM episodic_memory WHERE id IN (${sqlPlaceholders(ids.length)})`,
		ids,
	);
	const dropped = new Set<string>();
	for (const row of summaryRows) {
		const summarizesRecalled = stringOrEmpty(row.summary_of)
			.split(",")
			.some(id => {
				const trimmed = id.trim();
				return trimmed.length > 0 && workingIds.has(trimmed);
			});
		if (summarizesRecalled) dropped.add(stringOrEmpty(row.id));
	}
	if (dropped.size === 0) return results.slice();
	return results.filter(result => (result.tier_label ?? result.tier) !== "episodic" || !dropped.has(result.id));
}

function rerankRecallResults(results: readonly RecallResult[], lambdaParam: number, topK: number): RecallResult[] {
	const items: RecallMmrItem[] = results.map(result => ({
		content: result.content,
		score: result.score,
		result,
	}));
	return mmrRerank(items, lambdaParam, topK).map(item => item.result);
}

function updateRecallCounts(
	beam: BeamMemoryState,
	results: readonly RecallResult[],
	options: RecallOptionsInternal,
): void {
	const timestamp = toUtcIso();
	for (const tierLabel of ["working", "episodic"] as const) {
		const ids = results.filter(r => r.tier_label === tierLabel).map(r => r.id);
		if (ids.length === 0) continue;
		const table = tierLabel === "working" ? "working_memory" : "episodic_memory";
		const { where, params } = buildWhere(beam, "", options);
		beam.db.run(
			`UPDATE ${table} SET recall_count = COALESCE(recall_count, 0) + 1, last_recalled = ? WHERE id IN (${sqlPlaceholders(ids.length)}) AND ${where}`,
			[timestamp, ...ids, ...params],
		);
	}
}

/** The ids of the `limit` entries of `similarities` with the highest similarity. */
function mostSimilar(similarities: ReadonlyMap<string, number>, limit: number): string[] {
	return Array.from(similarities.entries())
		.sort((a, b) => b[1] - a[1])
		.slice(0, limit)
		.map(([id]) => id);
}

/** The positive rowids of the episodic memories `ids` names. */
function episodicRowids(beam: BeamMemoryState, ids: readonly string[]): number[] {
	if (ids.length === 0) return [];
	return queryAll(beam, `SELECT rowid, id FROM episodic_memory WHERE id IN (${sqlPlaceholders(ids.length)})`, ids)
		.map(row => numberOrDefault(row.rowid))
		.filter(rowid => rowid > 0);
}

function collectMemoryCandidates(
	beam: BeamMemoryState,
	query: string,
	topK: number,
	options: RecallOptionsInternal,
): MemoryCandidate[] {
	const limit = Math.max(topK * 3, 50);
	const useSynonyms = options.useSynonyms !== false;
	const includeWorking = options.includeWorking !== false;
	const wmFts = normalizeRanks(includeWorking ? ftsRows(beam, "fts_working", query, limit, useSynonyms) : [], "id");
	const emFts = normalizeRanks(ftsRows(beam, "fts_episodes", query, limit, useSynonyms), "rowid");

	let wmIds = Array.from(wmFts.keys()).filter((id): id is string => typeof id === "string");
	let emRowids = Array.from(emFts.keys()).filter((id): id is number => typeof id === "number");
	const queryEmbedding = options.queryEmbedding ?? null;
	let wmVec = new Map<string, number>();
	let emVec = new Map<string, number>();
	if (queryEmbedding !== null) {
		wmVec = vectorSimilarities(
			beam,
			includeWorking ? allVisibleIds(beam, "working_memory", options) : [],
			queryEmbedding,
		);
		emVec = vectorSimilarities(beam, allVisibleIds(beam, "episodic_memory", options), queryEmbedding);
		wmIds = Array.from(new Set(wmIds.concat(mostSimilar(wmVec, limit))));
		emRowids = Array.from(new Set(emRowids.concat(episodicRowids(beam, mostSimilar(emVec, limit)))));
	}

	const working =
		wmIds.length > 0
			? fetchCandidates(beam, "working", wmIds, wmFts, wmVec, options)
			: includeWorking
				? fallbackCandidates(beam, "working", options)
				: [];
	const episodic =
		emRowids.length > 0
			? fetchCandidates(beam, "episodic", emRowids, emFts, emVec, options)
			: fallbackCandidates(beam, "episodic", options);
	return working.concat(episodic);
}

/** The options a recall runs with: the inferred temporal focus, the current-state focus and the query embedding. */
async function resolveRecallOptions(query: string, options: RecallOptionsInternal): Promise<RecallOptionsInternal> {
	const resolved = inferTemporalOptions(query, options);
	if (queryAsksCurrent(query)) {
		resolved.queryTime ??= options.queryTime ?? new Date();
		resolved.temporalWeight ??= 0.45;
		resolved.currentSensitive = true;
	}
	if (resolved.queryEmbedding === undefined) {
		// Honour `null` (explicit "no embedding"); `undefined` means "derive from query text".
		// `embedQuery()` returns null when embeddings are disabled or no provider is configured,
		// so this is a no-op when the user has not wired one up. Float32Array → number[]
		// because RecallOptions exposes the narrower public shape.
		const derived = query.length > 0 ? await embedQuery(query) : null;
		resolved.queryEmbedding = derived === null ? null : Array.from(derived);
	}
	return resolved;
}

/** The vector, full-text and importance weights, adjusted for the query's intent when the caller asks. */
function recallWeights(beam: BeamMemoryState, query: string, options: RecallOptionsInternal): HybridWeights {
	const weights = normalizedRecallWeights(
		options.vecWeight ?? beam.config.vecWeight,
		options.ftsWeight ?? beam.config.ftsWeight,
		options.importanceWeight ?? beam.config.importanceWeight,
	);
	if (options.useIntent !== true) return weights;
	return adjustWeights(weights[0], weights[1], weights[2], classifyIntent(query));
}

export async function recall(
	beam: BeamMemoryState,
	query: string,
	topK = 40,
	options: RecallOptionsInternal = {},
): Promise<RecallResult[]> {
	if (topK <= 0) return [];
	const resolved = await resolveRecallOptions(query, options);
	const weights = recallWeights(beam, query, options);
	const useSynonyms = options.useSynonyms !== false;
	const tokens = expandedTokens(query, useSynonyms);
	const tokenGroups = expandedTokenGroups(query, useSynonyms);
	const normalized = normalizeQuery(query).toLowerCase();
	const scored: RecallResult[] = [];
	for (const candidate of collectMemoryCandidates(beam, query, topK, resolved)) {
		const result = scoreCandidate(candidate, tokens, tokenGroups, normalized, weights, resolved);
		if (result !== null) scored.push(result);
	}
	scored.sort((left, right) => (right.score ?? 0) - (left.score ?? 0));
	let finalResults = dedupCrossTierSummaryLinks(beam, dedupeResults(scored));
	if (query.length > 0 && tokens.length >= 4 && finalResults.length > topK)
		finalResults = diversifyByCoverage(finalResults, tokens, topK);
	finalResults =
		options.useMmr === true && finalResults.length > 1
			? rerankRecallResults(finalResults, options.mmrLambda ?? 0.7, topK)
			: finalResults.slice(0, topK);
	if (resolved.updateRecallCounts !== false) updateRecallCounts(beam, finalResults, resolved);
	return finalResults;
}

interface CoverageEntry {
	readonly result: RecallResult;
	/** Each occurrence of a query token in the result's content. */
	readonly queryTokens: readonly string[];
}

/** The index of the entry whose score plus 0.06 per query token it adds to `covered` is highest, the first on a tie. */
function bestCoverageIndex(pool: readonly CoverageEntry[], covered: ReadonlySet<string>): number {
	let bestIdx = 0;
	let bestScore = Number.NEGATIVE_INFINITY;
	for (let i = 0; i < pool.length; i += 1) {
		const entry = pool[i]!;
		let additions = 0;
		for (const token of entry.queryTokens) if (!covered.has(token)) additions += 1;
		const score = (entry.result.score ?? 0) + 0.06 * additions;
		if (score > bestScore) {
			bestScore = score;
			bestIdx = i;
		}
	}
	return bestIdx;
}

function diversifyByCoverage(
	results: readonly RecallResult[],
	tokens: readonly string[],
	topK: number,
): RecallResult[] {
	const querySet = new Set(tokens);
	const pool: CoverageEntry[] = results.map(result => ({
		result,
		queryTokens: tokenize(result.content).filter(token => querySet.has(token)),
	}));
	const selected: RecallResult[] = [];
	const covered = new Set<string>();
	while (pool.length > 0 && selected.length < topK) {
		const picked = pool.splice(bestCoverageIndex(pool, covered), 1)[0]!;
		selected.push(picked.result);
		for (const token of picked.queryTokens) covered.add(token);
	}
	return selected;
}

export async function recallEnhanced(
	beam: BeamMemoryState,
	query: string,
	topK = 40,
	options: RecallEnhancedOptions & RecallOptionsInternal = {},
): Promise<RecallResult[]> {
	const useSynonyms = options.useSynonyms !== false;
	const enhancedOptions: RecallOptionsInternal = {
		...options,
		useSynonyms,
		useIntent: options.useIntent !== false,
		useMmr: options.useMmr !== false,
	};
	const results = await recall(beam, query, Math.max(topK * 2, topK), {
		...enhancedOptions,
		updateRecallCounts: false,
	});
	if (options.includeFacts === true) {
		const facts = factRecall(beam, query, factRecallLimit(topK));
		results.push(...facts);
	}
	results.sort((left, right) => (right.score ?? 0) - (left.score ?? 0));
	const finalResults = rerankRecallResults(results, options.mmrLambda ?? 0.7, topK);
	if (enhancedOptions.updateRecallCounts !== false) updateRecallCounts(beam, finalResults, enhancedOptions);
	return finalResults;
}

function factRecallLimit(topK: number): number {
	const requested = Math.max(0, Math.floor(topK));
	if (requested === 0) return 0;
	return Math.min(requested, Math.max(3, Math.ceil(requested / 2)));
}

function sandwichOrder(results: readonly RecallResult[]): {
	high: RecallResult[];
	medium: RecallResult[];
	closing: RecallResult[];
} {
	const scored = results.slice().sort((left, right) => (right.score ?? 0) - (left.score ?? 0));
	const highLimit = scored.length > 0 && scored.length < 4 ? 1 : 3;
	const high = scored.slice(0, highLimit);
	const medium = scored.slice(high.length, high.length + 5);
	const closing = scored.slice(high.length + medium.length, high.length + medium.length + 3);
	return { high, medium, closing };
}
function factSearchableText(subject: string, predicate: string, object: string): string {
	const objectText = object.trim();
	if (objectText.length === 0) return `${subject} ${predicate}`.trim();
	const structuralParts = [subject, predicate].filter(part => {
		const token = part.trim().toLowerCase();
		return token.length > 0 && FLAT_FACT_SEARCH_NOISE[token] !== true;
	});
	return [...structuralParts, objectText].join(" ").trim();
}

function factLine(result: RecallResult): string {
	const content = clipRecallContent(result.content.trim(), 200).content;
	const ts = typeof result.timestamp === "string" && result.timestamp.length > 0 ? result.timestamp.slice(0, 10) : "?";
	const source = result.source ?? "unknown";
	const score = result.score ?? result.importance ?? 0;
	return `${content} (${ts}, ${source}, c:${score.toFixed(1)})`;
}

export function formatContext(beam: BeamMemoryState, results: readonly RecallResult[], format = "bullet"): string {
	void beam;
	const sandwich = sandwichOrder(results);
	if (format === "json") {
		return JSON.stringify(
			{
				top_facts: sandwich.high.map(factLine),
				supporting_context: sandwich.medium.map(factLine),
				recent_memories: sandwich.closing.map(factLine),
				total_memories: sandwich.high.length + sandwich.medium.length + sandwich.closing.length,
			},
			null,
			2,
		);
	}
	const lines = ["## Top Facts"];
	for (const result of sandwich.high) lines.push(`- ${factLine(result)}`);
	if (sandwich.medium.length > 0) {
		lines.push("", "## Supporting Context");
		for (const result of sandwich.medium) lines.push(`- ${factLine(result)}`);
	}
	if (sandwich.closing.length > 0) {
		lines.push("", "## Recent Signals");
		for (const result of sandwich.closing) lines.push(`- ${factLine(result)}`);
	}
	lines.push(`\n_(${sandwich.high.length + sandwich.medium.length + sandwich.closing.length} memories retrieved)_`);
	return lines.join("\n");
}

/** The visible facts the full-text index matches, best rank first; none without the index or on a query it rejects. */
function ftsFactMatches(beam: BeamMemoryState, query: string, topK: number): Row[] {
	if (!tableExists(beam, "fts_facts")) return [];
	try {
		const visibility = factVisibilityWhere(beam, "facts");
		return queryAll(
			beam,
			`SELECT fts_facts.rowid, fts_facts.rank
			 FROM fts_facts
			 JOIN facts ON facts.rowid = fts_facts.rowid
			 WHERE fts_facts MATCH ? AND ${visibility.where}
			 ORDER BY fts_facts.rank, fts_facts.rowid
			 LIMIT ?`,
			[ftsQuery(query), ...visibility.params, topK * 3],
		);
	} catch {
		return [];
	}
}

/** The visible facts whose subject, predicate or object contains one of the first six query tokens, each once. */
function likeFactMatches(beam: BeamMemoryState, query: string, topK: number): Row[] {
	const visibility = factVisibilityWhere(beam, "");
	const seen = new Set<number>();
	const matched: Row[] = [];
	for (const token of expandedTokens(query).slice(0, 6)) {
		const pattern = `%${token}%`;
		const rows = queryAll(
			beam,
			`SELECT rowid
			 FROM facts
			 WHERE (subject LIKE ? OR predicate LIKE ? OR object LIKE ?) AND ${visibility.where}
			 LIMIT ?`,
			[pattern, pattern, pattern, ...visibility.params, topK],
		);
		for (const row of rows) {
			const rowid = numberOrDefault(row.rowid);
			if (rowid <= 0 || seen.has(rowid)) continue;
			seen.add(rowid);
			matched.push({ rowid, rank: 0 });
		}
	}
	return matched;
}

/** Score one fact row against the query: keyword relevance weighted by its confidence and full-text rank. */
function factResult(
	row: Row,
	query: string,
	normalizedQuery: string,
	ranks: ReadonlyMap<string | number, number>,
): FactRecallResult {
	const subject = stringOrEmpty(row.subject);
	const predicate = stringOrEmpty(row.predicate);
	const object = stringOrEmpty(row.object);
	const confidence = numberOrDefault(row.confidence, 0.5);
	const searchable = factSearchableText(subject, predicate, object);
	const queryGroups = factExpandedTokenGroups(query, searchable);
	// Empty queryGroups means no lexical tokens survived filtering, so the
	// lexical contribution is 0 (see scoreCandidate for the same invariant).
	const lexical = queryGroups.length > 0 ? lexicalGroupRelevance(queryGroups, searchable, normalizedQuery) : 0;
	const rank = ranks.get(numberOrDefault(row.rowid)) ?? 0;
	return {
		id: stringOrEmpty(row.fact_id),
		content: object.length > 0 ? object : `${subject} ${predicate}`.trim(),
		score: round4(lexical * (0.7 + confidence * 0.2 + rank * 0.1)),
		fact_id: stringOrEmpty(row.fact_id),
		subject,
		predicate,
		timestamp: nullableString(row.timestamp),
		tier_label: "fact",
		tier: "fact",
		source: "facts",
		keyword_score: round4(lexical),
		fts_score: round4(rank),
		importance_score: round4(confidence),
		explanation: `fact keyword=${round4(lexical)}`,
		voice_scores: {
			keyword: round4(lexical),
			fts: round4(rank),
			importance: round4(confidence),
		},
	};
}

export function factRecall(beam: BeamMemoryState, query: string, topK = 30): FactRecallResult[] {
	if (topK <= 0 || !tableExists(beam, "facts")) return [];
	let matched = ftsFactMatches(beam, query, topK);
	if (matched.length === 0) matched = likeFactMatches(beam, query, topK);
	const rowids = matched.map(row => numberOrDefault(row.rowid)).filter(rowid => rowid > 0);
	if (rowids.length === 0) return [];
	const visibility = factVisibilityWhere(beam, "");
	const ranks = normalizeRanks(matched, "rowid");
	const normalized = normalizeQuery(query).toLowerCase();
	const rows = queryAll(
		beam,
		`SELECT rowid, fact_id, subject, predicate, object, timestamp, confidence
		 FROM facts
		 WHERE rowid IN (${sqlPlaceholders(rowids.length)}) AND ${visibility.where}
		 ORDER BY confidence DESC
		 LIMIT ?`,
		[...rowids, ...visibility.params, rowids.length],
	);
	return rows
		.map(row => factResult(row, query, normalized, ranks))
		.filter(result => (result.score ?? 0) > 0)
		.sort((left, right) => (right.score ?? 0) - (left.score ?? 0))
		.slice(0, topK);
}
