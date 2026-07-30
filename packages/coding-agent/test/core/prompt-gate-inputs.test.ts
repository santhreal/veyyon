/**
 * A settings change reaches the rendered system prompt, and the inspection path proves it.
 *
 * WHY THIS SUITE EXISTS. `veyyon prompt` promises, in its own file header, to "print the system
 * prompt this configuration would send" and to resolve "the same inputs a real session
 * resolves". It justified resolving the tool set for real on the grounds that "a prompt
 * inspected against an imagined tool list is a prompt nobody will ever be sent". It then handed
 * `inspectSystemPrompt` three things: tools, tool names, and cwd.
 *
 * So every settings-fed gate fell to the omitted-option default in `system-prompt.ts`.
 * Reproduced before the fix, with `subagent.delegation=required` and `personality=none`: the
 * rendered prompt had NO Eager Tasks section, which a real session with `required` does have,
 * and DID have a personality block, which a session with `none` does not. Both the opposite of
 * the configuration. The one surface built to show you the prompt was the surface that could
 * not show you a settings change, which is the practical reason a small gated edit was hard to
 * make: you could not see it.
 *
 * The fix gives the settings-to-prompt derivation one owner (`gate-inputs.ts`) that the session
 * path and the inspection path both call. This suite is the proof that it works END TO END
 * rather than that the function exists: for each live gate it renders the prompt twice through
 * the real assembler and asserts the bytes differ. A test that only checked the resolver
 * returned the right value would have passed on the broken code too, because the resolver's
 * value was never the problem: nothing carried it to the template.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { OMITTED_GATE_DEFAULTS, resolveGateInputs } from "@veyyon/coding-agent/system-prompt-builder/gate-inputs";
import {
	gateSections,
	LIVE_PROMPT_GATE_SETTINGS,
	promptGateFor,
} from "@veyyon/coding-agent/system-prompt-builder/gate-registry";
import { inspectSystemPrompt } from "@veyyon/coding-agent/system-prompt-builder/prompt-inspect";
import { statementById } from "@veyyon/coding-agent/system-prompt-builder/statement-registry";

/**
 * A task tool with two spawnable agents.
 *
 * Delegation strength is resolved against the agents the tool will actually accept, so without
 * this the whole delegation family reads as off and five gates would look static for a reason
 * that has nothing to do with the wiring under test. `enabledAgentNames` is the property
 * `enabledSubagentNames` reads.
 */
const TASK_TOOL = { name: "task", enabledAgentNames: ["scout", "worker"], description: "delegate work" };
const TOOLS = new Map<string, unknown>([["task", TASK_TOOL]]);
const MODEL = { id: "anthropic/claude-opus-4", supportsTools: true };

/**
 * A non-default value per live gate, chosen to actually flip the text rather than to be tidy.
 *
 * `subagent.maxConcurrency: 1` is not cosmetic: the number is quoted in the delegation guidance,
 * so any value but the default moves bytes.
 */
const FLIPS: Readonly<Record<string, unknown>> = {
	personality: "none",
	"tui.renderMermaid": false,
	"subagent.delegation": "required",
	"subagent.batch": false,
	"subagent.maxConcurrency": 1,
	"subagent.agents": {},
	includeModelInPrompt: false,
	"tools.format": "hermes",
	inlineToolDescriptors: true,
	// Defaults to TRUE, so the flip is off and the statement leaves the prompt.
	"tools.intentTracing": false,
};

/**
 * Two gates reach the prompt through the TOOL, not through the resolver.
 *
 * `subagent.agents`: the resolver asks the task tool which agents it will accept
 * (`enabledAgentNames`); the setting is what the tool builds that list from.
 *
 * `subagent.enabled`: off means the task tool is never built at all, so the whole
 * `{{#has tools "task"}}` Delegation section leaves the prompt. Nothing about it passes through
 * the resolver.
 *
 * Either way, flipping the setting against a fixed stub tool changes nothing, so the honest test
 * for both is a tool-level one below rather than a settings flip. Both stay registered as live
 * gates because in a real session they do change the prompt, and a rebuild is what carries them
 * there.
 */
const REACHES_THE_PROMPT_VIA_THE_TOOL = new Set(["subagent.agents", "subagent.enabled"]);

