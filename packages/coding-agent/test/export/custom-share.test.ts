import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as utils from "@veyyon/utils";

/**
 * custom-share lets a user override the default Gist share with a script at
 * ~/.veyyon/agent/share.{ts,js,mjs}. This suite spies getAgentDir (NOT mock.module)
 * so the override cannot poison later files in the same `bun test` process —
 * mock.module("@veyyon/utils") is process-global and was the leaker behind
 * FINDING-FULL-SUITE-ORDER-DEPENDENT-POLLUTION (settings-test-state saw
 * /tmp/custom-share-* as getAgentDir after this file ran).
 */

let currentAgentDir = "";
const created: string[] = [];
let getAgentDirSpy: ReturnType<typeof spyOn> | undefined;

beforeEach(() => {
	currentAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "custom-share-"));
	created.push(currentAgentDir);
	getAgentDirSpy?.mockRestore();
	getAgentDirSpy = spyOn(utils, "getAgentDir").mockImplementation(() => currentAgentDir);
});

afterEach(() => {
	getAgentDirSpy?.mockRestore();
	getAgentDirSpy = undefined;
	mock.restore();
	for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const { getCustomSharePath, loadCustomShare } = await import("@veyyon/coding-agent/export/custom-share");

const writeScript = (name: string, body: string): void => fs.writeFileSync(path.join(currentAgentDir, name), body);

describe("getCustomSharePath", () => {
	it("returns null when no share script exists", () => {
		expect(getCustomSharePath()).toBeNull();
	});

	it("finds a share.js when it is the only candidate", () => {
		writeScript("share.js", "export default async () => 'x';\n");
		expect(getCustomSharePath()).toBe(path.join(currentAgentDir, "share.js"));
	});

	it("prefers share.ts over share.js when both exist", () => {
		writeScript("share.js", "export default async () => 'j';\n");
		writeScript("share.ts", "export default async () => 't';\n");
		expect(getCustomSharePath()).toBe(path.join(currentAgentDir, "share.ts"));
	});
});

describe("loadCustomShare", () => {
	it("returns null when there is no share script", async () => {
		expect(await loadCustomShare()).toBeNull();
	});

	it("loads a valid default-export function and returns a callable handler", async () => {
		writeScript("share.ts", "export default async (p) => ({ url: 'shared:' + p });\n");
		const loaded = await loadCustomShare();
		expect(loaded?.path).toBe(path.join(currentAgentDir, "share.ts"));
		expect(await loaded?.fn("/tmp/report.html")).toEqual({ url: "shared:/tmp/report.html" });
	});

	it("rejects a script whose default export is not a function", async () => {
		writeScript("share.ts", "export default 42;\n");
		await expect(loadCustomShare()).rejects.toThrow(
			"Failed to load share script: share script must export a default function",
		);
	});
});
