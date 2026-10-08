/**
 * The string bytes live agents holding the provider-bound copy of one shared tool leave live, measured
 * in the process that runs this file. The test imports the constants. Run as a script, it prints, as
 * JSON, the string bytes each arm left live while `AGENTS` of its results stayed referenced.
 *
 * Every agent owns an `AppendOnlyContextManager` whose stable prefix holds the tool list
 * `normalizeTools` built for it. Arms: `plain` holds separately built texts the size of the description
 * with no agent; every other arm is a way `normalizeTools` builds a description, one per entry of
 * `DIALECTS` plus no dialect and pruning, holding `AGENTS` prefixes built that way.
 */
import { AppendOnlyContextManager, type BuildOptions } from "@veyyon/agent-core/append-only-context";
import type { AgentTool } from "@veyyon/agent-core/types";
import { DIALECTS } from "@veyyon/catalog/identity";
import { type } from "arktype";
import { liveStringBytes } from "../../../utils/test/helpers/live-string-bytes";

export const AGENTS = 40;
export const CHARS = 16 * 1024;

export interface Held {
	/** String bytes the arm left live. */
	grown: number;
	/** The description holds the tool's text followed by more: an examples block was appended. */
	appended: boolean;
}

export interface DescriptionGrowth {
	plain: number;
	ways: Record<string, Held>;
}

/** The tool's description: one string every agent's tool shares, as a rendered prompt is. */
const DESCRIPTION = (() => {
	const parts: string[] = [];
	let length = 0;
	for (let i = 0; length < CHARS; i++) {
		const word = `reads-${i % 97}${i % 10 === 9 ? "\n" : " "}`;
		parts.push(word);
		length += word.length;
	}
	return parts.join("");
})();

const parameters = type({ path: type("string").describe("file to read") });
const EXAMPLES = [{ caption: "Read a file", call: { path: "src/app.ts" } }];

/** A tool instance of this agent's own, sharing the description, schema and examples of every other. */
function tool(): AgentTool<typeof parameters, { path: string }> {
	return {
		name: "read",
		label: "Read",
		description: DESCRIPTION,
		parameters,
		examples: EXAMPLES,
		async execute() {
			return { content: [{ type: "text", text: "ok" }] };
		},
	};
}

/** One agent's prefix, built over a tool list of its own, as each spawned agent builds one. */
function prefix(options: BuildOptions): AppendOnlyContextManager {
	const manager = new AppendOnlyContextManager();
	manager.build({ systemPrompt: [], messages: [], tools: [tool()] }, options);
	return manager;
}

function description(manager: AppendOnlyContextManager): string {
	const [only] = manager.prefix.toContext().tools;
	if (!only) throw new Error("a prefix holds no tool");
	return only.description;
}

/**
 * String bytes left live while {@link AGENTS} prefixes built with `options` stay referenced. A
 * discarded pass first takes the schema conversion, dialect load and every other first-call cache
 * out of the baseline.
 */
async function heldBy(options: BuildOptions): Promise<Held> {
	const expected = description(prefix(options));
	for (let i = 0; i < AGENTS; i++) prefix(options);
	const before = await liveStringBytes();
	const held: AppendOnlyContextManager[] = [];
	for (let i = 0; i < AGENTS; i++) held.push(prefix(options));
	const grown = (await liveStringBytes()) - before;
	if (!held.every(manager => description(manager) === expected)) {
		throw new Error("an arm holds a description that is not equal");
	}
	return { grown, appended: expected.length > DESCRIPTION.length && expected.startsWith(DESCRIPTION) };
}

/** String bytes left live while {@link AGENTS} separately built texts the size of the description stay referenced. */
async function plain(): Promise<number> {
	const before = await liveStringBytes();
	const held: string[] = [];
	for (let i = 0; i < AGENTS; i++) held.push([DESCRIPTION, "examples"].join("\n\n"));
	const grown = (await liveStringBytes()) - before;
	if (held.length !== AGENTS) throw new Error("the plain arm dropped a text");
	return grown;
}

export async function measure(): Promise<DescriptionGrowth> {
	const ways: Record<string, Held> = {
		"no dialect": await heldBy({ intentTracing: true }),
		pruned: await heldBy({ intentTracing: true, pruneToolDescriptions: true }),
	};
	for (const dialect of DIALECTS) {
		ways[`the ${dialect} dialect`] = await heldBy({ intentTracing: true, exampleDialect: dialect });
	}
	return { plain: await plain(), ways };
}

if (import.meta.main) {
	process.stdout.write(`${JSON.stringify(await measure())}\n`);
}
