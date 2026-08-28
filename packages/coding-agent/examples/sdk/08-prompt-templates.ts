import { createAgentSession, discoverPromptTemplates, type PromptTemplate, SessionManager } from "@veyyon/coding-agent";

const discovered = await discoverPromptTemplates();
console.log("Discovered prompt templates:");
for (const template of discovered) {
	console.log(`  /${template.name}: ${template.description}`);
}

const deployTemplate: PromptTemplate = {
	name: "deploy",
	description: "Deploy the application",
	source: "(custom)",
	content: `# Deploy Instructions

1. Build: npm run build
2. Test: npm test
3. Deploy: npm run deploy`,
};

await createAgentSession({
	promptTemplates: [...discovered, deployTemplate],
	sessionManager: SessionManager.inMemory(),
});

console.log(`Session created with ${discovered.length + 1} prompt templates`);
