/**
 * Child process for `session-kill-mid-write.test.ts`.
 *
 * Not a test. It appends messages to a session forever, flushing each one and
 * announcing the flush on stdout, so the parent can SIGKILL it at a point where
 * it knows exactly how many messages were durably committed.
 *
 * A real kill is the point. `SIGKILL` cannot be caught, so no shutdown hook, no
 * `finally`, and no flush-on-exit runs — which is the difference between testing
 * crash recovery and testing an orderly close. Simulating the crash by writing
 * what we imagine a dead process leaves behind would only assert our own guess.
 *
 * Usage: `bun <this file> <cwd> <sessionDir> <agentDir>`. Prints
 * `file <path>` once, then `committed <n>` after each flushed append.
 */
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { setAgentDir } from "@veyyon/utils";

const [, , cwd, sessionDir, agentDir] = process.argv;

if (cwd === undefined || sessionDir === undefined || agentDir === undefined) {
	console.error("usage: session-append-until-killed <cwd> <sessionDir> <agentDir>");
	process.exit(2);
}

// Blobs and the default session dir hang off the agent dir, a different root
// from `sessionDir`. Move it so a killed child cannot leave debris in the
// developer's real ~/.veyyon.
setAgentDir(agentDir);

const manager = SessionManager.create(cwd, sessionDir);

manager.appendMessage({ role: "user", content: "message 0", timestamp: Date.now() });
await manager.rewriteEntries();

const file = manager.getSessionFile();
if (!file) {
	console.error("expected a persisted session file");
	process.exit(2);
}
console.log(`file ${file}`);

for (let i = 1; ; i++) {
	manager.appendMessage({ role: "user", content: `message ${i}`, timestamp: Date.now() });
	await manager.flush();
	console.log(`committed ${i}`);
	// Yield so the parent can observe the line and kill between commits rather
	// than starving on a tight loop.
	await Bun.sleep(5);
}
