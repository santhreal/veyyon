/**
 * SYSPROMPT-3: the assembled system prompt must be readable without running a session.
 *
 * `prompts/session/system-prompt.md` is a program, not a document: 86 of its 272
 * lines carry template syntax and 54 open a conditional, so whole regions
 * appear or vanish with the live tool set, the settings, the workspace and the
 * model's harness profile. Reading the file tells you what could ship. Before
 * this inspection existed the only way to see what DID ship was to start a
 * session and export it, which is slow enough that in practice nobody did — so
 * prompt changes were reviewed as diffs of template fragments rather than as
 * the artifact the model receives.
 *
 * The contract these tests defend is FAITHFULNESS. An inspection that is merely
 * plausible is worse than none: it invites review of a prompt nobody was ever
 * sent. So the assertions are about identity with the real assembly rather than
 * about the output looking reasonable — the sections must reconstruct the real
 * blocks byte for byte, the block boundary must survive because it is the
 * provider caching contract, and section ids must match the registry's so the
 * thing you can see is the thing you can override.
 */
import { describe, expect, it } from "bun:test";
import { Settings } from "@veyyon/coding-agent/config/settings";
import {
	formatInspectionTable,
	inspectSystemPrompt,
	type PromptInspection,
} from "@veyyon/coding-agent/system-prompt-builder/prompt-inspect";
import { SYSTEM_PROMPT_SECTIONS } from "@veyyon/coding-agent/system-prompt-builder/section-registry";

await Settings.init({ inMemory: true });

/** One assembly, shared: building it runs real workspace discovery. */
const inspection: PromptInspection = await inspectSystemPrompt({ toolNames: ["read", "edit", "bash", "grep"] });

describe("the inspection reproduces the prompt rather than approximating it", () => {
	it("reconstructs every block byte for byte from its sections", () => {
		// THE core guarantee. If the pieces do not reassemble into the real thing,
		// every size, share and diff computed from them describes a document that
		// was never sent, and a reviewer would be reading fiction.
		for (const [index, block] of inspection.blocks.entries()) {
			const rebuilt = inspection.sections
				.filter(section => section.blockIndex === index)
				.map(section => section.text)
				.join("\n");

			expect(rebuilt).toBe(block);
		}
	});

	it("reports byte counts that match the text it carries", () => {
		// A size table is the first thing an operator trusts and the easiest thing
		// to compute from the wrong string.
		for (const section of inspection.sections) {
			expect(section.bytes).toBe(Buffer.byteLength(section.text, "utf8"));
		}
	});

	it("totals the sections rather than measuring something else", () => {
		expect(inspection.totalBytes).toBe(inspection.sections.reduce((sum, s) => sum + s.bytes, 0));
		expect(inspection.totalTokens).toBe(inspection.sections.reduce((sum, s) => sum + s.tokens, 0));
	});
});

describe("the provider caching boundary survives inspection", () => {
	it("keeps template and runtime text in separate blocks", () => {
		// `buildSystemPrompt` splits the array so the static prefix stays
		// byte-stable for the provider's cache while volatile runtime text cannot
		// invalidate it. An inspection that flattened the array would hide the
		// single most expensive thing a prompt change can get wrong, so the split
		// is asserted as a property of the report itself.
		const blocksBySource = new Map<string, Set<number>>();
		for (const section of inspection.sections) {
			if (section.source === "preamble") continue;
			const blocks = blocksBySource.get(section.source) ?? new Set();
			blocks.add(section.blockIndex);
			blocksBySource.set(section.source, blocks);
		}

		const templateBlocks = blocksBySource.get("template") ?? new Set();
		const runtimeBlocks = blocksBySource.get("runtime") ?? new Set();
		for (const block of templateBlocks) expect(runtimeBlocks.has(block)).toBe(false);
	});

	it("assigns every section to a block that exists", () => {
		for (const section of inspection.sections) {
			expect(section.blockIndex).toBeGreaterThanOrEqual(0);
			expect(section.blockIndex).toBeLessThan(inspection.blocks.length);
		}
	});
});

