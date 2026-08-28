import type { AssistantMessage, ToolCall } from "@veyyon/ai";
import type { ChangelogCategory, ConventionalAnalysis, ConventionalDetail } from "../types";

export function extractToolCall(message: AssistantMessage, name: string): ToolCall | undefined {
	return message.content.find(content => content.type === "toolCall" && content.name === name) as ToolCall | undefined;
}

export function extractTextContent(message: AssistantMessage): string {
	return message.content
		.filter(content => content.type === "text")
		.map(content => content.text)
		.join("")
		.trim();
}

/** Every balanced `{...}` run in `text`, in order, ignoring braces inside JSON strings. A greedy match from the first brace to the last swallows the prose */
function* balancedObjectsIn(text: string): Generator<string> {
	for (let start = text.indexOf("{"); start !== -1; start = text.indexOf("{", start + 1)) {
		let depth = 0;
		let inString = false;
		let escaped = false;
		for (let i = start; i < text.length; i++) {
			const ch = text[i];
			if (escaped) {
				escaped = false;
				continue;
			}
			if (inString && ch === "\\") {
				escaped = true;
				continue;
			}
			if (ch === '"') {
				inString = !inString;
				continue;
			}
			if (inString) continue;
			if (ch === "{") depth++;
			else if (ch === "}" && --depth === 0) {
				yield text.slice(start, i + 1);
				break;
			}
		}
	}
}

/** The first JSON object in `text`, whatever surrounds it. A model asked for JSON answers with prose around it, a fenced block, or a */
export function parseJsonPayload<T>(text: string, isPayload: (value: unknown) => value is T): T;
export function parseJsonPayload(text: string): unknown;
export function parseJsonPayload(text: string, isPayload?: (value: unknown) => boolean): unknown {
	let sawJson = false;
	for (const candidate of balancedObjectsIn(text.trim())) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(candidate) as unknown;
		} catch {
			// Prose contains brace runs that are not JSON; keep looking.
			continue;
		}
		sawJson = true;
		// With a shape to match, a model that reasons in JSON before answering no
		// longer decides the result: the scan walks past an object of the wrong
		// shape instead of returning it and failing somewhere further in.
		if (isPayload === undefined || isPayload(parsed)) return parsed;
	}
	throw new Error(sawJson ? "No JSON payload of the expected shape in response" : "No JSON payload found in response");
}

export function normalizeAnalysis(parsed: {
	type: ConventionalAnalysis["type"];
	scope: string | null;
	details: Array<{ text: string; changelog_category?: ChangelogCategory; user_visible?: boolean }>;
	issue_refs: string[];
}): ConventionalAnalysis {
	return {
		type: parsed.type,
		scope: parsed.scope?.trim() || null,
		// Detail shaping has a single owner in normalizeDetails; do not re-inline
		// the trim / user_visible->changelogCategory gate here or the two copies
		// can drift.
		details: normalizeDetails(parsed.details),
		issueRefs: parsed.issue_refs ?? [],
	};
}

export function normalizeDetails(
	details: Array<{
		text: string;
		changelog_category?: ConventionalDetail["changelogCategory"];
		user_visible?: boolean;
	}>,
): ConventionalDetail[] {
	return details.map(detail => ({
		text: detail.text.trim(),
		changelogCategory: detail.user_visible ? detail.changelog_category : undefined,
		userVisible: detail.user_visible ?? false,
	}));
}
