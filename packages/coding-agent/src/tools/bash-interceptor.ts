/**
 * Bash intent interceptor - redirects common shell patterns to proper tools.
 *
 * When an LLM calls bash with patterns like `grep`, `cat`, `find`, etc.,
 * this interceptor provides helpful error messages directing them to use
 * the specialized tools instead.
 */
import { type BashInterceptorRule, DEFAULT_BASH_INTERCEPTOR_RULES } from "../config/settings-schema";

const UNIFIED_SEARCH_REDIRECTS: Record<string, string> = {
	glob: 'Use `search` with `purpose: "locate"` instead of find/fd.',
	grep: 'Use `search` with `purpose: "match"` instead of grep/rg.',
};

export interface InterceptionResult {
	/** If true, the bash command should be blocked */
	block: boolean;
	/** Error message to return instead of executing */
	message?: string;
	/** Suggested tool to use instead */
	suggestedTool?: string;
}

/**
 * Compile bash interceptor rules into regexes, skipping invalid patterns.
 */
function compileRules(rules: BashInterceptorRule[]): Array<{ rule: BashInterceptorRule; regex: RegExp }> {
	const compiled: Array<{ rule: BashInterceptorRule; regex: RegExp }> = [];
	for (const rule of rules) {
		const flags = rule.flags ?? "";
		try {
			compiled.push({ rule, regex: new RegExp(rule.pattern, flags) });
		} catch {
			// Skip invalid regex patterns
		}
	}
	return compiled;
}

/**
 * Check if a bash command should be intercepted.
 *
 * @param command The bash command to check
 * @param availableTools Set of tool names that are available
 * @returns InterceptionResult indicating if the command should be blocked
 */
export function checkBashInterception(
	command: string,
	availableTools: string[],
	rules: BashInterceptorRule[] = DEFAULT_BASH_INTERCEPTOR_RULES,
): InterceptionResult {
	// Normalize command for pattern matching
	const normalizedCommand = command.trim();
	const compiled = compileRules(rules);

	for (const { rule, regex } of compiled) {
		let suggestedTool = rule.tool;
		let message = rule.message;
		if (!availableTools.includes(suggestedTool)) {
			const unifiedMessage = availableTools.includes("search") ? UNIFIED_SEARCH_REDIRECTS[suggestedTool] : undefined;
			if (unifiedMessage === undefined) continue;
			suggestedTool = "search";
			message = unifiedMessage;
		}

		if (regex.test(normalizedCommand)) {
			return {
				block: true,
				message: `Blocked: ${message}\n\nOriginal command: ${command}`,
				suggestedTool,
			};
		}
	}

	return { block: false };
}
