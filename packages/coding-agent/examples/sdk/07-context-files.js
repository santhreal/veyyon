import { createAgentSession, discoverContextFiles, SessionManager } from "@veyyon/coding-agent";
const discovered = await discoverContextFiles();
console.log("Discovered context files:");
for (const file of discovered) {
    console.log(`  - ${file.path} (${file.content.length} chars)`);
}
await createAgentSession({
    contextFiles: [
        ...discovered,
        {
            path: "/virtual/AGENTS.md",
            content: `# Project Guidelines

## Code Style
- Use TypeScript strict mode
- No any types
- Prefer const over let`,
        },
    ],
    sessionManager: SessionManager.inMemory(),
});
console.log(`Session created with ${discovered.length + 1} context files`);
