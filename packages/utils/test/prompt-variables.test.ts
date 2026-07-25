/**
 * SYSPROMPT-1: a prompt template must never silently render a hole.
 *
 * Templates compile with Handlebars `strict: false`, so before this analyzer
 * existed `render("dir={{working_dir}}", { workingDir: "/tmp" })` returned
 * `"dir="` — no throw, no log, no failing test unless one happened to assert
 * the exact bytes. Renaming a caller's field or mistyping a variable therefore
 * shipped a quietly shorter prompt to every user, which is invisible in
 * production and unattributable afterwards.
 *
 * The fix cannot be Handlebars' own strict mode, because these prompts are
 * built almost entirely out of regions that are SUPPOSED to vanish
 * (`{{#if secretsEnabled}}`, `{{#has tools "lsp"}}`), and blanket strictness
 * turns every disabled feature into a crash. So the analyzer draws the line
 * between a name the template PRINTS (absent means a hole, always a bug) and a
 * name it only TESTS (absent means off, by design) — and then, because printed
 * names are usually printed under a guard, records the conditions under which
 * printing actually happens so the check can be evaluated against a real
 * context rather than in the abstract.
 *
 * These suites pin all three parts: the classification, the guard reasoning,
 * and the scope tracking that keeps `{{#each}}` item fields from being blamed
 * on the root context. Each one is a way the analyzer could be wrong in a
 * direction that matters: too lax and the original silent hole comes back, too
 * strict and it fails builds over variables that were correctly optional.
 */
import { describe, expect, it } from "bun:test";
import { analyzePromptTemplate, assertPromptContext, MissingTemplateVariableError, render } from "@veyyon/utils/prompt";

/** Root names the analyzer calls required, sorted for stable comparison. */
function required(template: string): string[] {
	return analyzePromptTemplate(template)
		.required.map(v => v.name)
		.sort();
}

/** Root names the analyzer calls optional, sorted for stable comparison. */
function optional(template: string): string[] {
	return analyzePromptTemplate(template)
		.optional.map(v => v.name)
		.sort();
}

describe("classifying a reference as printed or merely tested", () => {
	it("calls a bare interpolation required", () => {
		// The whole point: `{{name}}` writes into the output, so a context without
		// it produces text with a gap where a value belonged.
		expect(required("Hello {{name}}")).toEqual(["name"]);
		expect(optional("Hello {{name}}")).toEqual([]);
	});

	it("calls a block condition optional", () => {
		// `{{#if x}}` never prints x. Absent means the region is off, which is the
		// designed state for every feature-gated section in the real prompts.
		expect(required("{{#if secretsEnabled}}redaction is on{{/if}}")).toEqual([]);
		expect(optional("{{#if secretsEnabled}}redaction is on{{/if}}")).toEqual(["secretsEnabled"]);
	});

	it("calls a helper argument optional", () => {
		// Arguments are consumed by the helper, not printed raw. `{{join list}}`
		// with no list renders "" by the helper's own contract, not by a hole.
		expect(required('{{join items ", "}}')).toEqual([]);
		expect(optional('{{join items ", "}}')).toEqual(["items"]);
	});

	it("treats the value a helper RETURNS as printed without requiring its arguments", () => {
		// The distinction is about who produces the empty string. A missing
		// argument is the helper's documented fallback; a missing interpolation is
		// a hole. Conflating them would make every `{{default x "none"}}` a
		// required variable, which defeats the helper's purpose.
		expect(required('{{default nickname "friend"}}')).toEqual([]);
	});

	it("records the full dotted path, not just the root it looks up", () => {
		// The context is keyed by root, so the check is too — but an error naming
		// only `toolRefs` would not tell you WHICH of thirteen reads broke.
		const analysis = analyzePromptTemplate("{{toolRefs.grep}} and {{toolRefs.read}}");

		expect(analysis.required).toHaveLength(1);
		expect(analysis.required[0]?.name).toBe("toolRefs");
		expect(analysis.required[0]?.paths).toEqual(["toolRefs.grep", "toolRefs.read"]);
	});

	it("ignores builtins and @data variables, which never come from the context", () => {
		// Demanding `@index` or `this` of a caller would be unsatisfiable: nothing
		// a caller can put on the context object provides them.
		expect(required("{{#each items}}{{@index}}: {{this}}{{/each}}")).toEqual([]);
	});
});