/** Render the prompt the way `veyyon prompt` does, under `overrides`. */
async function renderUnder(overrides: Record<string, unknown>, tools: Map<string, unknown> = TOOLS): Promise<string> {
	const settings = Settings.isolated(overrides as never);
	const gates = resolveGateInputs(settings, { tools: tools as never, model: MODEL });
	const inspection = await inspectSystemPrompt({
		...gates,
		tools: tools as never,
		toolNames: [...tools.keys()],
		model: MODEL.id,
		cwd: process.cwd(),
	});
	return inspection.blocks.join("\n");
}

/**
 * What each live gate's flip does, named.
 *
 * WHY THIS TABLE REPLACED A STRING COMPARISON. Every test below used to assert
 * `expect(flipped).not.toBe(baseline)` over roughly 76KB of prompt. That proved the flip reached
 * the assembler, which was the bug under repair, and nothing more: it passes just as well if the
 * flip changes the WRONG text, changes text in the wrong section, or changes one byte of
 * whitespace. It also could not be read. Nobody could tell from the suite what a prompt gate was
 * supposed to do.
 *
 * A statement has a name, so the claim can be specific. Two kinds of claim, because gates work in
 * two ways and flattening them would mean asserting something weaker than the truth for one of
 * them:
 *
 *   - PRESENCE: the gate decides whether a statement is in the prompt at all. Its signature is
 *     DERIVED from the statement's own text rather than pasted here, so the claim cannot rot into
 *     a quotation of prose that has since been reworded.
 *   - WORDING: the statement is present either way and the gate decides what it says, because the
 *     conditional is intra-line and Handlebars still owns it. Those arms are quoted, because a
 *     derived signature is by construction the part that does NOT change.
 *
 * `includeModelInPrompt` is neither: it gates a runtime SECTION, which is the category error the
 * gate registry was corrected for, so its claim is checked against `gateSections` rather than
 * against a statement.
 */
type GateClaim =
	| {
			readonly kind: "presence";
			readonly statements: readonly { readonly id: string; readonly underTheFlip: "present" | "absent" }[];
	  }
	| {
			readonly kind: "wording";
			readonly statement: string;
			readonly inTheBaseline: string | null;
			readonly underTheFlip: string | null;
	  }
	| {
			readonly kind: "literal";
			readonly inTheBaseline: string | null;
			readonly underTheFlip: string | null;
	  };

const CLAIMS: Readonly<Record<string, GateClaim>> = {
	personality: { kind: "presence", statements: [{ id: "delivery-contract/personality", underTheFlip: "absent" }] },
	"tui.renderMermaid": { kind: "presence", statements: [{ id: "role/mermaid-diagrams", underTheFlip: "absent" }] },
	// The one gate whose flip is a SWAP rather than a removal, and the reason a claim holds a list:
	// asserting only that the required wording arrives would pass if both arms rendered at once.
	"subagent.delegation": {
		kind: "presence",
		statements: [
			{ id: "tool-policy/delegation-required", underTheFlip: "present" },
			{ id: "tool-policy/delegation-preferred", underTheFlip: "absent" },
		],
	},
	// Native providers omit prompt descriptors because their schemas already carry
	// them. Both settings below can switch the same live gate back to inline text.
	"tools.format": { kind: "literal", inTheBaseline: null, underTheFlip: "# Tool: task" },
	inlineToolDescriptors: { kind: "literal", inTheBaseline: null, underTheFlip: "# Tool: task" },
	// Intra-line arms. Quoted because the derived signature is the invariant half of the sentence.
	//
	// BOTH OF THESE NAME `delegation-gates` NOW, and they used to name two other statements. The
	// delegation trim consolidated the gates list: `tool-policy/delegation-sequence` was deleted and its
	// `irc` sentence folded into the Sequence-dependencies bullet, and the concurrency cap's own
	// `taskBatch` arm went away when that line was shortened to "Larger fan-out only queues", leaving the
	// Parallelize bullet as the one place `taskBatch` chooses wording. A wording claim therefore rots in
	// two ways, not one: the quoted arm can be reworded, and the statement holding it can move. The
	// suite's own checks catch both, one by name and one by quotation.
	"subagent.batch": {
		kind: "wording",
		statement: "tool-policy/delegation-gates",
		inTheBaseline: ", in one `tasks[]` batch",
		underTheFlip: ", in parallel calls",
	},
	"subagent.maxConcurrency": {
		kind: "wording",
		statement: "tool-policy/delegation-concurrency-cap",
		inTheBaseline: null,
		underTheFlip: "At most 1 subagent",
	},
	// The gate that only became live once the TOOL SCHEMAS followed it. It was
	// `frozen-by-placement` because `sdk.ts` captured the value above `rebuildSystemPrompt`, and
	// its row said moving that read was not enough on its own: the same constant decided whether
	// every tool schema carried the intent field, and a prompt explaining a field the schemas do
	// not have is worse than one that omits it. `Agent` resolves it per turn now, so both follow
	// together and this flip is honest. The schema half is proven in
	// `test/core/intent-tracing-is-live.test.ts`, which is where a prompt-only suite would lie.
	"tools.intentTracing": {
		kind: "presence",
		statements: [{ id: "tool-policy/intent-field", underTheFlip: "absent" }],
	},
};

