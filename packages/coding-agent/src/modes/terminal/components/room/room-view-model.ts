/**
 * What the room view draws, and nothing it draws from.
 *
 * The room's windows are a projection of each conversation: its state, the
 * prompt it is working on and the last things it did. The controller builds
 * these from the live sessions (`controllers/room-window-feed.ts`); the stage and
 * the window painter read only these shapes, so a frame of the room is a pure
 * function of a list of snapshots and three motion values.
 */

/** Where a conversation is in its turn. */
export type RoomWindowState =
	| { readonly kind: "new" }
	| {
			readonly kind: "working";
			/** When the turn started, in ms since epoch. */
			readonly since: number;
			readonly activity: "starting" | "thinking" | "writing" | "tool" | "compacting" | "retrying";
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
	/** The conversation's first prompt, first line: the title a nameless conversation goes by. */
	readonly lead: string | undefined;
	readonly model: string | undefined;
	/** Working directory, already shortened for display. */
	readonly cwd: string;
}

/** One member of the room as the stage sees it. */
export interface RoomStageMember {
	/** Registry id of the driving agent. */
	readonly id: string;
	/** Read on every frame the window is drawn; cheap and never throws. */
	snapshot(): RoomWindowSnapshot;
	/** Dialogs this conversation is holding until it is on screen. */
	readonly waitingDialogs: number;
	/** The conversation the room was opened from. */
	readonly origin: boolean;
}
