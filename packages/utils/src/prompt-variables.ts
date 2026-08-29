import { levenshteinDistance } from "./levenshtein";
import type { AnalyzeOptions, TemplateVariable } from "./prompt-variables-helpers";

export type { TemplateVariable, TemplateVariableUse } from "./prompt-variables-helpers";

import { analyzeTemplate, isTruthyGuard } from "./prompt-variables-helpers";

export type { TemplateVariables } from "./prompt-variables-helpers";
export { analyzeTemplate };

export class MissingTemplateVariableError extends Error {
	readonly missing: readonly string[];

	constructor(missing: readonly TemplateVariable[], available: readonly string[], label?: string) {
		const lines = missing.map(variable => {
			const suggestion = closestKey(variable.name, available);
			const paths = variable.paths.length > 1 ? ` (read as ${variable.paths.join(", ")})` : "";
			const hint = suggestion ? ` — did you mean \`${suggestion}\`?` : "";
			return `  \`${variable.name}\`${paths}${hint}`;
		});
		const where = label ? ` in ${label}` : "";
		super(
			`Prompt template${where} interpolates ${missing.length} variable${missing.length === 1 ? "" : "s"} the ` +
				`context does not provide, which would render an empty hole:\n${lines.join("\n")}\n` +
				`Context provides: ${available.length > 0 ? available.map(k => `\`${k}\``).join(", ") : "(nothing)"}.\n` +
				`Fix the caller to pass it, or guard the reference in the template (\`{{#if x}}{{x}}{{/if}}\`) ` +
				`if it is genuinely optional.`,
		);
		this.name = "MissingTemplateVariableError";
		this.missing = missing.map(variable => variable.name);
	}
}

function closestKey(name: string, available: readonly string[]): string | undefined {
	let best: string | undefined;
	let bestDistance = Number.POSITIVE_INFINITY;
	const limit = Math.max(1, Math.floor(name.length / 3));
	for (const key of available) {
		const distance = levenshteinDistance(name.toLowerCase(), key.toLowerCase());
		if (distance < bestDistance && distance <= limit) {
			best = key;
			bestDistance = distance;
		}
	}
	return best;
}

export function findMissingTemplateVariables(
	template: string,
	context: Record<string, unknown>,
	options: AnalyzeOptions = {},
): readonly TemplateVariable[] {
	const { required } = analyzeTemplate(template, options);
	return required.filter(variable => {
		const value = context[variable.name];
		if (value !== undefined && value !== null) return false;
		return variable.requiredWhen.some(guards => guards.every(guard => isTruthyGuard(context[guard])));
	});
}

export function assertTemplateContext(
	template: string,
	context: Record<string, unknown>,
	label?: string,
	options: AnalyzeOptions = {},
): void {
	const missing = findMissingTemplateVariables(template, context, options);
	if (missing.length > 0) throw new MissingTemplateVariableError(missing, Object.keys(context).sort(), label);
}