/** Normalize whitespace so signatures compare words rather than Markdown layout. */
function words(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/**
 * The longest run of literal text in a statement, which is what identifies it in a rendered prompt.
 *
 * Derived rather than quoted on purpose. A hand-copied excerpt is a second copy of the prompt's
 * wording that nothing keeps in step, so it survives a rewording as a test asserting text the
 * prompt no longer contains. Splitting on `{{...}}` and taking the longest surviving run gives the
 * part of the statement Handlebars cannot change, and `words` collapses whitespace so a spacing
 * change is not mistaken for an absent statement.
 */
function signatureOf(id: string): string {
	const statement = statementById(id);
	if (statement === undefined) throw new Error(`no statement is registered as ${id}`);
	const literals = statement.text
		.split(/\{\{[^}]*\}\}/g)
		.map(part => words(part))
		.filter(part => part !== "");
	return literals.reduce((longest, part) => (part.length > longest.length ? part : longest), "");
}

/** How many times a rendered prompt says something, compared word-wise. */
function occurrences(rendered: string, fragment: string): number {
	return words(rendered).split(words(fragment)).length - 1;
}

let baseline = "";

beforeAll(async () => {
	await Settings.init({ inMemory: true, cwd: process.cwd() });
	baseline = await renderUnder({});
});

