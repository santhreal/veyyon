/**
 * WHY: a cmux tab refused `tab.storageState()` and `tab.loadStorageState()` telling the model to "open
 * the tab without app.cmux". The browser tool has no `app.cmux`: an open with no `app` lands on cmux
 * whenever cmux is on, so the refusal sent the model to a parameter the schema rejects.
 *
 * The contract: both refusals name the switches that turn cmux off, and each named switch does turn
 * it off for an open with no `app`.
 *
 * What it does NOT catch: the wording of the `open` refusal for `context` and `storage_state` on a cmux
 * browser, which names the browser kind rather than a way out.
 */

import { describe, expect, it } from "bun:test";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { CmuxTab } from "@veyyon/coding-agent/tools/web/browser/cmux/cmux-tab";
import { resolveCmuxKind } from "@veyyon/coding-agent/tools/web/browser/cmux/rpc";

async function refusalOf(call: Promise<unknown>): Promise<string> {
	try {
		await call;
		return "(it did not fail)";
	} catch (error) {
		return (error as Error).message;
	}
}

describe("a cmux tab asked for storage state", () => {
	it("refuses naming the switches that open tabs in the headless browser instead, and each one does", async () => {
		const tab = new CmuxTab({ client: { request: async () => ({}) } as never, surfaceId: "surface-1" });
		const refusals = [
			await refusalOf(tab.storageState({ path: "state.json" })),
			await refusalOf(tab.loadStorageState("state.json")),
		];
		for (const refusal of refusals) {
			expect(refusal).toStartWith("Storage state needs the headless browser");
			expect(refusal).toContain("the browser.cmux setting");
			expect(refusal).toContain("VEYYON_BROWSER_CMUX=0");
			expect(refusal).not.toContain("app.");
		}
		const socket = { CMUX_SOCKET_PATH: "/run/cmux.sock" };
		expect(typeof Settings.isolated({ "browser.cmux": false }).get("browser.cmux")).toBe("boolean");
		expect({
			on: resolveCmuxKind({ settingEnabled: true }, socket)?.kind,
			settingOff: resolveCmuxKind({ settingEnabled: false }, socket),
			envOff: resolveCmuxKind({ settingEnabled: true }, { ...socket, VEYYON_BROWSER_CMUX: "0" }),
		}).toEqual({ on: "cmux", settingOff: null, envOff: null });
	});
});
