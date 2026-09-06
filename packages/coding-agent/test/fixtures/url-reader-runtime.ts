import assert from "node:assert/strict";
import { once } from "node:events";
import * as fs from "node:fs/promises";
import { createServer } from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "../../src/config/settings";
import type { ToolSession } from "../../src/tools";
import { ReadTool } from "../../src/tools/fs/read";
import { SearchTool, searchSchema } from "../../src/tools/search/search";

const firstAction = process.argv[2];
const urlSearchTypes = searchSchema.shape.type.options.filter(type => type !== "files");
assert(firstAction === "read" || urlSearchTypes.some(type => type === firstAction));
const root = await fs.mkdtemp(path.join(os.tmpdir(), "url-reader-runtime-"));
const body = "export function localNeedle() {\n\treturn 7;\n}\n";
const localPath = path.join(root, "notes.ts");
await fs.writeFile(localPath, body);
let requests = 0;
const server = createServer((_request, response) => {
	requests++;
	response.writeHead(200, { "Content-Type": "text/plain" });
	response.end(body);
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
assert(address && typeof address !== "string");
const url = `http://127.0.0.1:${address.port}/notes.ts`;
let nextArtifact = 0;
const session: ToolSession = {
	cwd: root,
	hasUI: false,
	getSessionFile: () => path.join(root, "session.jsonl"),
	getArtifactsDir: () => path.join(root, "artifacts"),
	getSessionSpawns: () => null,
	allocateOutputArtifact: async toolType => {
		const id = String(nextArtifact++);
		return { id, path: path.join(root, "artifacts", `${id}.${toolType}.log`) };
	},
	settings: Settings.isolated({ "fetch.enabled": false, "search.contextBefore": 0, "search.contextAfter": 0 }),
};
const reader = new ReadTool(session);
const search = new SearchTool(session);
const text = (result: { content: Array<{ type: string; text?: string }> }) =>
	result.content
		.filter(part => part.type === "text")
		.map(part => part.text ?? "")
		.join("\n");
const readerLoaded = () =>
	Object.keys(require.cache).some(file => path.normalize(file).endsWith(path.join("tools", "web", "fetch.ts")));
try {
	assert.equal(readerLoaded(), false, "local tool construction loaded URL execution");
	assert.match(text(await reader.execute("local", { path: localPath })), /localNeedle/);
	for (const type of urlSearchTypes) {
		assert.match(
			text(await search.execute("local-search", { type, input: "localNeedle", path: localPath })),
			/localNeedle/,
		);
	}
	await assert.rejects(reader.execute("disabled", { path: url }), /URL reads are disabled by settings/);
	for (const type of urlSearchTypes) {
		await assert.rejects(
			search.execute("disabled-search", { type, input: "localNeedle", path: url }),
			/URL reads are disabled by settings/,
		);
	}
	assert.equal(readerLoaded(), false, "disabled URL operation loaded URL execution");
	assert.equal(requests, 0);
	session.settings = Settings.isolated({ "fetch.enabled": true, "search.contextBefore": 0, "search.contextAfter": 0 });
	const start = performance.now();
	if (firstAction === "read") {
		assert.match(text(await reader.execute("first-url", { path: url })), /return 7/);
	} else {
		const type = urlSearchTypes.find(type => type === firstAction);
		assert(type);
		assert.match(text(await search.execute("first-url", { type, input: "localNeedle", path: url })), /localNeedle/);
	}
	const firstActionMs = performance.now() - start;
	assert.equal(readerLoaded(), true);
	assert.match(text(await reader.execute("cached-url", { path: `${url}:1-1,2-2` })), /Content-Type: text\/plain/);
	assert.equal(requests, 1, "range reads must share the fetched body");
	for (const type of urlSearchTypes) {
		assert.match(text(await search.execute("url-search", { type, input: "localNeedle", path: url })), /localNeedle/);
	}
	assert.equal(requests, 1, "URL search must reuse the read cache");
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(reader.execute("cancelled", { path: `${url}?cancelled=1` }, controller.signal), /aborted/i);
	assert.equal(requests, 1, "cancelled URL reads must not issue a request");
	process.stdout.write(
		`${JSON.stringify({ firstAction, firstActionMs, requests, disabledReaderStayedUnloaded: true, cacheShared: true, cancellationPreventedRequest: true })}\n`,
	);
} finally {
	server.close();
	await once(server, "close");
	await fs.rm(root, { recursive: true, force: true });
}