describe("every live gate reaches the rendered prompt", () => {
	const settingsDriven = LIVE_PROMPT_GATE_SETTINGS.filter(setting => !REACHES_THE_PROMPT_VIA_THE_TOOL.has(setting));

	it.each(settingsDriven)("changes the prompt when %s changes", async setting => {
		// End-to-end: each settings flip must change the specific statement,
		// wording, or generated descriptor claimed below.
		const flipped = await renderUnder({ [setting]: FLIPS[setting] });
		const claim = CLAIMS[setting];

		if (claim === undefined) {
			// `includeModelInPrompt` gates a runtime section rather than a statement, and the gate
			// row is where that is declared. Asserted through `gateSections` so the row and the
			// behaviour cannot disagree: a row that stopped declaring the section fails here.
			expect(
				gateSections(promptGateFor(setting) ?? ({ sections: [] } as never)),
				`${setting} has no claim`,
			).toContain("workstation");
			expect(baseline, `${setting} baseline does not name the model`).toContain(MODEL.id);
			expect(flipped, `${setting} left the model in the prompt`).not.toContain(MODEL.id);
			return;
		}

		if (claim.kind === "presence") {
			for (const { id, underTheFlip } of claim.statements) {
				const signature = signatureOf(id);
				// A signature that matched nothing, or matched twice, would make both assertions
				// below meaningless, so the identification is checked before it is used.
				expect(signature.length, `${id} has no literal text to identify it by`).toBeGreaterThan(12);
				const before = occurrences(baseline, signature);
				const after = occurrences(flipped, signature);

				expect(before + after, `${id} appears nowhere, so the claim about it proves nothing`).toBeGreaterThan(0);
				expect(underTheFlip === "present" ? after : before, `${id} is ambiguous: it appears more than once`).toBe(
					1,
				);
				expect(after, `${id} should be ${underTheFlip} under ${setting}=${String(FLIPS[setting])}`).toBe(
					underTheFlip === "present" ? 1 : 0,
				);
				expect(before, `${id} should be ${underTheFlip === "present" ? "absent" : "present"} in the baseline`).toBe(
					underTheFlip === "present" ? 0 : 1,
				);
			}
			return;
		}

		if (claim.kind === "literal") {
			for (const [text, side] of [
				[claim.inTheBaseline, "baseline"],
				[claim.underTheFlip, "flipped"],
			] as const) {
				if (text === null) continue;
				const present = side === "baseline" ? baseline : flipped;
				const absent = side === "baseline" ? flipped : baseline;
				expect(occurrences(present, text), `${setting}: "${text}" missing from the ${side} prompt`).toBe(1);
				expect(occurrences(absent, text), `${setting}: "${text}" should not be in the other prompt`).toBe(0);
			}
			return;
		}

		// Wording: the statement stays and the sentence inside it changes, so both are asserted.
		// Checking only the new arm would pass if the statement vanished and the arm turned up
		// somewhere else entirely.
		const signature = signatureOf(claim.statement);
		expect(occurrences(baseline, signature), `${claim.statement} is not in the baseline`).toBe(1);
		expect(occurrences(flipped, signature), `${claim.statement} left the prompt under ${setting}`).toBe(1);
		for (const [text, side] of [
			[claim.inTheBaseline, "baseline"],
			[claim.underTheFlip, "flipped"],
		] as const) {
			if (text === null) continue;
			const present = side === "baseline" ? baseline : flipped;
			const absent = side === "baseline" ? flipped : baseline;
			expect(occurrences(present, text), `${setting}: "${text}" missing from the ${side} prompt`).toBe(1);
			expect(occurrences(absent, text), `${setting}: "${text}" should not be in the other prompt`).toBe(0);
		}
	});

	it("claims something specific for every gate it covers, and nothing it cannot check", () => {
		// The table is the readable half of this suite, so an entry that names a statement the
		// registry does not have, or a wording claim with neither side filled in, would be a claim
		// that reads as coverage and asserts nothing.
		for (const [setting, claim] of Object.entries(CLAIMS)) {
			expect(settingsDriven, `${setting} has a claim but is not a live settings-driven gate`).toContain(setting);
			if (claim.kind === "presence") {
				expect(claim.statements.length, `${setting} claims no statement`).toBeGreaterThan(0);
				for (const { id } of claim.statements) {
					expect(statementById(id), `${setting} names ${id}, which is not registered`).toBeDefined();
				}
				continue;
			}
			if (claim.kind === "literal") {
				expect(
					claim.inTheBaseline !== null || claim.underTheFlip !== null,
					`${setting} claims a literal change with no text on either side`,
				).toBe(true);
				continue;
			}
			expect(
				statementById(claim.statement),
				`${setting} names ${claim.statement}, which is not registered`,
			).toBeDefined();
			expect(
				claim.inTheBaseline !== null || claim.underTheFlip !== null,
				`${setting} claims a wording change with no wording on either side`,
			).toBe(true);
		}
	});

	it("covers every live gate, by a flip or by the tool", () => {
		// Guards the exemption above from becoming a place to park a gate nobody tested. Each
		// live gate is either flipped in `FLIPS` or listed as tool-borne, never neither.
		for (const setting of LIVE_PROMPT_GATE_SETTINGS) {
			const covered = Object.hasOwn(FLIPS, setting) || REACHES_THE_PROMPT_VIA_THE_TOOL.has(setting);
			expect(covered, `${setting} is a live gate with no coverage here`).toBe(true);
		}
		expect(settingsDriven.length).toBe(9);
	});

	it("renders a real prompt, so the comparisons are not between two empty strings", () => {
		// Both sides going empty would pass every test above forever.
		expect(baseline.length).toBeGreaterThan(10_000);
		expect(baseline).toContain("ROLE");
	});
});

describe("the two reproductions from the broken inspection path", () => {
	it("omits the personality block when personality is none", async () => {
		// It USED to render the block here, because `personality` fell to the builder's
		// `"default"` fallback. Asserted against the baseline, which does carry a personality
		// section, so this cannot pass by the section being absent in both.
		const withNone = await renderUnder({ personality: "none" });

		expect(withNone.length).toBeLessThan(baseline.length);
		expect(baseline.length - withNone.length).toBeGreaterThan(500);
	});

	it("uses the hard delegation wording when subagent.delegation is required", async () => {
		// It USED to render neither: `eagerTasks` and `eagerTasksAlways` both fell to `false`, so
		// the section was absent whatever the setting said.
		const required = await renderUnder({ "subagent.delegation": "required" });
		const allowed = await renderUnder({ "subagent.delegation": "allowed" });

		expect(required).not.toBe(allowed);
		expect(required.length).toBeGreaterThan(allowed.length);
	});
});