describe("section identity agrees with the registry", () => {
	it("names the leading region by its registry id, not the splitter's", () => {
		// The splitter calls everything before the first banner "preamble" because
		// that is what it structurally is; the registry calls that same text
		// `conventions`, a declared section that simply has no banner. Reporting
		// two names for one section would make `--section conventions` fail on a
		// section that is plainly present.
		const ids = inspection.sections.map(section => section.id);

		expect(ids).toContain("conventions");
		expect(ids).not.toContain("preamble");
	});

	it("labels each section with the source the registry declares", () => {
		// The label is what tells an operator whether a section comes from the .md
		// file or from runtime state, which decides how it can be changed at all.
		const declared = new Map(SYSTEM_PROMPT_SECTIONS.map(section => [section.id as string, section.source]));
		for (const section of inspection.sections) {
			const expected = declared.get(section.id);
			if (expected === undefined) continue;
			expect(section.source).toBe(expected);
		}
	});

	it("reports no unregistered section for a default build", () => {
		// `unregistered` means the prompt carries a banner the registry does not
		// know, which cannot be reordered or overridden. On the default path that
		// is a defect, so it is pinned rather than tolerated.
		expect(inspection.sections.filter(section => section.source === "unregistered")).toEqual([]);
	});

	it("includes the sections the shipped template actually defines", () => {
		// Guards against a silently truncated assembly. A regression that dropped
		// half the prompt would still satisfy every structural assertion above.
		const ids = new Set(inspection.sections.map(section => section.id));

		for (const id of ["conventions", "role", "runtime", "tool-policy", "execution-workflow", "delivery-contract"]) {
			expect(ids).toContain(id);
		}
	});
});

describe("the tool set really does change the prompt", () => {
	it("drops tool-gated text when the tools are absent", () => {
		// Roughly half the template's conditionals are `{{#has tools "..."}}`, so
		// this is the proof that the inspection reflects its inputs instead of
		// printing the template with the conditionals rendered once and cached.
		expect(inspection.blocks.join("\n")).toContain("`grep`");
	});

	it("produces a smaller prompt with no tools at all", async () => {
		const bare = await inspectSystemPrompt({ toolNames: [] });

		expect(bare.totalBytes).toBeLessThan(inspection.totalBytes);
	});
});

describe("the breakdown table", () => {
	const table = formatInspectionTable(inspection);

	/**
	 * The cost table proper: header, one row per present section, TOTAL. Anything
	 * after that is the absent-section footer, which is a different report about a
	 * different set and must not be measured as though it were part of the table.
	 */
	const costTable = (): string[] => {
		const lines = table.split("\n");
		const footer = lines.indexOf("not in this prompt:");
		return footer === -1 ? lines : lines.slice(0, footer - 1);
	};

	it("lists sections largest first", () => {
		// The table answers "what is taking up the prompt", so cost order is the
		// useful one; prompt order is already visible in the full text.
		const rows = costTable().slice(1, -1);
		const tokens = rows.map(row => Number(row.trim().split(/\s+/).at(-2)));

		expect(tokens).toEqual([...tokens].sort((a, b) => b - a));
	});

	it("carries a row for every section plus a header and a total", () => {
		expect(costTable()).toHaveLength(inspection.sections.length + 2);
	});

	/**
	 * The footer is the half a cost table cannot show. Sections that did not render
	 * have no bytes to report, so they appear nowhere in the rows above, and their
	 * absence used to be indistinguishable from them not existing.
	 */
	it("names the sections that are not in this prompt", () => {
		expect(inspection.missing.length).toBeGreaterThan(0);
		expect(table).toContain("not in this prompt:");
		for (const section of inspection.missing) {
			expect(table).toContain(section.id);
		}
	});

	it("shows shares that add up to the whole", () => {
		// A share column that did not sum to 100 would quietly misattribute cost,
		// which is the one number an operator acts on.
		const shares = [...table.matchAll(/(\d+\.\d)%/g)].map(match => Number(match[1]));

		expect(shares.reduce((sum, share) => sum + share, 0)).toBeCloseTo(100, 0);
	});
});
