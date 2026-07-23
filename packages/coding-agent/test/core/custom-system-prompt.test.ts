import { describe, expect, it } from "bun:test";
import { prompt } from "@veyyon/utils";
import "../../src/config/prompt-templates";
import customSystemPromptTemplate from "../../src/prompts/system/custom-system-prompt.md" with { type: "text" };

/**
 * Gate-parity for the custom system prompt template.
 *
 * WHY THIS EXISTS: when a user supplies a custom system prompt, veyyon renders
 * this wrapper INSTEAD of the default template. It gates the same capability
 * scaffolding (skills, rules, context files, secret redaction) behind
 * `{{#if <field>}}` branches. A branch dropped by a hand edit renders that
 * capability dead for every custom-prompt session with no other test failure,
 * the same silent-drop class the default-template parity harness guards. The
 * `secretsEnabled` gate is security-relevant: dropping it removes the redaction
 * explainer, so a custom-prompt agent could treat `#XXXX#` tokens as errors.
 *
 * Each test renders the template directly and asserts a real anchor plus the
 * interpolated value, so both the branch and its content are pinned.
 */

/** Render the custom template with the always-present `customPrompt` plus overrides. */
function renderCustom(overrides: Record<string, unknown> = {}): string {
	return prompt.render(customSystemPromptTemplate, { customPrompt: "USER SUPPLIED PROMPT", ...overrides });
}

describe("custom system prompt: always-rendered core", () => {
	it("always renders the user's custom prompt body", () => {
		expect(renderCustom()).toContain("USER SUPPLIED PROMPT");
	});
});

describe("custom system prompt: gate parity", () => {
	it("systemPromptCustomization gate toggles the prepended customization block", () => {
		const on = renderCustom({ systemPromptCustomization: "CUSTOMIZATION-PREAMBLE" });
		expect(on).toContain("CUSTOMIZATION-PREAMBLE");
		expect(renderCustom({})).not.toContain("CUSTOMIZATION-PREAMBLE");
	});

	it("appendPrompt gate toggles the appended block", () => {
		const on = renderCustom({ appendPrompt: "APPENDED-INSTRUCTIONS" });
		expect(on).toContain("APPENDED-INSTRUCTIONS");
		expect(renderCustom({})).not.toContain("APPENDED-INSTRUCTIONS");
	});

	it("contextFiles gate toggles the <project> context block and renders each file path/content", () => {
		const on = renderCustom({ contextFiles: [{ path: "/proj/a.ts", content: "CTX-FILE-BODY" }] });
		expect(on).toContain("<project>");
		expect(on).toContain('<file path="/proj/a.ts">');
		expect(on).toContain("CTX-FILE-BODY");
		expect(renderCustom({ contextFiles: [] })).not.toContain("<project>");
	});

	it("skills gate toggles the <skills> block and renders each skill name/description", () => {
		const on = renderCustom({ skills: [{ name: "s1", description: "skill one desc" }] });
		expect(on).toContain("<skills>");
		expect(on).toContain('<skill name="s1">');
		expect(on).toContain("skill one desc");
		expect(renderCustom({ skills: [] })).not.toContain("<skills>");
	});

	it("alwaysApplyRules gate toggles the generic-rule content", () => {
		const on = renderCustom({ alwaysApplyRules: [{ name: "g1", content: "GENERIC-RULE-BODY", path: "/g1" }] });
		expect(on).toContain("GENERIC-RULE-BODY");
		expect(renderCustom({ alwaysApplyRules: [] })).not.toContain("GENERIC-RULE-BODY");
	});

	it("rules gate toggles the <rules> block and renders each rule name/description", () => {
		const on = renderCustom({ rules: [{ name: "r1", description: "rule one desc", globs: [] }] });
		expect(on).toContain("<rules>");
		expect(on).toContain('<rule name="r1">');
		expect(on).toContain("rule one desc");
		expect(renderCustom({ rules: [] })).not.toContain("<rules>");
	});

	it("globs gate (nested in rules) toggles the <glob> entries", () => {
		const withGlobs = renderCustom({ rules: [{ name: "r1", description: "d", globs: ["*.ts"] }] });
		expect(withGlobs).toContain("<glob>*.ts</glob>");
		const noGlobs = renderCustom({ rules: [{ name: "r1", description: "d", globs: [] }] });
		expect(noGlobs).not.toContain("<glob>");
	});

	it("secretsEnabled gate toggles the redaction-token explainer", () => {
		const on = renderCustom({ secretsEnabled: true });
		expect(on).toContain("<redacted-content>");
		expect(on).toContain("#XXXX#");
		expect(renderCustom({ secretsEnabled: false })).not.toContain("<redacted-content>");
	});

	/**
	 * Completeness guard: every `{{#if <field>}}` gate in the shipped custom
	 * template must be in the tested set. A new gate added without a parity test
	 * fails here, so this template cannot silently fall behind either.
	 */
	it("accounts for every gate in the shipped custom template", () => {
		const tested = new Set([
			"systemPromptCustomization",
			"appendPrompt",
			"contextFiles",
			"skills",
			"alwaysApplyRules",
			"rules",
			"globs",
			"secretsEnabled",
		]);
		const found = new Set<string>();
		for (const m of customSystemPromptTemplate.matchAll(/\{\{#if\s+([A-Za-z_][\w.]*)\}\}/g)) {
			found.add(m[1].replace(/\.length$/, ""));
		}
		expect(found.size).toBeGreaterThanOrEqual(8);
		const untested = [...found].filter(id => !tested.has(id)).sort();
		expect(untested).toEqual([]);
	});
});