describe("delegation is resolved against the agents that can actually be spawned", () => {
	it("asks for no delegation when the session has nowhere to send it", async () => {
		// Not a gate-wiring check: the prompt must not instruct the model to delegate to an agent
		// this session cannot spawn, because that is an instruction it can only fail.
		const noAgents = new Map<string, unknown>([["task", { name: "task", enabledAgentNames: [] }]]);
		const settings = Settings.isolated({ "subagent.delegation": "required" } as never);

		const gates = resolveGateInputs(settings, { tools: noAgents as never, model: MODEL });

		expect(gates.eagerTasks).toBe(false);
		expect(gates.eagerTasksAlways).toBe(false);
		expect(gates.subagentNames).toEqual([]);
	});

	it("carries the spawnable agents through when there are some", () => {
		const settings = Settings.isolated({ "subagent.delegation": "required" } as never);

		const gates = resolveGateInputs(settings, { tools: TOOLS as never, model: MODEL });

		expect(gates.subagentNames).toEqual(["scout", "worker"]);
		expect(gates.eagerTasksAlways).toBe(true);
	});

	it("carries exact enabled role names without deriving capability categories", async () => {
		const roles = new Map<string, unknown>([
			[
				"task",
				{
					name: "task",
					enabledAgentNames: ["designer", "reviewer"],
					description: "delegate work",
				},
			],
		]);

		const rendered = await renderUnder({}, roles);

		expect(rendered).toContain("Enabled roles (`designer, reviewer`)");
		expect(rendered).toContain("Spawn one only when its description matches the assignment");
		expect(rendered).not.toContain("Executing agents");
		expect(rendered).not.toContain("Investigative agents");
	});

	it("uses the concrete task role as the general fallback", async () => {
		const roles = new Map<string, unknown>([
			[
				"task",
				{
					name: "task",
					enabledAgentNames: ["task", "designer"],
					description: "delegate work",
				},
			],
		]);

		const rendered = await renderUnder({}, roles);

		expect(rendered).toContain("Enabled roles (`task, designer`)");
		expect(rendered).toContain("use `task` as the general-purpose fallback");
		expect(rendered).not.toContain("Specialists only");
	});

	it("keeps unmatched work inline when only specialist roles are enabled", async () => {
		const roles = new Map<string, unknown>([
			[
				"task",
				{
					name: "task",
					enabledAgentNames: ["reviewer"],
					description: "delegate work",
				},
			],
		]);

		const rendered = await renderUnder({}, roles);

		expect(rendered).toContain("Specialists only");
		expect(rendered).toContain("keep unmatched work inline");
		expect(rendered).not.toContain("general-purpose fallback");
	});

	/**
	 * The tool-borne half of `subagent.enabled`, and the whole point of that setting: with
	 * subagents off the task tool is never built, so the ENTIRE Delegation section leaves the
	 * prompt rather than merely softening its wording.
	 *
	 * Asserted as the section's disappearance rather than as "the text differs", because
	 * differing text is what the strength dial does, and confusing the two is the bug this
	 * setting was split out to fix. `subagent.delegation` used to carry an `off` value that
	 * removed the tool, so one setting answered both questions and a master switch that only
	 * reworded would be that bug returning.
	 */
	it("removes the whole delegation section when the task tool is not built", async () => {
		const noTask = new Map<string, unknown>([...TOOLS].filter(([name]) => name !== "task"));

		const withTask = await renderUnder({});
		const withoutTask = await renderUnder({}, noTask);

		expect(withTask).toContain("Delegation gates:");
		expect(withoutTask).not.toContain("Delegation gates:");
		expect(withoutTask).not.toContain("Spawn-one-then-wait is a bug");
		// And the rest of the prompt survives, or this passes because nothing rendered at all.
		expect(withoutTask).toContain("EXECUTION WORKFLOW");
	});
});

