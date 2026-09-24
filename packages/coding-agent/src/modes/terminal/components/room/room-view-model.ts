/**
 * What the room view draws, and nothing it draws from.
 *
 * The room's windows are a projection of each conversation: its state, the
 * prompt it is working on and the last things it did. The controller builds
 * these from the live sessions (`controllers/room-window-feed.ts`); the stage and
 * the window painter read only these shapes, so a frame of the room is a pure
 * function of a list of snapshots and three motion values.
 */

import { formatClock } from "@veyyon/utils/format";
import { truncateToWidth } from "@veyyon/utils/width";

/** Everything a working conversation can be doing, in the order a turn usually goes through them. */
export const ROOM_ACTIVITIES = ["starting", "thinking", "writing", "tool", "compacting", "retrying"] as const;

/** What a working conversation is doing right now. */
export type RoomActivity = (typeof ROOM_ACTIVITIES)[number];

/** Where a conversation is in its turn. */
export type RoomWindowState =
	| { readonly kind: "new" }
	| {
			readonly kind: "working";
			/** When the turn started, in ms since epoch. */
			readonly since: number;
			readonly activity: RoomActivity;
	  }
	| { readonly kind: "done"; readonly at: number }
	| { readonly kind: "failed"; readonly reason: string }
	| { readonly kind: "stopped" };

/** One entry of a window's feed, oldest first. */
export type RoomFeedBlock =
	| { readonly kind: "prompt"; readonly text: string }
	| {
			readonly kind: "tool";
			readonly label: string;
			readonly detail: string;
			readonly state: "running" | "ok" | "error";
	  }
	| { readonly kind: "text"; readonly text: string }
	| { readonly kind: "thinking" }
	| { readonly kind: "note"; readonly text: string; readonly tone: "error" | "muted" };

/** A conversation as its window shows it. Display-safe: every string is already sanitized and expanded. */
export interface RoomWindowSnapshot {
	readonly state: RoomWindowState;
	/** The prompt being worked on and what followed it. */
	readonly blocks: readonly RoomFeedBlock[];
	/** The session's name, when it has one. */
	readonly title: string | undefined;
	readonly model: string | undefined;
	/** Working directory, already shortened for display. */
	readonly cwd: string;
}

/** A conversation's unsent draft as its window shows it. Display-safe. */
export interface RoomDraft {
	/** The first line of its text that has anything on it; empty when the draft is only attachments. */
	readonly line: string;
	/** Images attached to it. */
	readonly images: number;
	/** Other files attached to it. */
	readonly files: number;
}

/** `["1 image", "2 files"]`: what a draft has attached, in words. */
export function roomDraftAttachments(draft: RoomDraft): string[] {
	const count = (n: number, one: string): string => (n === 1 ? `1 ${one}` : `${n} ${one}s`);
	const parts: string[] = [];
	if (draft.images > 0) parts.push(count(draft.images, "image"));
	if (draft.files > 0) parts.push(count(draft.files, "file"));
	return parts;
}

/** One member of the room as the stage sees it. */
export interface RoomStageMember {
	/** Registry id of the driving agent. */
	readonly id: string;
	/** Read on every frame the window is drawn; cheap and never throws. */
	snapshot(): RoomWindowSnapshot;
	/** Dialogs this conversation is holding until it is on screen. */
	readonly waitingDialogs: number;
	/** What the composer holds unsent for this conversation, when anything. */
	readonly draft: RoomDraft | undefined;
	/** The conversation the room was opened from. */
	readonly origin: boolean;
}

/**
 * What a conversation goes by in a line of text: its session name, else the
 * prompt it is on, else nothing. The first prompt is not the name: a session
 * opened with `hi` would go by `hi` for the rest of its life.
 */
export function roomWindowName(snapshot: RoomWindowSnapshot): string | undefined {
	if (snapshot.title !== undefined) return snapshot.title;
	const head = snapshot.blocks[0];
	return head?.kind === "prompt" ? head.text.split("\n", 1)[0] : undefined;
}

/** The longest tool name a state spells out before cutting it. */
const STATE_TOOL_WIDTH = 16;

/** What a working conversation is doing, in one or two words: `thinking`, `running bash`. */
function activityWord(activity: RoomActivity, blocks: readonly RoomFeedBlock[]): string {
	if (activity !== "tool") return activity;
	for (let i = blocks.length - 1; i >= 0; i--) {
		const block = blocks[i]!;
		if (block.kind === "tool" && block.state === "running") {
			return `running ${truncateToWidth(block.label, STATE_TOOL_WIDTH)}`;
		}
	}
	return "running";
}

/** `14:05`, local time. */
function clockTime(at: number): string {
	const date = new Date(at);
	return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/**
 * What a conversation's state is called, and the time that goes beside it:
 * `writing` and `0:41`, `done` and `14:05`, `failed` and nothing. The window
 * edge and `/room list` both say it this way. A finished conversation gets the
 * time of day it finished rather than how long ago, so it reads the same until
 * something changes and an idle room repaints nothing.
 */
export function roomStateWords(
	snapshot: RoomWindowSnapshot,
	now: number,
): { readonly word: string; readonly time: string } {
	const state = snapshot.state;
	switch (state.kind) {
		case "working":
			return { word: activityWord(state.activity, snapshot.blocks), time: formatClock(now - state.since) };
		case "done":
			return { word: "done", time: clockTime(state.at) };
		default:
			return { word: state.kind, time: "" };
	}
}
