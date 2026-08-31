import type { ConventionalAnalysis } from "../../commit/types";

/**
 * The outcome of validating one part of a conventional-commit message.
 *
 * Named for what it validates. `PluginSettingValidationResult`
 * (`extensibility/plugins/manager.ts`) was also called `ValidationResult` and is
 * NOT the same shape: it reports a single optional `error`, this one reports every
 * `errors` it found, and a caller that read the wrong one silently saw no errors at
 * all. `JsonSchemaValidationResult` is a third, already correctly named.
 */
export interface CommitValidationResult {
	valid: boolean;
	errors: string[];
}

/**
 * The longest a commit summary line may be.
 *
 * Seventy-two characters is the conventional git limit: it leaves room for the four-space
 * indent `git log` adds without wrapping in an eighty-column terminal.
 *
 * Declared here, in the module that ENFORCES it, because three modules need it and each
 * used to spell it out. `pipeline.ts` held a private `SUMMARY_MAX_CHARS = 72` and passed
 * it to `validateSummary` below, while `agentic/validation.ts` exported its own copy of
 * the same number for the agentic path and its tool. A generator held to one limit and a
 * validator enforcing another produces summaries that are rejected for being the length
 * they were asked to be.
 */
export const SUMMARY_MAX_CHARS = 72;

export function validateSummary(summary: string, maxChars: number): CommitValidationResult {
	const errors: string[] = [];
	if (!summary.trim()) {
		errors.push("Summary is empty");
	}
	if (summary.length > maxChars) {
		errors.push(`Summary exceeds ${maxChars} characters`);
	}
	if (summary.trimEnd().endsWith(".")) {
		errors.push("Summary must not end with a period");
	}
	if (summary.includes("\n")) {
		errors.push("Summary must be a single line");
	}
	return { valid: errors.length === 0, errors };
}

export function validateScope(scope: string | null): CommitValidationResult {
	if (!scope) return { valid: true, errors: [] };
	const errors: string[] = [];
	const segments = scope.split("/");
	if (segments.length > 2) {
		errors.push("Scope may contain at most two segments");
	}
	for (const segment of segments) {
		if (!segment) {
			errors.push("Scope segments cannot be empty");
			continue;
		}
		if (segment !== segment.toLowerCase()) {
			errors.push("Scope must be lowercase");
		}
		if (!/^[a-z0-9][a-z0-9-_]*$/.test(segment)) {
			errors.push(`Scope segment has invalid characters: ${segment}`);
		}
	}
	return { valid: errors.length === 0, errors };
}

export function validateAnalysis(analysis: ConventionalAnalysis): CommitValidationResult {
	const errors: string[] = [];
	const scopeResult = validateScope(analysis.scope);
	if (!scopeResult.valid) {
		errors.push(...scopeResult.errors);
	}
	for (const detail of analysis.details) {
		if (!detail.text.trim()) {
			errors.push("Detail text is empty");
			continue;
		}
		if (!detail.text.trim().endsWith(".")) {
			errors.push(`Detail must end with a period: ${detail.text}`);
		}
		if (detail.text.length > 120) {
			errors.push(`Detail exceeds 120 characters: ${detail.text}`);
		}
	}
	return { valid: errors.length === 0, errors };
}
