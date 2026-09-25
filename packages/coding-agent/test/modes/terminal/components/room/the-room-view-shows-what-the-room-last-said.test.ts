/**
 * WHY: the room view is where every conversation shows at once, and `#room` is
 * what they tell each other. The view shows the room's newest line in the row
 * of air under its title: `#room`, the poster as the room numbered it, and the
 * message. While the room has said nothing the row stays air, and a line wider
 * than the terminal is cut to it without moving the title or the windows.
 *
 * What it does NOT catch: which line is the newest (the bus's contract, in
 * `tools/a-room-post-reaches-every-driver-in-the-room-and-no-spawn`), that the
 * controller redraws the view when a line is posted, or the line's colours.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@veyyon/utils/width";
import { useTruecolorTheme } from "../../../../helpers/theme-assertions";
import { disposeStages, FakeMember, START_MS, StageDriver, snapshotOf } from "./room-stage-driver";

useTruecolorTheme("dark");

const DONE = snapshotOf({ kind: "done", at: START_MS }, [{ kind: "prompt", text: "list the tables" }]);

function room(): FakeMember[] {
	return [new FakeMember("m1", DONE, { origin: true }), new FakeMember("m2", DONE), new FakeMember("m3", DONE)];
}

function rows(driver: StageDriver): string[] {
	return [...driver.render()].map(row => stripVTControlCharacters(row));
}

describe("the room view's channel row", () => {
	afterEach(() => {
		disposeStages();
	});

	it("is air while the room has said nothing", () => {
		const driver = new StageDriver({ width: 120, height: 36, members: room(), motion: false });
		expect(rows(driver)[1]?.trim()).toBe("");
	});

	it("shows the newest line under the title, poster then message, and follows it when a newer one comes", () => {
		const driver = new StageDriver({ width: 120, height: 36, members: room(), motion: false });
		driver.host.channelLine = { label: "2 · parser whitespace", body: "tokenize now takes (src, opts)" };
		const first = rows(driver);
		expect(first[1]?.trimEnd()).toBe("  #room  2 · parser whitespace: tokenize now takes (src, opts)");
		expect(first[0]).toContain("3 conversations");

		driver.host.channelLine = { label: "you", body: "freeze main until the release is cut" };
		expect(rows(driver)[1]?.trimEnd()).toBe("  #room  you: freeze main until the release is cut");
	});

	it("is cut to a narrow terminal, and every other row is the frame it was without it", () => {
		const quiet = rows(new StageDriver({ width: 48, height: 30, members: room(), motion: false }));
		const driver = new StageDriver({ width: 48, height: 30, members: room(), motion: false });
		driver.host.channelLine = {
			label: "3 · a conversation with a long name",
			body: "a message far wider than this terminal is, which the row cuts at its edge",
		};
		const said = rows(driver);
		expect(visibleWidth(said[1]!)).toBeLessThanOrEqual(48);
		expect(said[1]).toStartWith("  #room  3 · a conversation");
		expect(said.filter((_, index) => index !== 1)).toEqual(quiet.filter((_, index) => index !== 1));
	});
});
