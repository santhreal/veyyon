/**
 * Regenerate the committed paired proof:
 * `env -u NO_COLOR FORCE_COLOR=3 bun scripts/demos/render-model-chain-editor.ts --width 100 | bun scripts/demos/render-proof.ts --out assets/model-chain-editor --width 100 --scale 2`
 */
import type { Model } from "@veyyon/ai";
import { buildModel } from "@veyyon/catalog/build";
import { Container, Spacer, Text } from "@veyyon/tui";
import type { ModelRegistry } from "../../packages/coding-agent/src/config/model-registry";
import { ModelChainSubmenu } from "../../packages/coding-agent/src/modes/components/settings-selector";
import { initRender, renderWidth } from "./render-args";

const width = renderWidth(process.argv.slice(2));
await initRender("dark", { settings: true });

const models: Model[] = ["alpha", "beta", "gamma"].map(id =>
	buildModel({
		id,
		name: `Model ${id}`,
		api: "openai-completions",
		provider: "test",
		baseUrl: "https://example.test",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100_000,
		maxTokens: 10_000,
	}),
);
const registry = {
	isKeylessProvider: () => false,
	hasConfiguredAuth: () => true,
	authStorage: { hasAuth: () => true },
} as unknown as ModelRegistry;

const chain = "test/alpha:low,test/beta:high";
const before = new ModelChainSubmenu(
	"compaction.model",
	registry,
	models,
	"Before: compaction model chain",
	chain,
	() => {},
	() => {},
);

let persisted: string | undefined = chain;
const transitions: string[] = [];
const interactive = new ModelChainSubmenu(
	"compaction.model",
	registry,
	models,
	"After: compaction model chain",
	chain,
	() => {},
	value => {
		persisted = value;
	},
);
const expectPersisted = (label: string, expected: string): void => {
	if (persisted !== expected) {
		throw new Error(`${label} persisted ${JSON.stringify(persisted)} instead of ${JSON.stringify(expected)}`);
	}
	transitions.push(`${label}: ${persisted}`);
};
const type = (value: string): void => {
	for (const char of value) interactive.handleInput(char);
};

interactive.handleInput("\x1b[B");
interactive.handleInput("\x7f");
expectPersisted("delete highlighted fallback", "test/alpha:low");

interactive.handleInput("\x1b[B");
interactive.handleInput("\n");
type("gamma");
interactive.handleInput("\n");
expectPersisted("append fallback", "test/alpha:low,test/gamma");

interactive.handleInput("\n");
type("beta");
interactive.handleInput("\n");
expectPersisted("replace highlighted first choice", "test/beta,test/gamma");

const root = new Container();
root.addChild(before);
root.addChild(new Spacer(2));
root.addChild(interactive);
root.addChild(new Spacer(1));
root.addChild(new Text(transitions.join("\n"), 0, 0));
process.stdout.write(`${root.render(width).join("\n")}\n`);
