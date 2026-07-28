import type { Model } from "@veyyon/ai";
import { buildModel } from "@veyyon/catalog/build";
import { Container, Spacer } from "@veyyon/tui";
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
const list = new ModelChainSubmenu(
	"compaction.model",
	registry,
	models,
	"Compaction model chain",
	chain,
	() => {},
	() => {},
);
const editing = new ModelChainSubmenu(
	"compaction.model",
	registry,
	models,
	"Compaction model chain",
	chain,
	() => {},
	() => {},
);
editing.handleInput("\n");

const root = new Container();
root.addChild(list);
root.addChild(new Spacer(2));
root.addChild(editing);
process.stdout.write(`${root.render(width).join("\n")}\n`);
