import { ThinkingLevel } from "@veyyon/agent-core";
import { getBundledModel } from "@veyyon/catalog";
import { createAgentSession, discoverAuthStorage, ModelRegistry } from "@veyyon/coding-agent";

const authStorage = await discoverAuthStorage();
const modelRegistry = new ModelRegistry(authStorage);

const opus = getBundledModel("anthropic", "claude-opus-4-5");
if (opus) {
	console.log(`Found model: ${opus.provider}/${opus.id}`);
}

const customModel = modelRegistry.find("my-provider", "my-model");
if (customModel) {
	console.log(`Found custom model: ${customModel.provider}/${customModel.id}`);
}

const available = modelRegistry.getAvailable();
console.log(
	"Available models:",
	available.map(m => `${m.provider}/${m.id}`),
);

if (available.length > 0) {
	const { session } = await createAgentSession({
		model: available[0],
		thinkingLevel: ThinkingLevel.Medium, // off, low, medium, high
		authStorage,
		modelRegistry,
	});

	session.subscribe(event => {
		if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
			process.stdout.write(event.assistantMessageEvent.delta);
		}
	});

	await session.prompt("Say hello in one sentence.");
	console.log();
}
