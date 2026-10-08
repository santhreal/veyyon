/**
 * The string bytes equal texts leave live when each passes through `internString` or `render`, or is
 * held as built, measured in the process that runs this file. The test imports the constants. Run as a
 * script, it prints, as JSON, the string bytes each arm left live while `COPIES` results stayed
 * referenced.
 *
 * Arms: `plain` holds separately built equal texts; `interned` holds them through `internString`;
 * `dropped` interns `COPIES` distinct texts and holds none; `renderWithVariables` and `renderStatic`
 * hold equal renders of a template with variables and of one without.
 */
import { render } from "../../src/prompt";
import { internString } from "../../src/strings";
import { liveStringBytes } from "../helpers/live-string-bytes";

export const COPIES = 40;
export const CHARS = 64 * 1024;

export interface InternGrowth {
	plain: number;
	interned: number;
	dropped: number;
	renderWithVariables: number;
	renderStatic: number;
}

/** Prompt-shaped text, ten words to a line, built at run time so each call returns a distinct flat string. */
function build(tag: string): string {
	const parts: string[] = [];
	let length = 0;
	for (let i = 0; length < CHARS; i++) {
		const word = `${tag}-${i % 97}${i % 10 === 9 ? "\n" : " "}`;
		parts.push(word);
		length += word.length;
	}
	return parts.join("");
}

/**
 * String bytes left live while `make` produces {@link COPIES} strings that stay referenced. A
 * discarded pass first takes the template compile, JIT tier-up and every other first-call cache out
 * of the baseline.
 */
async function heldBy(make: () => string): Promise<number> {
	const first = make();
	for (let i = 0; i < COPIES; i++) make();
	const before = await liveStringBytes();
	const held: string[] = [];
	for (let i = 0; i < COPIES; i++) held.push(make());
	const grown = (await liveStringBytes()) - before;
	if (!held.every(text => text === first)) throw new Error("an arm produced texts that are not equal");
	return grown;
}

/** String bytes left live after {@link COPIES} distinct texts are interned and every one is dropped. */
async function droppedAfterInterning(): Promise<number> {
	const before = await liveStringBytes();
	let length = 0;
	for (let i = 0; i < COPIES; i++) length += internString(build(`dropped-${i}`)).length;
	const grown = (await liveStringBytes()) - before;
	if (length < COPIES * CHARS) throw new Error(`interned ${length} characters, expected at least ${COPIES * CHARS}`);
	return grown;
}

export async function measure(): Promise<InternGrowth> {
	const body = build("rendered");
	const template = build("static");
	return {
		plain: await heldBy(() => build("section")),
		interned: await heldBy(() => internString(build("section"))),
		dropped: await droppedAfterInterning(),
		renderWithVariables: await heldBy(() => render("{{heading}}\n\n{{body}}", { heading: "PROJECT", body })),
		renderStatic: await heldBy(() => render(template)),
	};
}

if (import.meta.main) {
	process.stdout.write(`${JSON.stringify(await measure())}\n`);
}
