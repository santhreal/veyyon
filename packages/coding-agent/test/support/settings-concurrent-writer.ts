/**
 * Child process for `settings-concurrent-write.test.ts`.
 *
 * Not a test. It exists because the contract under test is a CROSS-PROCESS one:
 * `#saveNow` guards its read-modify-write with an advisory file lock, and a lock
 * can only be shown to work between separate processes. Two `Settings` instances
 * inside one process would serialize on the event loop and pass even with the
 * lock removed, which is exactly the false green this file avoids.
 *
 * Usage: `bun <this file> <agentDir> <settingPath> <value> [writes]`. It loads
 * the shared config, writes its own key `writes` times with a flush after each,
 * and exits non-zero on any failure so the parent can attribute the damage.
 */
import { Settings } from "@veyyon/coding-agent/config/settings";

const [, , agentDir, settingPath, rawValue, rawWrites] = process.argv;

if (agentDir === undefined || settingPath === undefined || rawValue === undefined) {
	console.error("usage: settings-concurrent-writer <agentDir> <settingPath> <value> [writes]");
	process.exit(2);
}

const writes = rawWrites === undefined ? 1 : Number.parseInt(rawWrites, 10);
if (!Number.isInteger(writes) || writes < 1) {
	console.error(`invalid write count: ${rawWrites}`);
	process.exit(2);
}

const value = rawValue === "true" ? true : rawValue === "false" ? false : rawValue;

const settings = await Settings.loadIsolated({ agentDir, cwd: agentDir });

for (let i = 0; i < writes; i++) {
	settings.set(settingPath as Parameters<Settings["set"]>[0], value as never);
	await settings.flush();
}

process.exit(0);
