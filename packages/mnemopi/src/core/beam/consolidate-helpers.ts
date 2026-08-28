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

import type { Row } from "./consolidate";
import {
	CONTAMINATED_VERACITY,
	DEGRADE_BATCH_SIZE,
	SLEEP_BATCH_SIZE,
	TIER2_DAYS,
	TIER3_DAYS,
	TIER3_MAX_CHARS,
	aggregateEpisodicVeracity,
	asRows,
	buildSleepSummary,
	classifyAbility,
	consolidateToEpisodic,
	cutoffIso,
	isoNow,
	makeQuestionTokens,
	rowValue,
	sourceSession,
	splitSleepItems,
} from "./consolidate";

function factRetrieve(beam: BeamMemoryState, query: string, topK: number): MemoriaRetrieveResult {
	const tokens = makeQuestionTokens(query);
	const clauses: string[] = [];
	const params: SQLQueryBindings[] = [sourceSession(beam)];
	for (const token of tokens) {
		clauses.push(
			"(lower(key) LIKE ? ESCAPE '\\' OR lower(value) LIKE ? ESCAPE '\\' OR lower(context_snippet) LIKE ? ESCAPE '\\')",
		);
		const like = `%${escapeLike(token)}%`;
		params.push(like, like, like);
	}
	const where = clauses.length === 0 ? "1=1" : clauses.join(" OR ");
	params.push(topK);
	const results = asRows(
		beam.db
			.query(
				`SELECT * FROM memoria_facts WHERE session_id = ? AND (${where}) ORDER BY importance DESC, id DESC LIMIT ?`,
			)
			.all(...params),
	);
	return { ability: "IE", query, results };
}

function timelineRetrieve(beam: BeamMemoryState, query: string, topK: number): MemoriaRetrieveResult {
	const tokens = makeQuestionTokens(query);
	const clauses: string[] = [];
	const params: SQLQueryBindings[] = [sourceSession(beam)];
	for (const token of tokens) {
		clauses.push("(lower(description) LIKE ? ESCAPE '\\' OR date LIKE ? ESCAPE '\\')");
		const like = `%${escapeLike(token)}%`;
		params.push(like, like);
	}
	const where = clauses.length === 0 ? "1=1" : clauses.join(" OR ");
	params.push(topK);
	const results = asRows(
		beam.db
			.query(
				`SELECT * FROM memoria_timelines WHERE session_id = ? AND (${where}) ORDER BY date ASC, event_id ASC LIMIT ?`,
			)
			.all(...params),
	);
	return { ability: "TR", query, results };
}

function kgRetrieve(beam: BeamMemoryState, query: string, topK: number): MemoriaRetrieveResult {
	const tokens = makeQuestionTokens(query);
	const clauses: string[] = [];
	const params: SQLQueryBindings[] = [sourceSession(beam)];
	for (const token of tokens) {
		clauses.push(
			"(lower(subject) LIKE ? ESCAPE '\\' OR lower(predicate) LIKE ? ESCAPE '\\' OR lower(object) LIKE ? ESCAPE '\\')",
		);
		const like = `%${escapeLike(token)}%`;
		params.push(like, like, like);
	}
	const where = clauses.length === 0 ? "1=1" : clauses.join(" OR ");
	params.push(topK);
	const results = asRows(
		beam.db
			.query(
				`SELECT * FROM memoria_kg WHERE session_id = ? AND (${where}) ORDER BY confidence DESC, id DESC LIMIT ?`,
			)
			.all(...params),
	);
	return { ability: "MR", query, results };
}

