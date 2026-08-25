/**
 * onReverseRequest stores handlers in a Map keyed by command name. A second
 * registration for `runInTerminal` replaces the first. The unsubscribe
 * function only deletes if the map still holds THAT function, so
 * unsubscribing the replaced handler is a no-op and must not remove the
 * live one.
 *
 * Unregistered and throwing handlers live in reverse-request-answers-or-errors.test.ts.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DapClient } from "@veyyon/coding-agent/dap/client";
import type { DapResolvedAdapter } from "@veyyon/coding-agent/dap/types";

const dirs: string[] = [];
const clients: DapClient[] = [];

afterEach(async () => {
	await Promise.all(clients.splice(0).map(c => c.dispose().catch(() => {})));
	await Promise.all(dirs.splice(0).map(d => fs.rm(d, { recursive: true, force: true })));
});

function adapterSpec(adapterPath: string): DapResolvedAdapter {
	return {
		name: "test-adapter",
		command: process.execPath,
		args: [adapterPath],
		resolvedCommand: process.execPath,
		languages: [],
		fileTypes: [],
		rootMarkers: [],
		launchDefaults: {},
		attachDefaults: {},
		connectMode: "stdio",
		acceptsDirectoryProgram: false,
	};
}

function scriptFor(command: string, args: unknown): string {
	return `await new Promise(r => setTimeout(r, 250));
const body = JSON.stringify({
	seq: 7,
	type: "request",
	command: ${JSON.stringify(command)},
	arguments: ${JSON.stringify(args)},
});
process.stdout.write("Content-Length: " + Buffer.byteLength(body) + "\\r\\n\\r\\n" + body);
setInterval(() => {}, 1 << 30);
`;
}

async function spawnFor(command: string, args: unknown): Promise<DapClient> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dap-rev2-"));
	dirs.push(dir);
	const adapterPath = path.join(dir, "adapter.mjs");
	await fs.writeFile(adapterPath, scriptFor(command, args), "utf8");
	const client = await DapClient.spawn({ adapter: adapterSpec(adapterPath), cwd: dir });
	clients.push(client);
	return client;
}

describe("onReverseRequest last-write-wins per command, unsubscribe is identity-based", () => {
	it("invokes the second handler, not the first, when both register runInTerminal", async () => {
		const client = await spawnFor("runInTerminal", { args: ["echo"] });
		const first = Promise.withResolvers<void>();
		const second = Promise.withResolvers<unknown>();
		client.onReverseRequest("runInTerminal", () => {
			first.resolve();
			return { processId: 1 };
		});
		client.onReverseRequest("runInTerminal", raw => {
			second.resolve(raw);
			return { processId: 2 };
		});
		const raw = await Promise.race([
			second.promise,
			Bun.sleep(2000).then(() => {
				throw new Error("second handler was never invoked");
			}),
		]);
		expect(raw).toEqual({ args: ["echo"] });
		await Bun.sleep(50);
		let firstFired = false;
		first.promise.then(() => {
			firstFired = true;
		});
		await Bun.sleep(50);
		expect(firstFired).toBe(false);
		expect(client.isAlive()).toBe(true);
	});

	it("unsubscribing the replaced handler does not remove the live one", async () => {
		const client = await spawnFor("runInTerminal", { args: ["true"] });
		const live = Promise.withResolvers<unknown>();
		const unsubFirst = client.onReverseRequest("runInTerminal", () => ({ processId: 1 }));
		client.onReverseRequest("runInTerminal", raw => {
			live.resolve(raw);
			return { processId: 2 };
		});
		unsubFirst();
		const raw = await Promise.race([
			live.promise,
			Bun.sleep(2000).then(() => {
				throw new Error("live handler was removed by unsub of the replaced one");
			}),
		]);
		expect(raw).toEqual({ args: ["true"] });
	});
});

