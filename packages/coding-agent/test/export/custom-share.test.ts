import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * custom-share lets a user override the default Gist share with a script at
 * ~/.veyyon/agent/share.{ts,js,mjs}. Its loader was untested. This suite mocks the two
 * @veyyon/utils symbols it uses (getAgentDir, errorMessage) to point at a fresh temp
 * agent dir per test, then exercises the real disk + dynamic-import path: no script ->
 * null (both getCustomSharePath and loadCustomShare), candidate precedence (share.ts is
 * tried before share.js), a valid default-export function is loaded and callable, and a
 * script whose default export is not a function is rejected with a wrapped error. A
 * regression would silently ignore a user's share script or import a bad one without a
 * clear error. Each test uses a unique temp dir so the dynamic-import cache never serves
 * a stale module.
 */

let currentAgentDir = "";
mock.module("@veyyon/utils", () => ({
	getAgentDir: () => currentAgentDir,
	errorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));

const { getCustomSharePath, loadCustomShare } = await import("@veyyon/coding-agent/export/custom-share");

const created: string[] = [];
beforeEach(() => {
	currentAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "custom-share-"));
	created.push(currentAgentDir);
});
afterEach(() => {
	for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

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