describe("a name printed under a guard", () => {
	it("is optional when the guard tests the name itself", () => {
		// `{{#if personality}}{{personality}}{{/if}}` is the author saying this one
		// is optional. Calling it required would fail every caller who has no
		// personality configured, which is the default.
		expect(required("{{#if personality}}{{personality}}{{/if}}")).toEqual([]);
		expect(optional("{{#if personality}}{{personality}}{{/if}}")).toEqual(["personality"]);
	});

	it("stays required when the guard tests a DIFFERENT name", () => {
		// `{{#if intentTracing}}{{intentField}}{{/if}}` really does need
		// intentField — but only when tracing is on. It is required, conditionally,
		// and the condition is recorded rather than discarded.
		const analysis = analyzePromptTemplate("{{#if intentTracing}}Use {{intentField}}{{/if}}");

		expect(analysis.required.map(v => v.name)).toEqual(["intentField"]);
		expect(analysis.required[0]?.requiredWhen).toEqual([["intentTracing"]]);
	});

	it("records every enclosing guard, not only the innermost", () => {
		// Nested gates all have to open before the reference is reached. Recording
		// only the nearest one would demand the variable in configurations that
		// cannot reach it.
		const analysis = analyzePromptTemplate("{{#if a}}{{#if b}}{{value}}{{/if}}{{/if}}");

		expect(analysis.required[0]?.requiredWhen).toEqual([["a", "b"]]);
	});

	it("does not carry the guard into the else arm, which runs when it was absent", () => {
		// The `{{else}}` branch executes precisely when the tested value was
		// falsy, so treating it as guarded by that value would be backwards: the
		// reference inside it is reachable exactly when the guard failed.
		const analysis = analyzePromptTemplate("{{#if toolListMode}}list{{else}}{{toolInventory}}{{/if}}");

		expect(analysis.required.map(v => v.name)).toEqual(["toolInventory"]);
		expect(analysis.required[0]?.requiredWhen).toEqual([[]]);
	});

	it("collapses to unconditional when the name is also printed unguarded", () => {
		// One unguarded print makes the guarded ones irrelevant: it renders no
		// matter what the context says, so there is nothing left to condition on.
		const analysis = analyzePromptTemplate("{{value}} {{#if flag}}{{value}}{{/if}}");

		expect(analysis.required[0]?.requiredWhen).toEqual([[]]);
	});

	it("keeps alternative guard sets separate when a name prints in two places", () => {
		// Either region can render, so either condition makes the variable
		// required. Merging them into one set would demand both features be on.
		const analysis = analyzePromptTemplate("{{#if a}}{{v}}{{/if}}{{#if b}}{{v}}{{/if}}");

		expect(analysis.required[0]?.requiredWhen).toEqual([["a"], ["b"]]);
	});
});

describe("scope tracking inside iterating blocks", () => {
	it("does not blame the root context for an item's fields", () => {
		// Inside `{{#each skills}}`, `{{name}}` reads the skill's name. Attributing
		// it to the root would invent a required variable no caller could satisfy,
		// and this exact shape appears in the shipped system prompt.
		expect(required("{{#each skills}}- {{name}}: {{description}}{{/each}}")).toEqual([]);
		expect(optional("{{#each skills}}- {{name}}: {{description}}{{/each}}")).toEqual(["skills"]);
	});

	it("applies the same rule to the custom iterating helpers", () => {
		// `list` and `table` rescope exactly like `each` because they call
		// `options.fn(item)`. A version of this check that knew only about `each`
		// would demand `this` of the caller for every `{{#list}}` in the prompts.
		expect(required('{{#list globs join=", "}}{{this}}{{/list}}')).toEqual([]);
		expect(required('{{#table rows headers="a|b"}}{{cell}}{{/table}}')).toEqual([]);
	});

	it("still attributes a ../ climb to the root context", () => {
		// Climbing out of the item scope is a real root read and has to stay
		// checked, or an `{{#each}}` block becomes a blind spot.
		expect(required("{{#each items}}{{../heading}}{{/each}}")).toEqual(["heading"]);
	});

	it("still attributes an @root read to the root context", () => {
		// The other way out of a rescoped block. Same reasoning as `../`.
		expect(required("{{#each items}}{{@root.heading}}{{/each}}")).toEqual(["heading"]);
	});

	it("does not rescope for a block helper that preserves context", () => {
		// `has`, `if`, `when` and friends call `options.fn(this)`, so their bodies
		// still read the root. Treating them as rescoping would silently drop every
		// check inside `{{#has tools "lsp"}}` — which is where most of the shipped
		// prompt's interpolations live.
		expect(required('{{#has tools "lsp"}}Use {{toolRefs.lsp}}{{/has}}')).toEqual(["toolRefs"]);
	});
});

