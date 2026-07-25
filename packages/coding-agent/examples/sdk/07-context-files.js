/**
 * Context Files (AGENTS.md)
 *
 * Context files provide project-specific instructions loaded into the system prompt.
 */
import { createAgentSession, discoverContextFiles, SessionManager } from "@veyyon/coding-agent";
// Discover AGENTS.md files walking up from cwd. The discovery reads from disk,
// so it is async: without the `await` you iterate a promise, not the files.
const discovered = await discoverContextFiles();
console.log("Discovered context files:");
for (const file of discovered) {
    console.log(`  - ${file.path} (${file.content.length} chars)`);
}
// Use custom context files
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
// Disable context files:
// contextFiles: []
