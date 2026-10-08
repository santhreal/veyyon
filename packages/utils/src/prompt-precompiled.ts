/**
 * Prompt templates the binary build compiled ahead of time.
 *
 * The binary build loads every `.md` import through a bundler plugin
 * (`packages/coding-agent/scripts/precompiled-prompts.ts`). For a file that holds a Handlebars
 * mustache, the plugin emits a module that registers the file's text here with its precompiled
 * template specification and its variable analysis, both produced by `precompileTemplate` in
 * `prompt.ts`. On the first render of a registered text, `prompt.ts` revives the specification
 * instead of parsing and compiling the template, and adopts the analysis instead of walking the
 * template's syntax tree. A run from source registers nothing, and every template compiles on its
 * first render.
 *
 * Both halves are thunks, so a template that is never rendered builds neither object. This module
 * imports nothing that runs, because every prompt module in the binary imports it.
 */
import type { TemplateVariables } from "./prompt-variables";

/**
 * One precompiled template: the object `Handlebars.precompile` emitted, which `Handlebars.template`
 * revives into a render function, and the analysis of the variables the template reads.
 */
export interface PrecompiledTemplate {
	readonly spec: () => object;
	readonly variables: () => TemplateVariables;
}

/** Keyed on the template text the `.md` import yields, which is the string callers pass to render. */
const precompiledTemplates = new Map<string, PrecompiledTemplate>();

/** Register a template the build precompiled. Called by the modules the binary build emits for `.md` imports. */
export function registerPrecompiledTemplate(
	source: string,
	spec: () => object,
	variables: () => TemplateVariables,
): void {
	precompiledTemplates.set(source, { spec, variables });
}

/** The precompiled form of `source`, or `undefined` when the build did not register it. */
export function precompiledTemplate(source: string): PrecompiledTemplate | undefined {
	return precompiledTemplates.get(source);
}
