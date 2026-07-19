import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	addSSHHost,
	readSSHConfigFile,
	removeSSHHost,
	type SSHHostConfig,
} from "@veyyon/coding-agent/ssh/config-writer";
import { Snowflake } from "@veyyon/utils";

let tempDir = "";
let configPath = "";

function host(address: string): SSHHostConfig {
	return { host: address };
}

beforeEach(async () => {
	tempDir = path.join(os.tmpdir(), `veyyon-ssh-cw-${Snowflake.next()}`);
	await fs.mkdir(tempDir, { recursive: true });
	configPath = path.join(tempDir, "ssh.json");
});

afterEach(async () => {
	await fs.rm(tempDir, { recursive: true, force: true });
});

describe("ssh config-writer concurrency", () => {
	test("N concurrent addSSHHost calls all land — no lost update", async () => {
		// Without the cross-process lock every writer reads the same empty base,
		// each adds one host, and last-write-wins drops all but one.
		const names = Array.from({ length: 20 }, (_, i) => `host-${String(i).padStart(2, "0")}`);
		await Promise.all(names.map(name => addSSHHost(configPath, name, host(`addr-${name}`))));

		const config = await readSSHConfigFile(configPath);
		expect(Object.keys(config.hosts ?? {}).sort()).toEqual(names);
		for (const name of names) {
			expect(config.hosts?.[name]?.host).toBe(`addr-${name}`);
		}
	});

	test("concurrent add of the SAME name: exactly one wins, the rest reject", async () => {
		const attempts = 8;
		const results = await Promise.allSettled(
			Array.from({ length: attempts }, (_, i) => addSSHHost(configPath, "dupe", host(`addr-${i}`))),
		);
		expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
		const rejected = results.filter(r => r.status === "rejected");
		expect(rejected).toHaveLength(attempts - 1);
		for (const r of rejected) {
			expect((r as PromiseRejectedResult).reason.message).toContain("already exists");
		}
		const config = await readSSHConfigFile(configPath);
		expect(Object.keys(config.hosts ?? {})).toEqual(["dupe"]);
	});

	test("concurrent add + remove leaves a consistent config", async () => {
		await addSSHHost(configPath, "seed", host("addr-seed"));

		const adds = Array.from({ length: 10 }, (_, i) => addSSHHost(configPath, `add-${i}`, host(`addr-${i}`)));
		const removes = Array.from({ length: 5 }, () =>
			removeSSHHost(configPath, "seed").catch(() => {
				// Only the first remover finds "seed"; the rest race to not-found.
			}),
		);
		await Promise.all([...adds, ...removes]);

		const config = await readSSHConfigFile(configPath);
		expect(Object.keys(config.hosts ?? {}).sort()).toEqual([
			"add-0",
			"add-1",
			"add-2",
			"add-3",
			"add-4",
			"add-5",
			"add-6",
			"add-7",
			"add-8",
			"add-9",
		]);
		expect(config.hosts?.seed).toBeUndefined();
	});

	test("no lock directory is left behind after a mutation", async () => {
		await addSSHHost(configPath, "solo", host("addr-solo"));
		await expect(fs.stat(`${configPath}.lock`)).rejects.toThrow();
	});
});
