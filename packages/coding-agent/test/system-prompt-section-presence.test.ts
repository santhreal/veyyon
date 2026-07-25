/**
 * `optional` on a prompt section is a claim about assembly, and this suite is
 * what makes it one.
 *
 * WHY THIS SUITE EXISTS. Every registry row now says whether its section may be
 * absent. That field decides how a reader must interpret a prompt with a section
 * missing: optional means a feature is off, required means assembly broke. A flag
 * nothing checks answers that question wrongly the moment a section becomes
 * conditional, and it answers it CONFIDENTLY, which is worse than not answering —
 * an inspection would report a truncated prompt as a correct minimal one.
 *
 * The system prompt went without the flag entirely. `prompts/registry.ts` has
 * carried it since it was written, and `veyyon prompt --prompt subagent` has
 * always marked each subagent section optional or always, so the product could
 * tell a subagent prompt that rendered three of five sections from one that lost
 * two. It could not do that for the system prompt — the larger document, and the
 * one where it matters most, since 86 of its 272 template lines carry conditional
 * syntax and 54 of those open a conditional.
 *
 * Both directions are asserted, because each catches a different lie. A section
 * marked required must render from the BAREST options the builder accepts: no
 * tools, no skills, no rules, an empty workspace. A section marked optional must
 * be absent under those same options and appear once its input is supplied — a
 * section marked optional that always renders is a required section wearing the
 * wrong label, and an inspection would excuse its disappearance.
 */
import { describe, expect, it } from "bun:test";
import { inspectSystemPrompt } from "@veyyon/coding-agent/system-prompt-builder/prompt-inspect";
import {
	OPTION_BACKED_RUNTIME_SECTIONS,
	SYSTEM_PROMPT_SECTIONS,
} from "@veyyon/coding-agent/system-prompt-builder/section-registry";

const EMPTY_TREE = {
	rootPath: "/tmp",
	rendered: "",
	truncated: false,
	totalLines: 0,
	agentsMdFiles: [] as string[],
};

type InspectOptions = Parameters<typeof inspectSystemPrompt>[0];

/** The barest prompt the builder will produce: nothing on, nothing discovered. */
const barest = (): InspectOptions =>
	({
		toolNames: [],
		contextFiles: [],
		skills: [],
		rules: [],
		workspaceTree: EMPTY_TREE,
		activeRepoContext: null,
	}) as InspectOptions;

/** Everything an option-backed section needs, so each one has a reason to render. */
const everyOptionSupplied = (): InspectOptions => {
	const options: Record<string, unknown> = { ...(barest() as object) };
	for (const section of OPTION_BACKED_RUNTIME_SECTIONS) {
		options[section.input.key] = `<<${section.id.toUpperCase()}>>`;
	}
	return options as InspectOptions;
};

describe("a section marked required renders even from the barest configuration", () => {
	/**
	 * Non-vacuity. Every assertion below filters the registry; if the registry were
	 * empty or the flags were all one value, the loops would pass while covering
	 * nothing, which is how a presence guard rots into decoration.
	 */
	it("has sections of both kinds to check", () => {
		const required = SYSTEM_PROMPT_SECTIONS.filter(section => !section.optional).map(section => section.id);
		const optional = SYSTEM_PROMPT_SECTIONS.filter(section => section.optional).map(section => section.id);

		expect(required).toEqual([
			"conventions",
			"role",
			"runtime",
			"tool-policy",
			"execution-workflow",
			"delivery-contract",
			"project",
		]);
		expect(optional).toEqual(["shorthand", "shorthand-handles"]);
	});

	/**
	 * The load-bearing direction. A section that claims to be required and does not
	 * render is either mislabelled or genuinely lost, and both are defects: the
	 * inspection would report the prompt as complete, and a reviewer comparing two
	 * configurations would see the difference as intentional.
	 */
	it("renders every required section with no tools, skills, rules or workspace", async () => {
		const inspection = await inspectSystemPrompt(barest());
		const missingRequired = inspection.missing.filter(section => !section.optional).map(section => section.id);

		// Listed, not counted: the failure has to name the section that vanished.
		expect(missingRequired).toEqual([]);
	});

	/**
	 * Required sections survive the opposite extreme too. A section could be
	 * conditional on a feature being OFF — rendering in the bare case and vanishing
	 * once something is enabled — which the bare-case test alone would miss.
	 */
	it("renders every required section with every option supplied", async () => {
		const inspection = await inspectSystemPrompt(everyOptionSupplied());
		const missingRequired = inspection.missing.filter(section => !section.optional).map(section => section.id);

		expect(missingRequired).toEqual([]);
	});
});

describe("a section marked optional is genuinely optional", () => {
	/**
	 * The direction that keeps the flag honest. If an optional section renders
	 * unconditionally, the label is wrong, and its future disappearance would be
	 * excused by an inspection as a feature being off.
	 */
	it("is absent from the barest configuration", async () => {
		const inspection = await inspectSystemPrompt(barest());
		const missing = new Set(inspection.missing.map(section => section.id));

		const optional = SYSTEM_PROMPT_SECTIONS.filter(section => section.optional);
		expect(optional.length).toBeGreaterThan(0);
		for (const section of optional) {
			expect(missing.has(section.id), `${section.id} is marked optional but rendered anyway`).toBe(true);
		}
	});

	/**
	 * And it must be reachable. A section that is absent under every configuration
	 * would also pass the test above, while being dead weight in the registry that
	 * nothing can ever render.
	 */
	it("renders once its input is supplied", async () => {
		const inspection = await inspectSystemPrompt(everyOptionSupplied());
		const missing = new Set(inspection.missing.map(section => section.id));

		expect(OPTION_BACKED_RUNTIME_SECTIONS.length).toBeGreaterThan(0);
		for (const section of OPTION_BACKED_RUNTIME_SECTIONS) {
			expect(missing.has(section.id), `${section.id} never renders, even with its option set`).toBe(false);
		}
	});
});

describe("the inspection reports absence rather than leaving it to be noticed", () => {
	/**
	 * `missing` and `sections` partition the registry. A section counted in neither
	 * would be invisible to both halves of an inspection; a section in both would
	 * make the two disagree about the same prompt.
	 */
	it("accounts for every registered section as present or missing", async () => {
		const inspection = await inspectSystemPrompt(barest());
		const present = new Set(inspection.sections.map(section => section.id));
		const missing = new Set(inspection.missing.map(section => section.id));

		for (const section of SYSTEM_PROMPT_SECTIONS) {
			expect(
				present.has(section.id) !== missing.has(section.id),
				`${section.id} is ${present.has(section.id) && missing.has(section.id) ? "both" : "neither"} present nor missing`,
			).toBe(true);
		}
	});

	/**
	 * The rendered table has to SAY it, not merely carry it in a field. The whole
	 * point is that somebody reading `veyyon prompt --sections` can tell a minimal
	 * prompt from a broken one without knowing the registry by heart.
	 */
	it("names absent sections under the table, marked optional or REQUIRED", async () => {
		const { formatInspectionTable } = await import("@veyyon/coding-agent/system-prompt-builder/prompt-inspect");
		const table = formatInspectionTable(await inspectSystemPrompt(barest()));

		expect(table).toContain("not in this prompt:");
		expect(table).toContain("shorthand");
		expect(table).toContain("optional");
		// Nothing is required-and-missing in a correct build, so the alarm must be
		// silent here. A table that always cried "incomplete" would be ignored.
		expect(table).not.toContain("REQUIRED");
		expect(table).not.toContain("This prompt is incomplete");
	});
});
