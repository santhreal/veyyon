/**
 * WHY. Templates compile with Handlebars `strict: false`, so a renamed or misspelled variable
 * renders as the empty string: `{{working_dir}}` against a context carrying `workingDir` produces a
 * prompt that is quietly shorter, with nothing thrown, nothing logged, and no test red unless one
 * asserts the exact bytes. This module is the check that turns that silence into a failure, and no
 * test named it — so the check that exists to stop silent holes could itself have gone silent.
 *
 * Its whole value rests on one distinction: a name that is PRINTED is required, and a name that is
 * only TESTED is optional, because a disabled feature is a designed state rather than a defect.
 * Every way that line can move is a defect with a different signature. Widen it and a template full
 * of optional regions demands variables no caller has, failing the build for features that are off.
 * Narrow it and the module returns to reporting nothing, which looks exactly like working.
 *
 * The class this closes: guard attribution (self-guard, nested guards, several sites, the `else`
 * arm, `unless`, subexpression and hash arguments), scope attribution inside a rescoping block and
 * the two ways out of one, helper calls misread as context reads, Handlebars' notion of truth as
 * opposed to JavaScript's, and the loudness of the failure itself.
 *
 * What it does not catch: whether a template's guards match the author's intent, and whether a
 * caller's value is the RIGHT value rather than merely present.
 */
import { describe, expect, it } from "bun:test";
import {
	analyzeTemplate,
	assertTemplateContext,
	findMissingTemplateVariables,
	MissingTemplateVariableError,
} from "../src/prompt-variables";

/** Required roots with the guard sets under which each actually prints. */
function required(template: string, helperNames?: readonly string[]): Record<string, readonly (readonly string[])[]> {
	const analysis = analyzeTemplate(template, helperNames ? { helperNames } : {});
	const out: Record<string, readonly (readonly string[])[]> = {};
	for (const variable of analysis.required) out[variable.name] = variable.requiredWhen;
	return out;
}

function optional(template: string, helperNames?: readonly string[]): string[] {
	return analyzeTemplate(template, helperNames ? { helperNames } : {}).optional.map(variable => variable.name);
}

function missing(template: string, context: Record<string, unknown>): string[] {
	return findMissingTemplateVariables(template, context).map(variable => variable.name);
}

describe("what a template requires", () => {
	it("requires a name it prints and records every path it reads through it", () => {
		const analysis = analyzeTemplate("{{a.b}} {{a.c}}");

		expect(analysis.required).toEqual([
			{ name: "a", use: "interpolated", paths: ["a.b", "a.c"], requiredWhen: [[]] },
		]);
		expect(analysis.optional).toEqual([]);
	});

	it("treats a name the enclosing block tests as the author declaring it optional", () => {
		expect(required("{{#if p}}{{p}}{{/if}}")).toEqual({});
		expect(optional("{{#if p}}{{p}}{{/if}}")).toEqual(["p"]);
	});

	it("requires a guarded name only when its guard holds", () => {
		expect(required("{{#if a}}{{b}}{{/if}}")).toEqual({ b: [["a"]] });
		expect(optional("{{#if a}}{{b}}{{/if}}")).toEqual(["a"]);
	});

	it("accumulates nested guards, so the inner name needs both", () => {
		expect(required("{{#if a}}{{#if b}}{{c}}{{/if}}{{/if}}")).toEqual({ c: [["a", "b"]] });
	});

	it("keeps one alternative per site, because any one of them can print", () => {
		expect(required("{{#if a}}{{b}}{{/if}}{{#if c}}{{b}}{{/if}}")).toEqual({ b: [["a"], ["c"]] });
	});

	it("collapses repeated sites that share a guard", () => {
		expect(required("{{#if a}}{{b}}{{/if}}{{#if a}}{{b}}{{/if}}")).toEqual({ b: [["a"]] });
	});

	it("drops every condition once one site prints unconditionally", () => {
		// The name renders no matter what, so there is nothing left to condition on.
		expect(required("{{#if a}}{{b}}{{/if}}{{b}}")).toEqual({ b: [[]] });
	});

	it("does not extend the guard to the else arm, which runs when the test failed", () => {
		expect(required("{{#if a}}x{{else}}{{b}}{{/if}}")).toEqual({ b: [[]] });
	});

	it("does not treat unless as a guard, since its body runs when the test is falsy", () => {
		expect(required("{{#unless a}}{{b}}{{/unless}}")).toEqual({ b: [[]] });
	});
});

