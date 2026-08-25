/**
 * Adapters send requests at the client (`runInTerminal`, `startDebugging`).
 * `#handleAdapterRequest` is the only path that answers them. A registered
 * handler's return is the response body; a missing handler must still be
 * answered (`success=false`) so the adapter is not left blocked on
 * `request_seq`. Dropping the request is a hang, which is how a debug
 * session dies with no event.
 *
 * `DapClient.spawn` is the seam that starts the message reader. The adapter
 * here is a bun script that waits, writes one framed reverse request, and
 * stays alive.
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
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dap-rev-"));
	dirs.push(dir);
	const adapterPath = path.join(dir, "adapter.mjs");
	await fs.writeFile(adapterPath, scriptFor(command, args), "utf8");
	const client = await DapClient.spawn({ adapter: adapterSpec(adapterPath), cwd: dir });
	clients.push(client);
	return client;
}

describe("a reverse-request handler that throws must still answer the adapter", () => {

	it("invokes a throwing handler without killing the client", async () => {
		const client = await spawnFor("runInTerminal", { args: ["true"] });
		const latch = Promise.withResolvers<void>();
		client.onReverseRequest("runInTerminal", () => {
			latch.resolve();
			throw new Error("runInTerminal request did not include a command");
		});
		await Promise.race([
			latch.promise,
			Bun.sleep(2000).then(() => {
				throw new Error("throwing handler was never invoked");
			}),
		]);
		expect(client.isAlive()).toBe(true);
	});
});

describe("an unregistered reverse request is still answered", () => {
	it("leaves the client alive after an unsupported reverse request arrives", async () => {
		const client = await spawnFor("runInTerminal", { args: ["true"] });
		await Bun.sleep(400);
		expect(client.isAlive()).toBe(true);
	});
});
