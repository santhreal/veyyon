/**
 * End-to-end wiring tests for modular system-prompt statements.
 *
 * The outer template contains no fallback prose, so observing real instruction
 * text in `buildSystemPrompt` proves the registry reached the production path.
 * These tests also pin gate behavior and operator override precedence.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { buildSystemPrompt } from "@veyyon/coding-agent/system-prompt";
import {
	assembleDefaultTemplate,
	assembleStatementSections,
	DEFAULT_TEMPLATE_SECTION_ORDER,
	resolveSectionOverrides,
} from "@veyyon/coding-agent/system-prompt-builder/default-template";

beforeAll(async () => {
	await Settings.init({ inMemory: true, cwd: process.cwd() });
});

describe("statement modules reach the assembled document", () => {
	/**
	 * A distinctive sentence from the Mermaid module must appear when its
	 * condition is enabled, proving statement-file content fills the outer slot.
	 */
	it("includes a gated statement when its condition is enabled", () => {
		const sections = assembleStatementSections({ renderMermaid: true });
		const assembled = assembleDefaultTemplate(sections);

		expect(assembled).toContain("Use it for genuine structure or flow, not trivia.");
		expect(assembled).toContain("Engineering Principles");
	});

	/**
	 * Disabling one statement must remove only that statement while preserving
	 * the unconditional modules in the same section.
	 */
	it("removes only the gated statement when its condition is disabled", () => {
		const sections = assembleStatementSections({ renderMermaid: false });
		const assembled = assembleDefaultTemplate(sections);

		expect(assembled).not.toContain("Use it for genuine structure or flow, not trivia.");
		expect(assembled).toContain("Engineering Principles");
	});

	/**
	 * Every registered static section must produce a real value. An incomplete
	 * map cannot fall back to text in the zero-prose template.
	 */
	it("supplies every static template slot from statements", () => {
		const sections = assembleStatementSections({ renderMermaid: true });

		expect(Object.keys(sections).sort()).toEqual([...DEFAULT_TEMPLATE_SECTION_ORDER].sort());
		for (const key of DEFAULT_TEMPLATE_SECTION_ORDER) {
			expect(sections[key].length, `${key} is empty`).toBeGreaterThan(50);
		}
	});
});

describe("production prompt construction uses statement modules", () => {
	/**
	 * The session-facing builder must preserve the same gate transition as the
	 * lower-level assembler, not merely expose a disconnected registry helper.
	 */
	it("carries statement conditions through buildSystemPrompt", async () => {
		const enabled = await buildSystemPrompt({ cwd: process.cwd(), renderMermaid: true });
		const disabled = await buildSystemPrompt({ cwd: process.cwd(), renderMermaid: false });
		const enabledText = enabled.systemPrompt.join("\n");
		const disabledText = disabled.systemPrompt.join("\n");

		expect(enabledText).toContain("Use it for genuine structure or flow, not trivia.");
		expect(disabledText).not.toContain("Use it for genuine structure or flow, not trivia.");
		expect(enabledText).toContain("Engineering Principles");
		expect(disabledText).toContain("Engineering Principles");
	});

	/**
	 * A body-only section replacement must receive the registry banner, replace
	 * its statement modules, and leave unrelated statement sections intact.
	 */
	it("lets a body-only override replace exactly one statement section", () => {
		const statements = assembleStatementSections({ renderMermaid: true });
		const overrides = resolveSectionOverrides({ role: "OPERATOR REPLACED THIS SECTION." });
		const assembled = assembleDefaultTemplate({ ...statements, ...overrides });

		expect(assembled).toContain("ROLE\n==============\n\nOPERATOR REPLACED THIS SECTION.");
		expect(assembled).not.toContain("Engineering Principles");
		expect(assembled).toContain("<system-conventions>");
	});

	/**
	 * The production precedence must match direct assembly: eval replacement
	 * bodies win over statements without replacing the whole document.
	 */
	it("applies body-only eval overrides after statement assembly", async () => {
		const previous = process.env.VEYYON_EVAL_SYSTEM_PROMPT_SECTIONS;
		process.env.VEYYON_EVAL_SYSTEM_PROMPT_SECTIONS = JSON.stringify({
			role: "OPERATOR WINS AT THE CALL SITE.",
		});
		try {
			const built = await buildSystemPrompt({ cwd: process.cwd(), renderMermaid: true });
			const text = built.systemPrompt.join("\n");

			expect(text).toContain("ROLE\n==============\n\nOPERATOR WINS AT THE CALL SITE.");
			expect(text).not.toContain("Engineering Principles");
			expect(text).not.toContain("Use it for genuine structure or flow, not trivia.");
			expect(text).toContain("<system-conventions>");
		} finally {
			if (previous === undefined) delete process.env.VEYYON_EVAL_SYSTEM_PROMPT_SECTIONS;
			else process.env.VEYYON_EVAL_SYSTEM_PROMPT_SECTIONS = previous;
		}
	});

	/**
	 * An eval arm targeting a gated-off statement changes no bytes. Refuse that
	 * configuration instead of warning that a replacement was applied.
	 */
	it("rejects a statement override whose condition is inactive", async () => {
		const previous = process.env.VEYYON_EVAL_SYSTEM_PROMPT_STATEMENTS;
		process.env.VEYYON_EVAL_SYSTEM_PROMPT_STATEMENTS = JSON.stringify({
			"role/mermaid-diagrams": "INACTIVE ARM",
		});
		try {
			await expect(buildSystemPrompt({ cwd: process.cwd(), renderMermaid: false })).rejects.toThrow(
				/inactive for this prompt configuration/,
			);
		} finally {
			if (previous === undefined) delete process.env.VEYYON_EVAL_SYSTEM_PROMPT_STATEMENTS;
			else process.env.VEYYON_EVAL_SYSTEM_PROMPT_STATEMENTS = previous;
		}
	});

	/**
	 * A whole-section replacement would discard a finer statement arm in the
	 * same section. The two eval instruments must not silently compose.
	 */
	it("rejects overlapping statement and section overrides", async () => {
		const previousStatements = process.env.VEYYON_EVAL_SYSTEM_PROMPT_STATEMENTS;
		const previousSections = process.env.VEYYON_EVAL_SYSTEM_PROMPT_SECTIONS;
		process.env.VEYYON_EVAL_SYSTEM_PROMPT_STATEMENTS = JSON.stringify({
			"role/principles": "STATEMENT ARM",
		});
		process.env.VEYYON_EVAL_SYSTEM_PROMPT_SECTIONS = JSON.stringify({ role: "SECTION ARM" });
		try {
			await expect(buildSystemPrompt({ cwd: process.cwd(), renderMermaid: true })).rejects.toThrow(
				/whole-section replacements.*role/s,
			);
		} finally {
			if (previousStatements === undefined) delete process.env.VEYYON_EVAL_SYSTEM_PROMPT_STATEMENTS;
			else process.env.VEYYON_EVAL_SYSTEM_PROMPT_STATEMENTS = previousStatements;
			if (previousSections === undefined) delete process.env.VEYYON_EVAL_SYSTEM_PROMPT_SECTIONS;
			else process.env.VEYYON_EVAL_SYSTEM_PROMPT_SECTIONS = previousSections;
		}
	});
});
