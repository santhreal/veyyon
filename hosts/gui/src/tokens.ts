/**
 * What a graphical host calls each thing the view contract names.
 *
 * A tone and a status are meanings, so a host answers them in its own vocabulary: the terminal
 * answers with a theme colour and a glyph, and this host answers with a class name and a word a
 * screen reader can say. Both records are `Record<Tone, …>` and `Record<Status, …>` over the
 * contract's own unions, which is the property that makes `contracts/view` a contract: a tone added
 * there fails `check:ts` in every host until each one says what it looks like, rather than being
 * drawn in whatever the first host's fallback happened to be.
 *
 * The class names are the host's whole appearance surface. Nothing here states a colour, because a
 * stylesheet an embedder owns is where a colour belongs, and a host that wrote `#8a8f98` into its
 * markup would be the terminal's mistake in a browser.
 */

import type { ViewDiffSide, ViewStatus, ViewTone } from "@veyyon/view";

/** The class each tone draws under. */
export const TONE_CLASSES: Record<ViewTone, string> = {
	title: "v-tone-title",
	accent: "v-tone-accent",
	output: "v-tone-output",
	link: "v-tone-link",
	muted: "v-tone-muted",
	dim: "v-tone-dim",
	diffAdded: "v-tone-diff-added",
	diffRemoved: "v-tone-diff-removed",
	success: "v-tone-success",
	warning: "v-tone-warning",
	error: "v-tone-error",
	info: "v-tone-info",
	cost: "v-tone-cost",
	text: "v-tone-text",
};

/** The class each status draws under. */
export const STATUS_CLASSES: Record<ViewStatus, string> = {
	success: "v-status-success",
	done: "v-status-done",
	error: "v-status-error",
	warning: "v-status-warning",
	info: "v-status-info",
	pending: "v-status-pending",
	running: "v-status-running",
	aborted: "v-status-aborted",
};

/**
 * What each status is called out loud.
 *
 * A terminal states a status as a glyph and a colour, neither of which a screen reader reads, so
 * this host states the word as well and lets a stylesheet replace it with whatever it draws.
 */
export const STATUS_LABELS: Record<ViewStatus, string> = {
	success: "succeeded",
	done: "done",
	error: "failed",
	warning: "warning",
	info: "info",
	pending: "pending",
	running: "running",
	aborted: "aborted",
};

/** Whether a status reports work still in flight, which a host may animate. */
export const STATUS_IS_LIVE: Record<ViewStatus, boolean> = {
	success: false,
	done: false,
	error: false,
	warning: false,
	info: false,
	pending: true,
	running: true,
	aborted: false,
};

/** The class each side of a change draws under. */
export const DIFF_SIDE_CLASSES: Record<ViewDiffSide, string> = {
	added: "v-diff-added",
	removed: "v-diff-removed",
	context: "v-diff-context",
	gap: "v-diff-gap",
};

/** Every tone this host answers, in declaration order, for a caller that sweeps them. */
export const VIEW_TONES: readonly ViewTone[] = Object.freeze(Object.keys(TONE_CLASSES) as ViewTone[]);

/** Every status this host answers, in declaration order, for a caller that sweeps them. */
export const VIEW_STATUSES: readonly ViewStatus[] = Object.freeze(Object.keys(STATUS_CLASSES) as ViewStatus[]);

/** Every side of a change this host answers, in declaration order. */
export const VIEW_DIFF_SIDES: readonly ViewDiffSide[] = Object.freeze(Object.keys(DIFF_SIDE_CLASSES) as ViewDiffSide[]);
