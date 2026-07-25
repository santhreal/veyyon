/**
 * SYSPROMPT-2: every prompt a model receives should be described the same way.
 *
 * The section registry reached exactly one prompt. The main system prompt got
 * banner sections, a declared order, source tracking, overrides, reordering and
 * an inspection command; roughly ten other assemblers hand-rolled their own with
 * none of that. The subagent prompt — the one a delegated task actually runs
 * under, and so the one doing most of the work in a large session — was the
 * least inspectable of them.
 *
 * It also turned out to already BE section-shaped. `ROLE`, `CONTEXT`, `PLAN`,
 * `COOP` and `COMPLETION` are banner regions in exactly the format the splitter
 * cuts on; they were simply never declared, so nothing could address them.
 *
 * That makes the registration a claim about the file rather than a change to
 * it, and a claim is worth only as much as its check. These suites are that
 * check, and they are deliberately about AGREEMENT rather than about the
 * registry looking sensible:
 *
 *   - the declared banners must exist in the template, in the declared order,
 *     or the registry describes a file that is not there;
 *   - a real render must split into the declared sections, or the registration
 *     is right about the source and wrong about the output;
 *   - the rendered bytes must not move, because a migration that improves the
 *     prompt while claiming to preserve it is the failure mode that makes
 *     "behaviour-preserving refactor" untrustworthy.
 */
import { describe, expect, it } from "bun:test";
import { PROMPTS, requirePrompt } from "@veyyon/coding-agent/prompts/registry";
import { bannerTable, renderBanner } from "@veyyon/coding-agent/system-prompt-builder/banner-grammar";
import { splitPromptSections } from "@veyyon/coding-agent/system-prompt-builder/prompt-sections";
import { prompt } from "@veyyon/utils";

/**
 * The subagent prompt comes from the registry, not from a direct `.md` import.
 *
 * That is the same rule production code follows, and it makes this suite test
 * what ships: a registration that pointed at the wrong file would be invisible
 * to a test that reached around the registry to read the file itself.
 */
const SUBAGENT_PROMPT = PROMPTS["subagent/system-prompt"];
const SUBAGENT_SECTIONS = SUBAGENT_PROMPT.sections ?? [];
const template = SUBAGENT_PROMPT.text;

/** The subagent prompt's own banner table, which is what makes it splittable. */
const SUBAGENT_BANNERS = bannerTable(SUBAGENT_SECTIONS);

/** The context a plain delegated task renders with: no plan, no worktree, no IRC. */
const MINIMAL = {
	agent: "You are a test agent.",
	context: "",
	planReference: "",
	planReferencePath: "",
	worktree: "",
	outputSchema: "",
	outputSchemaOverridesAgent: false,
	ircPeers: "",
	ircSelfId: "",
};

/** Every optional region turned on at once. */
const MAXIMAL = {
	...MINIMAL,
	context: "Fix the failing test.",
	planReference: "1. Do the thing.",
	planReferencePath: "/repo/PLAN.md",
	worktree: "/tmp/wt",
	ircPeers: "- peer-1: editing foo.ts",
	ircSelfId: "task-9",
};

describe("the registry agrees with the template file", () => {
	it("declares only banners the template actually contains", () => {
		// A registry naming a banner the file does not have describes a document
		// that is not there, and every consumer keyed off it silently finds
		// nothing.
		for (const section of SUBAGENT_SECTIONS) {
			if (section.name === null) continue;
			// The rendered banner, underline included: the registry declares only the
			// name, so matching the name alone would pass on a file that lost its
			// underline and therefore no longer splits at that point.
			expect(template).toContain(renderBanner(section.name));
		}
	});

	it("declares them in the order the template uses", () => {
		// Order is not decorative: it is what a reorder consumer permutes and what
		// a splitter walks. Declared out of order, the registry would cut the file
		// at the wrong boundaries.
		const positions = SUBAGENT_SECTIONS.filter(section => section.name !== null).map(section =>
			template.indexOf(renderBanner(section.name as string)),
		);

		expect(positions).toEqual([...positions].sort((a, b) => a - b));
		expect(positions.every(position => position >= 0)).toBe(true);
	});

	it("declares every banner the template contains, with none left unregistered", () => {
		// The other direction. Registering a subset would leave real sections
		// unaddressable while the tests above still passed.
		const bannersInFile = [...template.matchAll(/^([A-Z][A-Z ]*)\n={3,}$/gm)].map(match => match[1]);
		const declared = SUBAGENT_SECTIONS.map(section => section.id.toUpperCase().replace(/-/g, " "));

		expect([...new Set(bannersInFile)].sort()).toEqual([...new Set(declared)].sort());
	});
});