describe("rendering refuses to leave a hole", () => {
	it("throws on the exact typo that motivated this, instead of rendering an empty string", () => {
		// The original defect, verbatim. Before the fix this returned "dir=".
		expect(() => render("dir={{working_dir}}", { workingDir: "/tmp" })).toThrow(MissingTemplateVariableError);
	});

	it("names the missing variable and suggests the near miss", () => {
		// A rename or a typo is the overwhelmingly common cause, so the message has
		// to make the fix obvious without opening the template.
		try {
			render("dir={{working_dir}}", { workingDir: "/tmp" });
			throw new Error("expected the missing variable to throw");
		} catch (error) {
			const message = (error as Error).message;
			expect(message).toContain("`working_dir`");
			expect(message).toContain("did you mean `workingDir`?");
			expect(message).toContain("Context provides: `workingDir`");
		}
	});

	it("includes the label so the failing template is identifiable", () => {
		// The stack runs through the render machinery and never says which of the
		// 143 templates failed.
		expect(() => render("{{x}}", {}, { label: "system/system-prompt.md" })).toThrow(/in system\/system-prompt\.md/);
	});

	it("treats null the same as absent, because both render empty", () => {
		// An upstream lookup that returned nothing leaves the identical hole. A
		// check that accepted null would pass on exactly that case.
		expect(() => render("{{name}}", { name: null })).toThrow(MissingTemplateVariableError);
	});

	it("renders normally when the context is complete", () => {
		// The control. A guard that rejected everything would satisfy every
		// assertion above while breaking the product outright.
		expect(render("Hello {{name}}", { name: "world" })).toBe("Hello world");
	});

	it("leaves an unreached conditional variable alone", () => {
		// The case blanket strictness gets wrong. Tracing is off, so nothing prints
		// intentField and demanding it would fail a perfectly valid render.
		expect(render("{{#if intentTracing}}Use {{intentField}}{{/if}}", { intentTracing: false })).toBe("");
	});

	it("demands the same variable once the guard opens", () => {
		// The differential proving the test above is not just permissiveness: turn
		// the feature on and the requirement appears.
		expect(() => render("{{#if intentTracing}}Use {{intentField}}{{/if}}", { intentTracing: true })).toThrow(
			MissingTemplateVariableError,
		);
	});

	it("reads an empty array as a closed guard, the way Handlebars does", () => {
		// `{{#if toolInfo.length}}` is falsy for `[]` in Handlebars but truthy
		// under plain JS `!!`. Using JS truthiness would demand a variable from a
		// block that can never run, and this shape is all over the real prompts.
		expect(render("{{#if skills.length}}{{heading}}{{/if}}", { skills: [] })).toBe("");
	});

	it("can be bypassed explicitly for a piecemeal render", () => {
		// The opt-out exists for multi-pass rendering, and is greppable precisely
		// because the old behaviour was this with no marker at all.
		expect(render("dir={{working_dir}}", { workingDir: "/tmp" }, { allowMissing: true })).toBe("dir=");
	});
});

describe("assertPromptContext on this module's dialect", () => {
	it("parses a template containing a literal brace run after a helper close", () => {
		// `{{x}}}` only parses after `disambiguateClosingBraces`, so an analyzer
		// handed the raw source throws a parse error on a template that compiles
		// perfectly well. Pinned because routing the analyzer around that transform
		// is an easy mistake to make.
		expect(() => assertPromptContext("{del:{{href}}}", { href: "/x" })).not.toThrow();
	});

	it("does not mistake a zero-argument helper for a context variable", () => {
		// Helpers live on a private Handlebars instance, so an analyzer reading the
		// global registry would see `{{arg 1}}`-style names as variables and demand
		// them of every caller.
		expect(required("{{arg 1}}")).toEqual([]);
	});
});
