/**
 * Renders every template it is handed and reports, per template, the analysis `prompt.ts` holds for
 * it, each render's outcome, and how many Handlebars parses all of that cost.
 *
 * Driven by `test/a-prompt-template-the-binary-precompiled-renders-without-a-parse.test.ts`, whose
 * generated entry imports every template and passes the imported texts to {@link runProbe}. The
 * entry runs twice: compiled with the binary build's prompt plugin, and from source.
 */
import * as fs from "node:fs";
import * as prompt from "@veyyon/utils/prompt";
import { precompiledTemplate } from "@veyyon/utils/prompt-precompiled";
import Handlebars from "handlebars";

/** What the suite asks of each arm, read from a JSON file so both arms receive the same bytes. */
export interface ProbeInput {
	/** Contexts to render each template against, by template key. */
	readonly contexts: Record<string, Record<string, unknown>[]>;
	/** A helper to register once the sweep is done, and the template and context to render after it. */
	readonly lateHelper: { readonly key: string; readonly name: string; readonly context: Record<string, unknown> };
}

export interface RenderOutcome {
	readonly text?: string;
	readonly error?: string;
}

export interface TemplateReport {
	/** Whether the build registered the template under the text its import yields. */
	readonly registered: boolean;
	readonly parses: number;
	readonly analysis: prompt.TemplateVariables;
	readonly outcomes: RenderOutcome[];
}

export interface ProbeReport {
	readonly templates: Record<string, TemplateReport>;
	readonly lateHelper: RenderOutcome;
}

let parses = 0;
/** The one parser every Handlebars compile and analysis runs; `handlebars`' declarations omit it. */
const parser = (Handlebars as unknown as { Parser: { parse(input: string): unknown } }).Parser;
const parse = parser.parse;
parser.parse = function (this: unknown, input: string): unknown {
	parses++;
	return parse.call(this, input);
};

function outcome(render: () => string): RenderOutcome {
	try {
		return { text: render() };
	} catch (error) {
		return { error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
	}
}

/** Sweep `templates`, then register the late helper and render its template; print the report as JSON. */
export function runProbe(templates: Record<string, string>, inputPath: string): void {
	const input = JSON.parse(fs.readFileSync(inputPath, "utf8")) as ProbeInput;
	const reports: Record<string, TemplateReport> = {};
	for (const [key, template] of Object.entries(templates)) {
		const registered = precompiledTemplate(template) !== undefined;
		const before = parses;
		const analysis = prompt.analyzePromptTemplate(template);
		const outcomes = [outcome(() => prompt.render(template, {}, { allowMissing: true }))];
		for (const context of input.contexts[key] ?? []) outcomes.push(outcome(() => prompt.render(template, context)));
		reports[key] = { registered, parses: parses - before, analysis, outcomes };
	}
	const late = input.lateHelper;
	prompt.registerHelper(late.name, () => "LATE-HELPER");
	const lateHelper = outcome(() => prompt.render(templates[late.key]!, late.context));
	const report: ProbeReport = { templates: reports, lateHelper };
	process.stdout.write(JSON.stringify(report));
}
