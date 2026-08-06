/**
 * WHY: `/share` redacts the transcript before it leaves the machine, through a typed walk that
 * covers tool-result output and subagent transcripts. `/export` wrote the same transcript into a
 * self-contained HTML file and redacted nothing, so a secret that landed in a tool output (a
 * `.env` read, a curl with a token) shipped verbatim in the file the operator attaches to a bug
 * report. Both egress paths now run the same walk.
 *
 * The contract these tests defend:
 *   - a configured secret appearing in a primary-session tool result is replaced in the exported
 *     snapshot;
 *   - so is one appearing in an embedded subagent transcript, which is a separate branch of the
 *     walk and the one a partial fix would miss;
 *   - with no obfuscator the snapshot is unchanged, so export is not silently lossy;
 *   - non-secret transcript text survives redaction, so this is not a blanket scrub.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { removeWithRetries } from "@veyyon/utils";
import { exportFromFile } from "../src/export/html";
import { SecretObfuscator } from "../src/secrets/obfuscator";

const SECRET = "sk-live-EXPORTLEAK-0123456789";

let root: string;
let sessionFile: string;

function sessionLines(id: string, toolOutput: string): string {
	return `${[
		JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-08-05T00:00:00.000Z", cwd: "/tmp/proj" }),
		JSON.stringify({
			type: "message",
			id: `${id}-1`,
			parentId: null,
			timestamp: "2026-08-05T00:00:01.000Z",
			message: { role: "toolResult", toolCallId: "t1", toolName: "read", content: toolOutput },
		}),
	].join("\n")}\n`;
}

/** Pull the JSON snapshot back out of the exported HTML, the way the viewer does. */
async function exportedSnapshot(outputPath: string): Promise<string> {
	const html = await fs.readFile(outputPath, "utf8");
	const match = /<script id="session-data" type="application\/json">([^<]*)<\/script>/.exec(html);
	if (!match) throw new Error("exported HTML carries no session-data script");
	return Buffer.from(match[1]!, "base64").toString("utf8");
}

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-export-redact-"));
	sessionFile = path.join(root, "main.jsonl");
	await Bun.write(sessionFile, sessionLines("main", `API_KEY=${SECRET}\nPORT=8080\n`));
	await Bun.write(path.join(root, "main/Helper.jsonl"), sessionLines("helper", `child saw ${SECRET} once`));
});

afterEach(async () => {
	await removeWithRetries(root);
});

describe("HTML export secret redaction", () => {
	it("replaces a secret in the primary transcript and in an embedded subagent transcript", async () => {
		const obfuscator = new SecretObfuscator([{ type: "plain", origin: "config", content: SECRET }]);
		const placeholder = obfuscator.obfuscate(SECRET);
		const outputPath = path.join(root, "redacted.html");

		await exportFromFile(sessionFile, { outputPath, obfuscator });
		const snapshot = await exportedSnapshot(outputPath);

		expect(snapshot).not.toContain(SECRET);
		expect(snapshot).toContain(placeholder);
		// Both copies: the primary entry and the Helper sub-session the export embeds.
		expect(snapshot.split(placeholder).length - 1).toBe(2);
		expect(JSON.parse(snapshot).subSessions.Helper.entries[0].message.content).toBe(
			`child saw ${placeholder} once`,
		);
	});

	it("leaves non-secret transcript text untouched", async () => {
		const obfuscator = new SecretObfuscator([{ type: "plain", origin: "config", content: SECRET }]);
		const outputPath = path.join(root, "redacted.html");

		await exportFromFile(sessionFile, { outputPath, obfuscator });
		const snapshot = await exportedSnapshot(outputPath);

		expect(snapshot).toContain("PORT=8080");
		expect(JSON.parse(snapshot).header.cwd).toBe("/tmp/proj");
	});

	it("writes the transcript unchanged when no obfuscator is supplied", async () => {
		const outputPath = path.join(root, "plain.html");

		await exportFromFile(sessionFile, { outputPath });
		const snapshot = await exportedSnapshot(outputPath);

		expect(snapshot).toContain(SECRET);
	});
});
