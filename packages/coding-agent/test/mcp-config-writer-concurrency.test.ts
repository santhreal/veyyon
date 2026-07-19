import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	addMCPServer,
	readMCPConfigFile,
	removeMCPServer,
	setServerDisabled,
	setServerForceEnabled,
} from "@veyyon/coding-agent/mcp/config-writer";
import type { MCPServerConfig, MCPStdioServerConfig } from "@veyyon/coding-agent/mcp/types";
import { Snowflake } from "@veyyon/utils";

let tempDir = "";
let configPath = "";

function stdio(command: string): MCPServerConfig {
	return { type: "stdio", command, args: [] };
}

beforeEach(async () => {
	tempDir = path.join(os.tmpdir(), `veyyon-mcp-cw-${Snowflake.next()}`);
	await fs.mkdir(tempDir, { recursive: true });
	configPath = path.join(tempDir, "mcp.json");
});

afterEach(async () => {
	await fs.rm(tempDir, { recursive: true, force: true });
});

describe("mcp config-writer concurrency", () => {
	test("N concurrent addMCPServer calls all land — no lost update", async () => {
		// Without the cross-process lock every writer reads the same empty base,
		// each adds one server, and last-write-wins drops all but one. The lock
		// serializes read+mutate+write so every server survives.
		const names = Array.from({ length: 20 }, (_, i) => `srv-${String(i).padStart(2, "0")}`);
		await Promise.all(names.map(name => addMCPServer(configPath, name, stdio(`cmd-${name}`))));

		const config = await readMCPConfigFile(configPath);
		const persisted = Object.keys(config.mcpServers ?? {}).sort();
		expect(persisted).toEqual(names);
		// Each entry keeps its own command, so no write clobbered another's payload.
		for (const name of names) {
			const entry = config.mcpServers?.[name];
			expect(entry?.type).toBe("stdio");
			expect((entry as MCPStdioServerConfig).command).toBe(`cmd-${name}`);
		}
	});

	test("concurrent add of the SAME name: exactly one wins, the rest reject", async () => {
		const attempts = 8;
		const results = await Promise.allSettled(
			Array.from({ length: attempts }, (_, i) => addMCPServer(configPath, "dupe", stdio(`cmd-${i}`))),
		);
		const fulfilled = results.filter(r => r.status === "fulfilled");
		const rejected = results.filter(r => r.status === "rejected");
		expect(fulfilled).toHaveLength(1);
		expect(rejected).toHaveLength(attempts - 1);
		for (const r of rejected) {
			expect((r as PromiseRejectedResult).reason.message).toContain("already exists");
		}
		// One server persisted, named "dupe".
		const config = await readMCPConfigFile(configPath);
		expect(Object.keys(config.mcpServers ?? {})).toEqual(["dupe"]);
	});

	test("concurrent add + remove leaves a consistent, non-torn config", async () => {
		// Seed a server so the removes have something to target.
		await addMCPServer(configPath, "seed", stdio("cmd-seed"));

		const adds = Array.from({ length: 10 }, (_, i) => addMCPServer(configPath, `add-${i}`, stdio(`cmd-${i}`)));
		const removes = Array.from({ length: 5 }, () =>
			removeMCPServer(configPath, "seed").catch(() => {
				// Only the first remover finds "seed"; the rest race to a
				// not-found error. That is expected and not a torn write.
			}),
		);
		await Promise.all([...adds, ...removes]);

		const config = await readMCPConfigFile(configPath);
		const names = Object.keys(config.mcpServers ?? {}).sort();
		// All 10 adds survived; seed was removed exactly once.
		expect(names).toEqual(["add-0", "add-1", "add-2", "add-3", "add-4", "add-5", "add-6", "add-7", "add-8", "add-9"]);
		expect(config.mcpServers?.seed).toBeUndefined();
	});

	test("concurrent disabledServers toggles do not lose entries", async () => {
		// Each writer adds a distinct name to the denylist. An unlocked
		// read-modify-write would collapse the set to one entry.
		const names = Array.from({ length: 12 }, (_, i) => `dis-${String(i).padStart(2, "0")}`);
		await Promise.all(names.map(name => setServerDisabled(configPath, name, true)));

		const config = await readMCPConfigFile(configPath);
		expect((config.disabledServers ?? []).slice().sort()).toEqual(names);
	});

	test("concurrent enabledServers (force) toggles do not lose entries", async () => {
		const names = Array.from({ length: 12 }, (_, i) => `en-${String(i).padStart(2, "0")}`);
		await Promise.all(names.map(name => setServerForceEnabled(configPath, name, true)));

		const config = await readMCPConfigFile(configPath);
		expect((config.enabledServers ?? []).slice().sort()).toEqual(names);
	});

	test("no lock directory is left behind after a mutation", async () => {
		await addMCPServer(configPath, "solo", stdio("cmd-solo"));
		// The critical section releases the lock, so nothing lingers to block the
		// next writer.
		await expect(fs.stat(`${configPath}.lock`)).rejects.toThrow();
	});
});
