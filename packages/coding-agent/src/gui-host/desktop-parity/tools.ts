/**
 * How the desktop presents each tool call the terminal can render.
 *
 * The host builds a tool call's presentation from the tool instance's own
 * `view` and falls back to the generic presentation (tool name, raw
 * arguments, plain-text result) when the instance has none. The terminal
 * draws from the view registry. A tool whose card exists only in the registry
 * is therefore drawn generically in the window:
 *
 * - `host`: the window receives the tool's own card, the one the terminal draws.
 * - `optOut`: neither host draws a card; the generic presentation is the tool's presentation.
 * - `gap`: the terminal draws a card and the window receives the generic presentation.
 */
import type { DesktopCarrier } from "./carrier";

const OWN_CARD = { host: "the tool's own card, built from the view on the tool instance" } as const;

const GENERIC_ON_BOTH_HOSTS = "no card on either host; the result is a short text confirmation the generic row shows whole";

/** The generic row a gap falls back to, prefixed to every gap's impact. */
const GENERIC_ROW = "the window draws the generic row (tool name, raw arguments, plain-text result)";

export const TOOL_PRESENTATIONS: Readonly<Record<string, DesktopCarrier>> = {
	apply_patch: {
		host: "the edit card: apply_patch is the provider-side spelling of edit and shares its view definition",
	},
	argot_load: { optOut: GENERIC_ON_BOTH_HOSTS },
	argot_unload: { optOut: GENERIC_ON_BOTH_HOSTS },
	ask: {
		gap: `${GENERIC_ROW} instead of the question card; the question is still answered in the interaction dock`,
	},
	ast_edit: { gap: `${GENERIC_ROW} instead of the pattern and rewrite card` },
	bash: OWN_CARD,
	browser: { gap: `${GENERIC_ROW} instead of the browser action card and its script output` },
	checkpoint: { optOut: GENERIC_ON_BOTH_HOSTS },
	debug: OWN_CARD,
	edit: OWN_CARD,
	eval: OWN_CARD,
	github: { gap: `${GENERIC_ROW} instead of the GitHub card` },
	goal: OWN_CARD,
	inspect_image: OWN_CARD,
	irc: { gap: `${GENERIC_ROW} instead of the message card with sender and recipient` },
	job: OWN_CARD,
	launch: { gap: `${GENERIC_ROW} instead of the supervised-process card with its readiness and logs` },
	learn: { optOut: GENERIC_ON_BOTH_HOSTS },
	lsp: OWN_CARD,
	manage_skill: { optOut: GENERIC_ON_BOTH_HOSTS },
	memory_edit: { optOut: GENERIC_ON_BOTH_HOSTS },
	read: { gap: `${GENERIC_ROW} instead of the file card with its path, range and excerpt` },
	recall: OWN_CARD,
	reflect: OWN_CARD,
	report_finding: OWN_CARD,
	report_tool_issue: { optOut: GENERIC_ON_BOTH_HOSTS },
	resolve: OWN_CARD,
	retain: OWN_CARD,
	rewind: { optOut: GENERIC_ON_BOTH_HOSTS },
	search: { gap: `${GENERIC_ROW} instead of the grouped match card` },
	search_tool_bm25: OWN_CARD,
	set_cwd: OWN_CARD,
	ssh: OWN_CARD,
	task: OWN_CARD,
	todo: { gap: `${GENERIC_ROW} instead of the checklist card` },
	vibe_kill: OWN_CARD,
	vibe_list: OWN_CARD,
	vibe_send: OWN_CARD,
	vibe_spawn: OWN_CARD,
	vibe_wait: OWN_CARD,
	web_search: { gap: `${GENERIC_ROW} instead of the query and sources card` },
	write: { gap: `${GENERIC_ROW} instead of the path and content preview card` },
	yield: { optOut: "no card on either host; the yielded result reaches the parent, not the reader" },
};