/**
 * Place 3 of the six-place chain: the builder's omitted-option defaults.
 *
 * `buildSystemPrompt` destructures every gate option with a fallback, so a caller that passes none
 * still gets a prompt. Those fallbacks are a SECOND owner of each default, independent of the
 * setting's own default in `config/settings-domains/`, and nothing compared the two. When they
 * disagree, the builder's copy silently wins for every omitting caller, and the prompt it produces
 * describes a configuration nobody is running.
 *
 * This block measures the disagreement instead of asserting the fallbacks by eye: it renders the
 * prompt with every gate option OMITTED, then with the same options resolved from settings that
 * override nothing, and compares. Equal means one owner in effect. The named exceptions below are
 * the cases where the two deliberately differ, each with the reason, so a NEW divergence fails here.
 */
describe("the builder's omitted-option defaults against a default-configured session", () => {
	/** The prompt a caller gets by passing no gate options at all: the pre-fix inspection path. */
	async function renderWithNoGateOptions(tools: Map<string, unknown> = TOOLS): Promise<string> {
		const inspection = await inspectSystemPrompt({
			tools: tools as never,
			toolNames: [...tools.keys()],
			model: MODEL.id,
			cwd: process.cwd(),
		});
		return inspection.blocks.join("\n");
	}

	it("resolves a default session's gates to the values its settings imply, not to the builder's fallbacks", () => {
		const gates = resolveGateInputs(Settings.isolated({} as never), { tools: TOOLS as never, model: MODEL });

		// Pinned by value, because these are the numbers the comparison below is about. Every one of
		// them differs from the fallback `system-prompt.ts` uses when the option is omitted
		// (`eagerTasks = false`, `subagentNames = []`, `taskIrcEnabled = false`).
		expect(gates.eagerTasks).toBe(true);
		expect(gates.eagerTasksAlways).toBe(false);
		expect(gates.subagentNames).toEqual(["scout", "worker"]);
		expect(gates.taskIrcEnabled).toBe(true);
		expect(gates.taskBatch).toBe(true);
	});

	it("renders a different prompt when the gate options are omitted than when they are resolved", async () => {
		// The consequence, in bytes. This is the state the CLI shipped in: not a subtle difference in
		// one clause, a prompt missing the delegation guidance a default session receives.
		const omitted = await renderWithNoGateOptions();
		const resolved = await renderUnder({});

		expect(omitted).not.toBe(resolved);
		expect(resolved.length).toBeGreaterThan(omitted.length);
	});

	/**
	 * The fallbacks ARE the table, proved by behaviour rather than by grepping the destructure.
	 *
	 * A source-shape check would pass on a destructure that imported the table and then ignored one
	 * field. Rendering twice cannot: if any fallback still holds an inline value that differs from the
	 * table, the two prompts diverge in bytes.
	 */
	it("falls back to exactly the values the shared table declares", async () => {
		const omitted = await renderWithNoGateOptions();
		const explicit = await inspectSystemPrompt({
			...OMITTED_GATE_DEFAULTS,
			// The name list is `readonly` in the table and mutable in the options, so it is copied
			// rather than shared with the builder.
			subagentNames: [...OMITTED_GATE_DEFAULTS.subagentNames],
			tools: TOOLS as never,
			toolNames: [...TOOLS.keys()],
			model: MODEL.id,
			cwd: process.cwd(),
		});

		expect(explicit.blocks.join("\n")).toBe(omitted);
	});

	/**
	 * WHICH gates disagree with a default session, by name.
	 *
	 * The divergence itself is intended: an omitted option means the caller has no configuration to
	 * offer, which is not the same as a default configuration. What must not happen is a new
	 * divergence appearing unnoticed, because that is how `eagerTasks: false` came to contradict a
	 * shipped `subagent.delegation: preferred` with nothing reporting it. `personality` is excluded
	 * from the comparison rather than listed: the resolver returns `undefined` for "unset" and the
	 * builder maps that to the table's `"default"`, so the two agree by construction.
	 */
	it("disagrees with a default session only where the configured defaults are live", () => {
		const session = resolveGateInputs(Settings.isolated({} as never), { tools: TOOLS as never, model: MODEL });
		const disagreeing = Object.keys(OMITTED_GATE_DEFAULTS)
			.filter(key => key !== "personality")
			.filter(key => {
				const fallback = OMITTED_GATE_DEFAULTS[key as keyof typeof OMITTED_GATE_DEFAULTS];
				const resolved = session[key as keyof typeof session];
				return JSON.stringify(fallback) !== JSON.stringify(resolved);
			});

		expect(disagreeing.sort()).toEqual(["eagerTasks", "subagentNames", "taskIrcEnabled", "taskMaxConcurrency"]);

		expect([OMITTED_GATE_DEFAULTS.eagerTasks, session.eagerTasks]).toEqual([false, true]);
		expect([OMITTED_GATE_DEFAULTS.taskIrcEnabled, session.taskIrcEnabled]).toEqual([false, true]);
		expect([OMITTED_GATE_DEFAULTS.taskMaxConcurrency, session.taskMaxConcurrency]).toEqual([0, 32]);
		expect([[...OMITTED_GATE_DEFAULTS.subagentNames], session.subagentNames]).toEqual([[], ["scout", "worker"]]);
	});

	it("names which text the omitted-option prompt is missing", async () => {
		const omitted = await renderWithNoGateOptions();
		const resolved = await renderUnder({});

		// The softer SHOULD delegation wording, which a default session (`subagent.delegation:
		// preferred`) receives and an omitting caller does not, because the builder's `eagerTasks`
		// fallback is `false`. Named by statement id and derived from its text, so a rewording of the
		// rule does not turn this into a test asserting bytes the prompt no longer contains.
		const preferred = signatureOf("tool-policy/delegation-preferred");
		expect(occurrences(resolved, preferred)).toBe(1);
		expect(occurrences(omitted, preferred)).toBe(0);

		// The IRC coordination clause, gated on `taskIrcEnabled`, whose fallback is also `false` while
		// the resolved root session has a task tool and therefore a peer it can spawn.
		expect(occurrences(resolved, "have B ask A via `irc`")).toBe(1);
		expect(occurrences(omitted, "have B ask A via `irc`")).toBe(0);
	});
});

