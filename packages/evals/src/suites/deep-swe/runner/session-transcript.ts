/**
 * Parsing and aggregation of session transcripts, prompt telemetry, and cache invalidation records.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
	collectEmittedText,
	type EncodeHeadroom,
	encodeHeadroom,
	type SessionUsage,
	systemPromptTeachesArgot,
	tallyUsage,
} from "../aggregate";

export interface ParsedSessionUsage {
	usage: SessionUsage;
	resolvedModel: string | null;
	preambleTaught: boolean | null;
	argotHandlesLoaded: number | null;
	handlesTaughtInPrompt: boolean | null;
	promptCacheInvalidations: string[] | null;
	headroom: EncodeHeadroom | null;
}

export function parseSessionsUsage(trialDir: string): ParsedSessionUsage | null {
	const sessionsDir = path.join(trialDir, "agent", "sessions");
	if (!fs.existsSync(sessionsDir)) return null;
	const files = fs.readdirSync(sessionsDir).filter(f => f.endsWith(".jsonl"));
	if (files.length === 0) return null;

	const messages: Array<Record<string, unknown>> = [];
	let resolvedModel: string | null = null;
	let preambleTaught: boolean | null = null;
	let argotHandlesLoaded: number | null = null;
	let handlesTaughtInPrompt: boolean | null = null;
	const promptCacheInvalidations: string[] = [];
	let vocabEntries: Record<string, string> | null = null;

	for (const file of files) {
		const filePath = path.join(sessionsDir, file);
		const content = fs.readFileSync(filePath, "utf8");
		for (const line of content.split("\n")) {
			if (!line.trim()) continue;
			try {
				const parsed = JSON.parse(line);
				if (!parsed || typeof parsed !== "object") continue;
				const entry = parsed as Record<string, unknown>;

				if (entry.message && typeof entry.message === "object") {
					messages.push(entry.message as Record<string, unknown>);
				}
				if (entry.type === "model_change" && typeof entry.model === "string") {
					resolvedModel =
						resolvedModel === null || resolvedModel === entry.model
							? entry.model
							: `<multiple:${resolvedModel},${entry.model}>`;
				}
				if (entry.type === "session_init" && typeof entry.systemPrompt === "string") {
					preambleTaught = preambleTaught === true || systemPromptTeachesArgot(entry.systemPrompt);
				}
				if (entry.type === "custom_message" && entry.customType === "argot_taught") {
					const details = entry.details;
					if (details && typeof details === "object" && "inPrompt" in details) {
						handlesTaughtInPrompt = handlesTaughtInPrompt === true || details.inPrompt === true;
					}
				}
				if (entry.type === "custom_message" && entry.customType === "prompt_cache_invalidated") {
					const details = entry.details;
					if (
						details &&
						typeof details === "object" &&
						"reason" in details &&
						typeof details.reason === "string"
					) {
						promptCacheInvalidations.push(details.reason);
					}
				}
				if (entry.type === "custom_message" && entry.customType === "argot_armed") {
					const details = entry.details;
					if (details && typeof details === "object") {
						if ("handles" in details && typeof details.handles === "number" && Number.isFinite(details.handles)) {
							argotHandlesLoaded = Math.max(argotHandlesLoaded ?? 0, details.handles);
						}
						if ("entries" in details && details.entries && typeof details.entries === "object") {
							const table: Record<string, string> = {};
							for (const [name, expansion] of Object.entries(details.entries as Record<string, unknown>)) {
								if (typeof expansion === "string") table[name] = expansion;
							}
							if (vocabEntries === null || Object.keys(table).length >= Object.keys(vocabEntries).length) {
								vocabEntries = table;
							}
						}
					}
				}
			} catch {
				// Ignore truncated line
			}
		}
	}

	const headroom = vocabEntries === null ? null : encodeHeadroom(collectEmittedText(messages), vocabEntries);
	return {
		usage: tallyUsage(messages),
		resolvedModel,
		preambleTaught,
		argotHandlesLoaded,
		handlesTaughtInPrompt,
		headroom,
		promptCacheInvalidations: promptCacheInvalidations.length > 0 ? promptCacheInvalidations : null,
	};
}
