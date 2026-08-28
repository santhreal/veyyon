import { type BashInterceptorRule, DEFAULT_BASH_INTERCEPTOR_RULES } from "../config/settings-schema";

export interface InterceptionResult {
	block: boolean;
	message?: string;
	suggestedTool?: string;
}

function compileRules(rules: BashInterceptorRule[]): Array<{ rule: BashInterceptorRule; regex: RegExp }> {
	const compiled: Array<{ rule: BashInterceptorRule; regex: RegExp }> = [];
	for (const rule of rules) {
		const flags = rule.flags ?? "";
		try {
			compiled.push({ rule, regex: new RegExp(rule.pattern, flags) });
		} catch {}
	}
	return compiled;
}

export function checkBashInterception(
	command: string,
	availableTools: string[],
	rules: BashInterceptorRule[] = DEFAULT_BASH_INTERCEPTOR_RULES,
): InterceptionResult {
	const normalizedCommand = command.trim();
	const compiled = compileRules(rules);

	for (const { rule, regex } of compiled) {
		if (!availableTools.includes(rule.tool)) {
			continue;
		}

		if (regex.test(normalizedCommand)) {
			return {
				block: true,
				message: `Blocked: ${rule.message}\n\nOriginal command: ${command}`,
				suggestedTool: rule.tool,
			};
		}
	}

	return { block: false };
}
