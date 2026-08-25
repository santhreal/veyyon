import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@veyyon/agent-core";
import type { AssistantMessage, Usage } from "@veyyon/ai";
import type { Rule } from "@veyyon/coding-agent/capability/rule";
import {
	type ParsedGeneratedRule,
	parseGeneratedRule,
	ruleMatchesAssistantHistory,
	sanitizeRuleName,
	validateParsedRuleAgainstAssistantHistory,
} from "@veyyon/coding-agent/modes/controllers/omfg-rule";

const usage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function createAssistantMessage(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage,
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function mustParse(text: string): ParsedGeneratedRule {
	const result = parseGeneratedRule(text);
	if ("error" in result) {
		throw new Error(result.error);
	}
	return result;
}

function ruleJson(fields: {
	name: string;
	description?: string;
	condition?: string | string[];
	astCondition?: string | string[];
	scope?: string | string[];
	interruptMode?: string;
	pathScope?: string;
	repeatMode?: string;
	repeatGap?: number;
	repeatCompactions?: number;
	warmupMatches?: number;
	body?: string;
}): string {
	return JSON.stringify({
		description: "Generated rule",
		body: "Use the safer pattern.",
		...fields,
	});
}

describe("omfg rule parsing", () => {
	it("extracts JSON and assembles markdown with nested fences in the body", () => {
		const result = mustParse(
			ruleJson({
				name: "TypeScript Any Guard",
				description: "No any",
				condition: ": any|as any",
				scope: ["tool:edit(*.ts)", "tool:write(*.ts)"],
				body: "Use `unknown` instead.\n\n```typescript\nconst value: unknown = input;\n```",
			}),
		);

		expect(result.rule.name).toBe("typescript-any-guard");
		expect(result.rule.condition).toEqual([": any|as any"]);
		expect(result.rule.scope).toEqual(["tool:edit(*.ts)", "tool:write(*.ts)"]);
		expect(result.fileContent).toStartWith("---");
		expect(result.fileContent).toContain("```typescript");
	});

	it("accepts a fenced JSON object", () => {
		const result = mustParse(
			`Here:\n\`\`\`json\n${ruleJson({ name: "no-handwave", condition: "cut corners", scope: "text" })}\n\`\`\``,
		);

		expect(result.rule.name).toBe("no-handwave");
		expect(result.rule.scope).toEqual(["text"]);
	});

	it("reports malformed model output", () => {
		expect(parseGeneratedRule("no object")).toEqual({ error: "Missing generated rule JSON object" });
		expect(parseGeneratedRule(ruleJson({ name: "", condition: "x", scope: "text" }))).toEqual({
			error: "Generated rule JSON must include a non-empty name",
		});
		expect(parseGeneratedRule(ruleJson({ name: "no-condition", scope: "text" }))).toEqual({
			error: "Generated rule JSON must include at least one condition or astCondition",
		});
		expect(parseGeneratedRule(ruleJson({ name: "no-scope", condition: "x" }))).toEqual({
			error: "Generated rule JSON must include at least one scope",
		});
		const invalidRegex = parseGeneratedRule(ruleJson({ name: "invalid-regex", condition: "[", scope: "text" }));
		expect("error" in invalidRegex ? invalidRegex.error : "").toContain("Invalid condition regex");
	});

	it("sanitizes generated names to slugs", () => {
		expect(sanitizeRuleName("  Caps & Spaces!!  ")).toBe("caps-spaces");
		expect(sanitizeRuleName("already_ok-123")).toBe("already_ok-123");
		expect(sanitizeRuleName("***")).toBe("");
	});
});

describe("ruleMatchesAssistantHistory", () => {
	it("matches edit tool arguments under a scoped TypeScript path", async () => {
		const { rule } = mustParse(ruleJson({ name: "ts-no-any", condition: ": any|as any", scope: "tool:edit(*.ts)" }));
		const messages: AgentMessage[] = [
			createAssistantMessage([
				{
					type: "toolCall",
					id: "call-1",
					name: "edit",
					arguments: { path: "src/example.ts", content: "const value: any = input;" },
				},
			]),
		];

		expect(await ruleMatchesAssistantHistory(rule, messages)).toBe(true);
	});

	it("matches assistant prose in text scope", async () => {
		const { rule } = mustParse(ruleJson({ name: "no-handwave", condition: "cut corners", scope: "text" }));
		const messages: AgentMessage[] = [
			createAssistantMessage([{ type: "text", text: "I should not cut corners here." }]),
		];

		expect(await ruleMatchesAssistantHistory(rule, messages)).toBe(true);
	});

	it("returns false when the pattern is absent", async () => {
		const { rule } = mustParse(ruleJson({ name: "absent", condition: "needle", scope: "text" }));
		const messages: AgentMessage[] = [createAssistantMessage([{ type: "text", text: "Only hay here." }])];

		expect(await ruleMatchesAssistantHistory(rule, messages)).toBe(false);
	});

	it("returns false when the rule cannot be registered", async () => {
		const { rule } = mustParse(ruleJson({ name: "base", condition: "needle", scope: "text" }));
		const invalidRule: Rule = { ...rule, name: "no-condition", condition: undefined };

		expect(
			await ruleMatchesAssistantHistory(invalidRule, [createAssistantMessage([{ type: "text", text: "needle" }])]),
		).toBe(false);
	});

	it("repairs one layer of double-escaped regex condition while parsing", async () => {
		const candidate = mustParse(
			ruleJson({
				name: "ruby-no-eval",
				condition: "\\\\beval\\\\s*\\\\(",
				scope: "tool:write(*.rb)",
			}),
		);
		const messages: AgentMessage[] = [
			createAssistantMessage([
				{
					type: "toolCall",
					id: "call-1",
					name: "write",
					arguments: { path: "/tmp/bad_quality.rb", content: 'eval("@last_result = #{result}")' },
				},
			]),
		];

		expect(candidate.rule.condition).toEqual(["\\beval\\s*\\("]);
		expect(await ruleMatchesAssistantHistory(candidate.rule, messages)).toBe(true);
		const validation = await validateParsedRuleAgainstAssistantHistory(candidate, messages);
		expect(validation.repairedCondition).toBe(false);
		expect(validation.validation.matched).toBe(true);
	});
});

describe("omfg extended TTSR fields", () => {
	it("writes optional fields into frontmatter and the parsed rule", () => {
		const result = mustParse(
			ruleJson({
				name: "ts-no-as-any",
				condition: "as any",
				astCondition: ["$VALUE as any"],
				scope: "tool:edit(*.ts)",
				interruptMode: "tool-only",
				pathScope: "outside-cwd",
				repeatMode: "after-gap",
				repeatGap: 5,
				repeatCompactions: 3,
				warmupMatches: 2,
			}),
		);

		expect(result.rule.astCondition).toEqual(["$VALUE as any"]);
		expect(result.rule.interruptMode).toBe("tool-only");
		expect(result.rule.pathScope).toBe("outside-cwd");
		expect(result.rule.repeatMode).toBe("after-gap");
		expect(result.rule.repeatGap).toBe(5);
		expect(result.rule.repeatCompactions).toBe(3);
		expect(result.rule.warmupMatches).toBe(2);
		expect(result.fileContent).toContain('astCondition: "$VALUE as any"');
		expect(result.fileContent).toContain("interruptMode: tool-only");
		expect(result.fileContent).toContain("pathScope: outside-cwd");
		expect(result.fileContent).toContain("repeatMode: after-gap");
		expect(result.fileContent).toContain("repeatGap: 5");
		expect(result.fileContent).toContain("repeatCompactions: 3");
		expect(result.fileContent).toContain("warmupMatches: 2");
	});

	it("keeps every optional field out of frontmatter the model left unset", () => {
		const result = mustParse(ruleJson({ name: "plain", condition: "needle", scope: "text" }));

		for (const key of [
			"astCondition:",
			"interruptMode:",
			"pathScope:",
			"repeatMode:",
			"repeatGap:",
			"repeatCompactions:",
			"warmupMatches:",
		]) {
			expect(result.fileContent).not.toContain(key);
			expect(result.rule[key as keyof typeof result.rule]).toBeUndefined();
		}
	});

	it("accepts an ast-only rule without a regex condition", () => {
		const result = mustParse(
			ruleJson({ name: "rb-eval-shape", astCondition: "eval($X)", scope: "tool:write(*.rb)" }),
		);

		expect(result.rule.condition).toBeUndefined();
		expect(result.rule.astCondition).toEqual(["eval($X)"]);
	});

	it("rejects invalid enum and integer fields loudly instead of dropping them", () => {
		expect(
			parseGeneratedRule(ruleJson({ name: "bad-mode", condition: "x", scope: "text", interruptMode: "sometimes" })),
		).toEqual({
			error: 'Generated rule JSON field "interruptMode" must be one of "never", "prose-only", "tool-only", "always"',
		});
		expect(
			parseGeneratedRule(ruleJson({ name: "bad-path-scope", condition: "x", scope: "text", pathScope: "anywhere" })),
		).toEqual({
			error: 'Generated rule JSON field "pathScope" must be one of "outside-cwd", "inside-cwd"',
		});
		expect(
			parseGeneratedRule(ruleJson({ name: "bad-repeat", condition: "x", scope: "text", repeatMode: "every-turn" })),
		).toEqual({
			error: 'Generated rule JSON field "repeatMode" must be one of "once", "after-gap", "per-compact"',
		});
		expect(parseGeneratedRule(ruleJson({ name: "bad-gap", condition: "x", scope: "text", repeatGap: -1 }))).toEqual({
			error: 'Generated rule JSON field "repeatGap" must be an integer >= 0',
		});
		expect(
			parseGeneratedRule(ruleJson({ name: "bad-warmup", condition: "x", scope: "text", warmupMatches: 1.5 })),
		).toEqual({
			error: 'Generated rule JSON field "warmupMatches" must be an integer >= 1',
		});
	});

	it("matches ast conditions structurally against historical tool source under runtime gates", async () => {
		const { rule } = mustParse(
			ruleJson({
				name: "ts-as-any-shape",
				condition: "never-happens-zzz",
				astCondition: "$VALUE as any",
				scope: "tool:edit(*.ts)",
			}),
		);
		const messages: AgentMessage[] = [
			createAssistantMessage([
				{
					type: "toolCall",
					id: "call-1",
					name: "edit",
					arguments: { path: "src/example.ts", edits: [{ newString: "const speed = input as any;" }] },
				},
			]),
		];

		expect(await ruleMatchesAssistantHistory(rule, messages)).toBe(true);
	});

	it("does not match ast conditions on a language the scope never reaches", async () => {
		const { rule } = mustParse(
			ruleJson({
				name: "ts-as-any-shape-narrow",
				condition: "never-happens-zzz",
				astCondition: "$VALUE as any",
				scope: "tool:edit(*.go)",
			}),
		);
		const messages: AgentMessage[] = [
			createAssistantMessage([
				{
					type: "toolCall",
					id: "call-1",
					name: "edit",
					arguments: { path: "src/example.ts", edits: [{ newString: "const speed = input as any;" }] },
				},
			]),
		];

		expect(await ruleMatchesAssistantHistory(rule, messages)).toBe(false);
	});
});
