/**
 * The string bytes live agents holding an equal system prompt section leave live, measured in the
 * process that runs this file. The test imports the constants. Run as a script, it prints, as JSON,
 * the string bytes each arm left live while `AGENTS` of its results stayed referenced.
 *
 * Arms: `plain` holds separately built equal sections with no agent; every other arm is a way a system
 * prompt reaches an agent, holding `AGENTS` agents built that way.
 */
import { Agent } from "@veyyon/agent-core";
import { liveStringBytes } from "../../../utils/test/helpers/live-string-bytes";

export const AGENTS = 40;
export const CHARS = 64 * 1024;

/** Every way a system prompt reaches an agent, by the name the fixture prints it under. */
export const WAYS = ["initial state", "setSystemPrompt with parts", "setSystemPrompt with one string"] as const;
export type Way = (typeof WAYS)[number];

export type PromptGrowth = Record<Way | "plain", number>;

/** An equal section, ten words to a line, built at run time as a distinct flat string. */
function section(): string {
	const parts: string[] = [];
	let length = 0;
	for (let i = 0; length < CHARS; i++) {
		const word = `conventions-${i % 97}${i % 10 === 9 ? "\n" : " "}`;
		parts.push(word);
		length += word.length;
	}
	return parts.join("");
}

const MAKE: Record<Way, () => Agent> = {
	"initial state": () => new Agent({ initialState: { systemPrompt: [section()] } }),
	"setSystemPrompt with parts": () => {
		const agent = new Agent();
		agent.setSystemPrompt([section()]);
		return agent;
	},
	"setSystemPrompt with one string": () => {
		const agent = new Agent();
		agent.setSystemPrompt(section());
		return agent;
	},
};

/**
 * String bytes left live while `make` produces {@link AGENTS} values that stay referenced, each
 * holding the section as `text` reads it. A discarded pass first takes every first-call cache out of
 * the baseline.
 */
async function heldBy<T>(make: () => T, text: (value: T) => string | undefined): Promise<number> {
	const expected = section();
	for (let i = 0; i < AGENTS; i++) make();
	const before = await liveStringBytes();
	const held: T[] = [];
	for (let i = 0; i < AGENTS; i++) held.push(make());
	const grown = (await liveStringBytes()) - before;
	if (!held.every(value => text(value) === expected)) throw new Error("an arm holds a section that is not equal");
	return grown;
}

/** The agent's system prompt when it is one part, or `undefined`. */
function onlyPart(agent: Agent): string | undefined {
	const parts = agent.state.systemPrompt;
	return parts.length === 1 ? parts[0] : undefined;
}

export async function measure(): Promise<PromptGrowth> {
	return {
		plain: await heldBy(section, text => text),
		"initial state": await heldBy(MAKE["initial state"], onlyPart),
		"setSystemPrompt with parts": await heldBy(MAKE["setSystemPrompt with parts"], onlyPart),
		"setSystemPrompt with one string": await heldBy(MAKE["setSystemPrompt with one string"], onlyPart),
	};
}

if (import.meta.main) {
	process.stdout.write(`${JSON.stringify(await measure())}\n`);
}