describe("scope inside a rescoping block", () => {
	it("attributes a bare name to the item rather than demanding it from the context", () => {
		expect(required("{{#each items}}{{name}}{{/each}}")).toEqual({});
		expect(optional("{{#each items}}{{name}}{{/each}}")).toEqual(["items"]);
	});

	it("attributes a name that climbs out to the context, guarded by the block", () => {
		expect(required("{{#each items}}{{../outer}}{{/each}}")).toEqual({ outer: [["items"]] });
	});

	it("attributes an explicit root reach to the context", () => {
		expect(required("{{#each items}}{{@root.top}}{{/each}}")).toEqual({ top: [["items"]] });
	});

	it("asks the context for nothing on behalf of a builtin", () => {
		expect(required("{{#each items}}{{this}}{{@index}}{{/each}}")).toEqual({});
	});
});

describe("helper calls as opposed to context reads", () => {
	it("tests a helper's arguments rather than printing them", () => {
		expect(required('{{has tools "lsp"}}')).toEqual({});
		expect(optional('{{has tools "lsp"}}')).toEqual(["tools"]);
	});

	it("reads a name inside a subexpression as a test, and guards the body with it", () => {
		expect(required('{{#if (eq mode "x")}}{{y}}{{/if}}')).toEqual({ y: [["mode"]] });
	});

	it("reads a hash argument as a test", () => {
		expect(optional("{{#list items limit=cap}}z{{/list}}").sort()).toEqual(["cap", "items"]);
	});

	it("asks for nothing when a bare mustache names a registered helper", () => {
		// The renderer uses a private instance carrying helpers the global does not have; reading
		// the wrong registry would demand a caller supply the helper's name as data.
		expect(required("{{brand}}", ["brand"])).toEqual({});
		expect(optional("{{brand}}", ["brand"])).toEqual([]);
	});

	it("requires the same bare mustache when no such helper is registered", () => {
		expect(required("{{brand}}")).toEqual({ brand: [[]] });
	});
});

describe("what counts as supplied", () => {
	it("counts null as missing alongside undefined, since both render as nothing", () => {
		expect(missing("{{a}}", { a: null })).toEqual(["a"]);
		expect(missing("{{a}}", {})).toEqual(["a"]);
	});

	it("counts an empty string as supplied, because the caller chose it", () => {
		expect(missing("{{a}}", { a: "" })).toEqual([]);
	});

	it("reports nothing for a guarded name whose feature is off", () => {
		expect(missing("{{#if a}}{{b}}{{/if}}", { a: false })).toEqual([]);
		expect(missing("{{#if a}}{{b}}{{/if}}", {})).toEqual([]);
	});

	it("reports the hole once the guard holds", () => {
		expect(missing("{{#if a}}{{b}}{{/if}}", { a: true })).toEqual(["b"]);
	});

	it("reads an empty array as falsy, the way the template's own if does", () => {
		// The templates lean on `{{#if skills.length}}` constantly. JavaScript truthiness would
		// call "no skills" a reached block and demand a variable nothing prints.
		expect(missing("{{#if a}}{{b}}{{/if}}", { a: [] })).toEqual([]);
		expect(missing("{{#if a}}{{b}}{{/if}}", { a: [1] })).toEqual(["b"]);
	});

	it("reads zero and the empty string as falsy guards", () => {
		expect(missing("{{#if a}}{{b}}{{/if}}", { a: 0 })).toEqual([]);
		expect(missing("{{#if a}}{{b}}{{/if}}", { a: "" })).toEqual([]);
	});
});

describe("the failure a hole produces", () => {
	it("names the variable, the label, and the nearest key the caller did pass", () => {
		let caught: unknown;
		try {
			assertTemplateContext("{{working_dir}}", { workingDir: "/x" }, "system prompt");
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(MissingTemplateVariableError);
		if (!(caught instanceof MissingTemplateVariableError)) throw new Error("expected the typed error");
		expect(caught.missing).toEqual(["working_dir"]);
		expect(caught.message).toContain("in system prompt");
		expect(caught.message).toContain("`working_dir`");
		expect(caught.message).toContain("did you mean `workingDir`?");
		expect(caught.message).toContain("Context provides: `workingDir`.");
	});

	it("offers no suggestion when nothing the caller passed is close", () => {
		let caught: unknown;
		try {
			assertTemplateContext("{{zzz}}", { totallyUnrelated: 1 });
		} catch (error) {
			caught = error;
		}

		if (!(caught instanceof MissingTemplateVariableError)) throw new Error("expected the typed error");
		expect(caught.message).not.toContain("did you mean");
		expect(caught.message).toContain("`zzz`");
	});

	it("says so plainly when the context is empty", () => {
		let caught: unknown;
		try {
			assertTemplateContext("{{a}}", {});
		} catch (error) {
			caught = error;
		}

		if (!(caught instanceof MissingTemplateVariableError)) throw new Error("expected the typed error");
		expect(caught.message).toContain("Context provides: (nothing).");
	});

	it("passes silently when every required name is supplied", () => {
		expect(assertTemplateContext("{{a}}{{#if b}}{{c}}{{/if}}", { a: 1 })).toBeUndefined();
	});
});