describe("a real render splits into the declared sections", () => {
	it("produces every non-optional section for a minimal task", () => {
		// Being right about the source file does not prove being right about the
		// output: the template is a program, and its conditionals decide what
		// actually appears.
		const rendered = prompt.render(template, MINIMAL);
		const found = new Set(splitPromptSections(rendered, SUBAGENT_BANNERS).map(section => section.name));

		for (const section of SUBAGENT_SECTIONS) {
			if (section.optional) continue;
			expect(found).toContain(section.id);
		}
	});

	it("omits the optional sections when their inputs are absent", () => {
		// An absent optional section is the feature being off, not a truncation,
		// and the registry records the difference precisely so a consumer can tell
		// them apart.
		const rendered = prompt.render(template, MINIMAL);
		const found = new Set(splitPromptSections(rendered, SUBAGENT_BANNERS).map(section => section.name));

		expect(found).not.toContain("context");
		expect(found).not.toContain("plan");
	});

	it("produces every section when all inputs are present", () => {
		// The differential proving the omission above is the inputs, not a
		// splitter that cannot find those sections at all.
		const rendered = prompt.render(template, MAXIMAL);
		const found = new Set(splitPromptSections(rendered, SUBAGENT_BANNERS).map(section => section.name));

		for (const section of SUBAGENT_SECTIONS) expect(found).toContain(section.id);
	});
});

describe("registration preserves the rendered bytes", () => {
	/**
	 * The golden pin. Registration is a claim that nothing about the prompt
	 * changed, and the only way that claim stays true through later edits is if
	 * the bytes are asserted rather than assumed. These are exact substrings from
	 * the shipped template, not shape checks.
	 */
	it("renders the minimal task exactly as before", () => {
		const rendered = prompt.render(template, MINIMAL);

		expect(rendered).toContain("ROLE\n==============\n\nYou are a test agent.");
		expect(rendered).toContain("COOP\n==============");
		expect(rendered).toContain("You are operating on a piece of work assigned to you by the main agent.");
		expect(rendered).toContain("No TODO tracking, no progress updates. Execute; report results with `yield`.");
		expect(rendered).toContain("You MUST keep going until this ticket is closed. This matters.");
	});

	it("renders the plan section with its path attribute intact", () => {
		// The plan is delivered inside an attributed XML element, and the
		// attribute is what tells the agent never to re-read the file.
		const rendered = prompt.render(template, MAXIMAL);

		expect(rendered).toContain('<plan path="/repo/PLAN.md">\n1. Do the thing.\n</plan>');
	});

	it("renders the worktree and IRC regions with their values substituted", () => {
		const rendered = prompt.render(template, MAXIMAL);

		expect(rendered).toContain("You are working in an isolated working tree at `/tmp/wt` for this sub-task.");
		expect(rendered).toContain("Your id is `task-9`.");
		expect(rendered).toContain("- peer-1: editing foo.ts");
	});

	it("leaves no unrendered template syntax behind", () => {
		// A conditional that failed to close, or a helper that silently did
		// nothing, shows up here and nowhere else.
		for (const context of [MINIMAL, MAXIMAL]) {
			const rendered = prompt.render(template, context);

			expect(rendered).not.toContain("{{");
			expect(rendered).not.toContain("}}");
		}
	});
});

describe("looking a prompt up", () => {
	it("returns the registered prompt by id", () => {
		expect(requirePrompt("subagent/system-prompt")).toBe(SUBAGENT_PROMPT);
	});

	it("throws on an unknown id, saying how ids are formed", () => {
		// A silent undefined would degrade to an empty prompt, which reaches the
		// model as no instructions at all and reads downstream as the model
		// ignoring its brief.
		expect(() => requirePrompt("system/subagnet-system-prompt")).toThrow(
			/unknown prompt "system\/subagnet-system-prompt"; ids are the path under src\/prompts without \.md/,
		);
	});
});