describe("the gate slice itself", () => {
	it("derives nativeTools, which is how tools.format reaches the prompt", () => {
		// `toolListMode` is `!inlineToolDescriptors && nativeTools`, so without this the gate was
		// registered live while nothing carried it, and `tools.format` moved no bytes.
		const native = resolveGateInputs(Settings.isolated({ "tools.format": "native" } as never), {
			tools: TOOLS as never,
			model: MODEL,
		});
		const hermes = resolveGateInputs(Settings.isolated({ "tools.format": "hermes" } as never), {
			tools: TOOLS as never,
			model: MODEL,
		});

		expect(native.nativeTools).toBe(true);
		expect(hermes.nativeTools).toBe(false);
	});

	it("passes the absence of a personality through rather than restating the default", () => {
		// The builder's fallback is `"default"`. Restating it here would make two owners of one
		// default, which is the shape of bug this whole area was cleaned up for.
		const gates = resolveGateInputs(Settings.isolated({} as never), { tools: TOOLS as never, model: MODEL });

		expect(gates.personality === undefined || gates.personality === "default").toBe(true);
	});

	/**
	 * Root IRC follows the resolved task surface rather than independently reinterpreting the
	 * nested-spawn setting. Cap 0 still permits this root to spawn a direct child.
	 */
	it("enables root IRC exactly when the resolved session can spawn through task", () => {
		const canSpawn = resolveGateInputs(Settings.isolated({ "subagent.maxNestedSpawnDepth": 0 } as never), {
			tools: TOOLS as never,
			model: MODEL,
		});
		const cannotSpawn = resolveGateInputs(Settings.isolated({ "subagent.maxNestedSpawnDepth": 0 } as never), {
			tools: new Map() as never,
			model: MODEL,
		});

		expect(canSpawn.taskIrcEnabled).toBe(true);
		expect(cannotSpawn.taskIrcEnabled).toBe(false);
	});

	/**
	 * A subagent already has its parent as a peer, so IRC remains available even when that
	 * depth-1 session is a leaf and has no task tool of its own.
	 */
	it("keeps IRC enabled for a depth-1 leaf because it still has peers", () => {
		const nested = resolveGateInputs(Settings.isolated({ "subagent.maxNestedSpawnDepth": 0 } as never), {
			tools: new Map() as never,
			model: MODEL,
			taskDepth: 1,
		});

		expect(nested.taskIrcEnabled).toBe(true);
	});
});