export function memoriaRetrieve(
	beam: BeamMemoryState,
	query: string,
	ability: string | null = null,
	topK = 10,
): MemoriaRetrieveResult {
	const selected = ability ?? classifyAbility(query);
	if (selected === "TR" || selected === "EO") return timelineRetrieve(beam, query, topK);
	if (selected === "MR") return kgRetrieve(beam, query, topK);
	if (selected === "IE" || selected === "KU" || selected === "PF" || selected === "IF" || selected === "CR")
		return factRetrieve(beam, query, topK);
	return { ability: selected, query, results: [] };
}
export function getEpisodicStats(
	beam: BeamMemoryState,
	authorId: string | null = null,
	authorType: string | null = null,
	channelId: string | null = null,
): BeamStats {
	const clauses: string[] = [];
	const params: SQLQueryBindings[] = [];
	if (authorId) {
		clauses.push("author_id = ?");
		params.push(authorId);
	}
	if (authorType) {
		clauses.push("author_type = ?");
		params.push(authorType);
	}
	if (channelId) {
		clauses.push("channel_id = ?");
		params.push(channelId);
	}
	const where = clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`;
	const total = (
		beam.db.query(`SELECT COUNT(*) AS count FROM episodic_memory${where}`).get(...params) as {
			count: number;
		}
	).count;
	const last = beam.db
		.query(`SELECT timestamp FROM episodic_memory${where} ORDER BY timestamp DESC LIMIT 1`)
		.get(...params) as { timestamp: string | null } | null;
	return { count: total, total, last: last?.timestamp ?? null, vectors: 0, vec_type: "none" };
}
export function getMemoriaStats(beam: BeamMemoryState): BeamStats {
	const stats: Record<string, number> = Object.create(null);
	let total = 0;
	for (const table of [
		"memoria_facts",
		"memoria_timelines",
		"memoria_kg",
		"memoria_instructions",
		"memoria_preferences",
	] as const) {
		const count = (beam.db.query(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
		stats[table] = count;
		total += count;
	}
	return { count: total, ...stats };
}
function extractKeySignal(content: string, maxChars: number): string {
	const sentences = content.split(/(?<=[.!?])\s+/).filter(s => s.trim().length > 0);
	if (sentences.length === 0) return content.slice(0, maxChars);
	const scored = sentences.map((sentence, idx) => {
		const score =
			(sentence.match(/\b[A-Z][a-zA-Z0-9_-]+\b/g)?.length ?? 0) * 2 +
			(sentence.match(/\b(prefer|always|never|deadline|release|version|decided|important|must|should)\b/gi)
				?.length ?? 0);
		return { sentence, idx, score };
	});
	scored.sort((a, b) => b.score - a.score || a.idx - b.idx);
	const selected: typeof scored = [];
	let used = 0;
	for (const item of scored) {
		const next = item.sentence.trim();
		if (used + next.length + 1 > maxChars && selected.length > 0) continue;
		selected.push(item);
		used += next.length + 1;
		if (used >= maxChars) break;
	}
	selected.sort((a, b) => a.idx - b.idx);
	const text = selected.map(s => s.sentence.trim()).join(" ");
	return text.length <= maxChars ? text : `${text.slice(0, Math.max(0, maxChars - 6)).trim()} [...]`;
}

function invalidateEpisodicVectors(beam: BeamMemoryState, memoryId: string): void {
	beam.db.prepare("DELETE FROM memory_embeddings WHERE memory_id = ?").run(memoryId);
	beam.db.prepare("UPDATE episodic_memory SET binary_vector = NULL WHERE id = ?").run(memoryId);
}

export function degradeEpisodic(beam: BeamMemoryState, dryRun = false): Record<string, JsonValue> {
	const now = isoNow();
	const tier2Cutoff = cutoffIso(TIER2_DAYS, DAY_MS);
	const tier3Cutoff = cutoffIso(TIER3_DAYS, DAY_MS);
	const tier1Rows = asRows(
		beam.db
			.query(
				`SELECT id, content FROM episodic_memory WHERE tier = 1 AND created_at < ? ORDER BY created_at ASC LIMIT ?`,
			)
			.all(tier2Cutoff, DEGRADE_BATCH_SIZE),
	);
	const tier2Rows = asRows(
		beam.db
			.query(
				`SELECT id, content FROM episodic_memory WHERE tier = 2 AND created_at < ? ORDER BY created_at ASC LIMIT ?`,
			)
			.all(tier3Cutoff, Math.max(1, Math.floor(DEGRADE_BATCH_SIZE / 2))),
	);
	const result = {
		status: dryRun ? "dry_run" : "degraded",
		tier1_to_tier2: tier1Rows.length,
		tier2_to_tier3: tier2Rows.length,
	};
	if (dryRun) return result;
	for (const row of tier1Rows) {
		const id = rowValue(row, "id");
		const content = rowValue(row, "content") ?? "";
		if (!id) continue;
		const compressed = content.slice(0, 800);
		beam.db.run("SAVEPOINT degrade_episodic");
		try {
			beam.db.run("UPDATE episodic_memory SET content = ?, tier = 2, degraded_at = ? WHERE id = ?", [
				compressed,
				now,
				id,
			]);
			if (compressed !== content) invalidateEpisodicVectors(beam, id);
			beam.db.run("RELEASE degrade_episodic");
		} catch (error) {
			beam.db.run("ROLLBACK TO degrade_episodic");
			beam.db.run("RELEASE degrade_episodic");
			result.tier1_to_tier2--;
			logger.warn("mnemopi: tier-1→2 degrade failed for memory; row left at tier 1", {
				memoryId: id,
				error: errorMessage(error),
			});
		}
	}
	for (const row of tier2Rows) {
		const id = rowValue(row, "id");
		const content = rowValue(row, "content") ?? "";
		if (!id) continue;
		const compressed = content.length > TIER3_MAX_CHARS ? extractKeySignal(content, TIER3_MAX_CHARS) : content;
		beam.db.run("SAVEPOINT degrade_episodic");
		try {
			beam.db.run("UPDATE episodic_memory SET content = ?, tier = 3, degraded_at = ? WHERE id = ?", [
				compressed,
				now,
				id,
			]);
			if (compressed !== content) invalidateEpisodicVectors(beam, id);
			beam.db.run("RELEASE degrade_episodic");
		} catch (error) {
			beam.db.run("ROLLBACK TO degrade_episodic");
			beam.db.run("RELEASE degrade_episodic");
			result.tier2_to_tier3--;
			logger.warn("mnemopi: tier-2→3 degrade failed for memory; row left at tier 2", {
				memoryId: id,
				error: errorMessage(error),
			});
		}
	}
	return result;
}
export function getContaminated(beam: BeamMemoryState, limit = 50, minImportance = 0.0): Row[] {
	const rows = asRows(
		beam.db
			.query(
				`SELECT id, content, source, veracity, tier, importance, created_at, degraded_at, session_id
		 FROM episodic_memory
		 WHERE veracity IN ('inferred', 'tool', 'imported', 'unknown', 'false') AND importance >= ?
		 ORDER BY importance DESC, created_at DESC LIMIT ?`,
			)
			.all(minImportance, limit),
	);
	return rows.filter(row => CONTAMINATED_VERACITY[rowValue(row, "veracity") ?? "unknown"] === true);
}
export function health(
	beam: BeamMemoryState,
	staleThresholdHours = 24.0,
): Record<string, JsonValue | Record<string, JsonValue>> {
	const last = beam.db
		.query(`SELECT max(created_at) AS last_consolidation FROM consolidation_log WHERE items_consolidated > 0`)
		.get() as { last_consolidation: string | null } | null;
	const errors = beam.db
		.query(
			`SELECT count(*) AS err_count FROM consolidation_log
		 WHERE created_at > datetime('now', '-7 days')
		 AND ((items_consolidated = 0 AND summary_preview LIKE '%error%') OR summary_preview LIKE '%fail%')`,
		)
		.get() as { err_count: number };
	const lastTs = last?.last_consolidation ?? null;
	if (lastTs === null) {
		return {
			status: "no_data",
			last_successful_consolidation: null,
			error_count: errors.err_count,
			stale_hours: null,
			stale_threshold_hours: staleThresholdHours,
			details: { stale: true, consolidation_log_entries_checked: "last 7 days" },
			recommendation:
				"No consolidation_log entries found with items_consolidated > 0. Run sleepAllSessions() or check logs.",
		};
	}
	const staleHours = Math.round(((Date.now() - Date.parse(lastTs)) / HOUR_MS) * 100) / 100;
	const status = staleHours > staleThresholdHours ? "stale" : "healthy";
	return {
		status,
		last_successful_consolidation: lastTs,
		error_count: errors.err_count,
		stale_hours: staleHours,
		stale_threshold_hours: staleThresholdHours,
		details: { stale: status === "stale", consolidation_log_entries_checked: "last 7 days" },
		recommendation:
			status === "stale"
				? `Last successful consolidation was ${staleHours.toFixed(1)} hours ago (threshold: ${staleThresholdHours.toFixed(0)}h). Run sleepAllSessions().`
				: "Consolidation is within the healthy window.",
	};
}

function eligibleWorkingRows(beam: BeamMemoryState, sessionId: string): Row[] {
	const ttl = beam.config?.workingMemoryTtlHours ?? 24;
	const cutoff = cutoffIso(Math.floor(ttl / 2), 60 * 60 * 1000);
	return asRows(
		beam.db
			.query(
				`SELECT id, COALESCE(embed_text, content) AS content, source, timestamp, importance, metadata_json, scope, valid_until, veracity
		 FROM working_memory
		 WHERE COALESCE(session_id, 'default') = ? AND timestamp < ? AND consolidated_at IS NULL
		 ORDER BY timestamp ASC LIMIT ?`,
			)
			.all(sessionId, cutoff, SLEEP_BATCH_SIZE),
	);
}

export function sleep(beam: BeamMemoryState, dryRun = false): SleepResult {
	let rows = eligibleWorkingRows(beam, sourceSession(beam));
	if (rows.length === 0)
		return { dry_run: dryRun, status: "no_op", message: "No old working memories to consolidate" };
	if (!dryRun) {
		const claimTs = isoNow();
		const ids = rows.map(row => rowValue(row, "id")).filter((id): id is string => id !== null);
		const placeholders = sqlPlaceholders(ids.length);
		beam.db.run(
			`UPDATE working_memory SET consolidated_at = ? WHERE id IN (${placeholders}) AND consolidated_at IS NULL`,
			[claimTs, ...ids],
		);
		const claimed = new Set(
			asRows(
				beam.db
					.query(`SELECT id FROM working_memory WHERE id IN (${placeholders}) AND consolidated_at = ?`)
					.all(...ids, claimTs),
			).map(row => rowValue(row, "id")),
		);
		if (claimed.size === 0)
			return {
				dry_run: false,
				status: "no_op",
				message: "All eligible rows claimed by concurrent sleep",
			};
		rows = rows.filter(row => claimed.has(rowValue(row, "id")));
	}

	const grouped = new Map<string, Row[]>();
	for (const row of rows) {
		const source = rowValue(row, "source") ?? "unknown";
		const group = grouped.get(source);
		if (group) group.push(row);
		else grouped.set(source, [row]);
	}

	const consolidatedIds: string[] = [];
	let summariesCreated = 0;
	for (const [source, items] of grouped) {
		for (const chunk of splitSleepItems(beam, source, items)) {
			const ids = chunk.items.map(item => rowValue(item, "id")).filter((id): id is string => id !== null);
			let scope = "session";
			let validUntil: string | null = null;
			for (const item of chunk.items) {
				if (rowValue(item, "scope") === "global") scope = "global";
				const itemValidUntil = rowValue(item, "valid_until");
				if (itemValidUntil && (validUntil === null || itemValidUntil < validUntil)) validUntil = itemValidUntil;
			}
			const sleepSummary = buildSleepSummary(beam, source, chunk);
			const metadata: Metadata = { original_count: chunk.items.length, source, llm_used: false };
			if (sleepSummary.truncated) {
				metadata.truncated = true;
				metadata.original_chars = sleepSummary.originalChars;
				metadata.max_chars = sleepSummary.maxChars;
			}
			const summary = sleepSummary.summary;
			if (!dryRun) {
				consolidateToEpisodic(beam, summary, ids, "sleep_consolidation", 0.6, {
					scope,
					validUntil,
					veracity: aggregateEpisodicVeracity(chunk.items.map(item => rowValue(item, "veracity") ?? "unknown")),
					metadata,
				});
			}
			for (let ii = 0; ii < ids.length; ii++) consolidatedIds.push(ids[ii]!);
			summariesCreated++;
		}
	}
	if (!dryRun) {
		beam.db.run(
			`INSERT INTO consolidation_log (session_id, items_consolidated, summary_preview, created_at) VALUES (?, ?, ?, ?)`,
			[
				sourceSession(beam),
				consolidatedIds.length,
				`${summariesCreated} summaries (aaak) from ${consolidatedIds.length} items`,
				isoNow(),
			],
		);
	}
	const degradation = degradeEpisodic(beam, dryRun);
	return {
		dry_run: dryRun,
		status: dryRun ? "dry_run" : "consolidated",
		items_consolidated: consolidatedIds.length,
		summaries_created: summariesCreated,
		conflicts_resolved: 0,
		llm_used: 0,
		method: "aaak",
		consolidated_ids: consolidatedIds,
		degradation,
	};
}

export function sleepAllSessions(beam: BeamMemoryState, dryRun = false): SleepResult {
	const ttl = beam.config?.workingMemoryTtlHours ?? 24;
	const cutoff = cutoffIso(Math.floor(ttl / 2), 60 * 60 * 1000);
	const sessions = asRows(
		beam.db
			.query(
				`SELECT session_id, COUNT(*) AS eligible FROM working_memory
		 WHERE timestamp < ? AND consolidated_at IS NULL GROUP BY session_id ORDER BY MIN(timestamp) ASC`,
			)
			.all(cutoff),
	);
	if (sessions.length === 0) {
		return {
			dry_run: dryRun,
			status: "no_op",
			message: "No old working memories to consolidate",
			sessions_scanned: 0,
			sessions_consolidated: 0,
			items_consolidated: 0,
			summaries_created: 0,
			llm_used: 0,
			errors: 0,
			session_results: [],
		};
	}
	const originalSession = beam.sessionId;
	const results: Row[] = [];
	let items = 0;
	let summaries = 0;
	let consolidated = 0;
	for (const row of sessions) {
		const sessionId = rowValue(row, "session_id") ?? "default";
		const scoped = Object.create(Object.getPrototypeOf(beam)) as BeamMemoryState;
		Object.assign(scoped, beam, { sessionId, channelId: sessionId });
		const result = sleep(scoped, dryRun) as Row;
		result.session_id = sessionId;
		result.eligible = row.eligible;
		results.push(result);
		if (result.status === "consolidated" || result.status === "dry_run") consolidated++;
		items += Number(result.items_consolidated ?? 0);
		summaries += Number(result.summaries_created ?? 0);
	}
	const degradation = degradeEpisodic(beam, dryRun);
	return {
		dry_run: dryRun,
		status: dryRun ? "dry_run" : items > 0 ? "consolidated" : "no_op",
		sessions_scanned: sessions.length,
		sessions_consolidated: consolidated,
		items_consolidated: items,
		summaries_created: summaries,
		llm_used: 0,
		errors: 0,
		error_details: [],
		session_results: results,
		degradation,
		original_session: originalSession,
	};
}
export function getConsolidationLog(beam: BeamMemoryState, limit = 10): Row[] {
	return asRows(
		beam.db
			.query(
				`SELECT id, session_id, items_consolidated, summary_preview, created_at
		 FROM consolidation_log WHERE session_id = ? ORDER BY created_at DESC LIMIT ?`,
			)
			.all(sourceSession(beam), limit),
	);
}
