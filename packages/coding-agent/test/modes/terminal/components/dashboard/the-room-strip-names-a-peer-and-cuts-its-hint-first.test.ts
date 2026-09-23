/**
 * WHY: the room strip is the one row that tells the operator which driving
 * agents share this terminal and which one Enter would attach to. The controller
 * suite (`controllers/a-room-switch-attaches-the-peer-and-only-a-peer.test.ts`)
 * proves what a switch attaches; this one proves what the row says, rendered
 * from a fixture the way the controller hands it in.
 *
 * THE CLASS THIS CLOSES. A row that misnames a peer or hides the one under the
 * cursor: an untitled session drawn under its raw `main:<id>`, a title whose
 * tab or newline breaks the row, a selected member with no monochrome marker,
 * and a narrow terminal that cuts a member before it cuts the hint.
 *
 * WHAT IT DOES NOT CATCH. Colour: every assertion strips SGR, so a member
 * distinguished only by hue passes. The bold on the current member is the one
 * visual cue this suite cannot see; the cursor glyph on the selected one is.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import {
	type RoomStripMember,
	renderRoomStripLine,
	roomMemberLabel,
} from "@veyyon/coding-agent/modes/terminal/components/dashboard/room-strip";
import type { AgentRef } from "@veyyon/coding-agent/registry/agent-registry";
import { getThemeByName, setThemeInstance, theme } from "@veyyon/coding-agent/theme/theme";
import { visibleWidth } from "@veyyon/utils/width";

function member(id: string, title: string | undefined, extra: Partial<AgentRef> = {}): RoomStripMember {
	return {
		title,
		ref: {
			id,
			displayName: "main",
			kind: "main",
			status: "idle",
			session: null,
			sessionFile: null,
			createdAt: 0,
			lastActivity: 0,
			room: "room:a",
			...extra,
		},
	};
}

function plain(line: string | undefined): string {
	return stripVTControlCharacters(line ?? "");
}

beforeAll(async () => {
	const dark = await getThemeByName("dark");
	if (!dark) throw new Error("Expected dark theme");
	setThemeInstance(dark);
});

describe("the room strip names a peer and cuts its hint first", () => {
	it("draws nothing for a room of one", () => {
		const line = renderRoomStripLine([member("main:a", "alpha")], {
			columns: 120,
			currentId: "main:a",
			selectedId: "main:a",
		});
		expect(line).toBeUndefined();
	});

	it("labels an untitled peer by its position, never by its id", () => {
		const members = [member("main:a", "alpha"), member("main:b", undefined), member("main:c", "   ")];
		expect(roomMemberLabel(members[1]!, 1)).toBe("session 2");
		expect(roomMemberLabel(members[2]!, 2)).toBe("session 3");
		const line = plain(renderRoomStripLine(members, { columns: 200, currentId: "main:a", selectedId: "main:b" }));
		expect(line).toContain("session 2");
		expect(line).toContain("session 3");
		expect(line).not.toContain("main:b");
	});

	it("flattens a title's tabs and line breaks into one row", () => {
		const line = renderRoomStripLine([member("main:a", "alpha"), member("main:b", "fix\tthe\r\nbuild")], {
			columns: 200,
			currentId: "main:a",
			selectedId: "main:b",
		});
		expect(line).not.toContain("\n");
		expect(line).not.toContain("\t");
		expect(plain(line)).toMatch(/fix +the build/);
	});

	it("marks the selected member with the cursor glyph and no other", () => {
		const cursor = theme.symbol("nav.cursor");
		const line = plain(
			renderRoomStripLine([member("main:a", "alpha"), member("main:b", "beta"), member("main:c", "gamma")], {
				columns: 200,
				currentId: "main:a",
				selectedId: "main:c",
			}),
		);
		const cells = line.split("   ");
		const withCursor = cells.filter(cell => cell.startsWith(cursor));
		expect(withCursor).toHaveLength(1);
		expect(withCursor[0]).toContain("gamma");
		expect(line.indexOf("alpha")).toBeLessThan(line.indexOf("beta"));
		expect(line.indexOf("beta")).toBeLessThan(line.indexOf("gamma"));
	});

	it("appends what a running peer is doing and nothing for an idle one", () => {
		const line = plain(
			renderRoomStripLine(
				[member("main:a", "alpha", { status: "running", activity: "editing tui.ts" }), member("main:b", "beta")],
				{ columns: 200, currentId: "main:a", selectedId: "main:b" },
			),
		);
		expect(line).toContain("alpha · editing tui.ts");
		expect(line).not.toContain("beta ·");
	});

	it("drops the hint before it drops a member, and never exceeds the columns", () => {
		const members = [member("main:a", "alpha"), member("main:b", "beta")];
		const wide = renderRoomStripLine(members, { columns: 200, currentId: "main:a", selectedId: "main:b" });
		expect(plain(wide)).toContain("Enter switch");

		const withoutHint = plain(wide).indexOf("  ←/→");
		const narrow = renderRoomStripLine(members, { columns: withoutHint, currentId: "main:a", selectedId: "main:b" });
		expect(plain(narrow)).not.toContain("Enter switch");
		expect(plain(narrow)).toContain("alpha");
		expect(plain(narrow)).toContain("beta");
		expect(visibleWidth(narrow ?? "")).toBeLessThanOrEqual(withoutHint);

		const cramped = renderRoomStripLine(members, { columns: 12, currentId: "main:a", selectedId: "main:b" });
		expect(visibleWidth(cramped ?? "")).toBeLessThanOrEqual(12);
		expect(plain(cramped)).toContain("Room");
	});
});
