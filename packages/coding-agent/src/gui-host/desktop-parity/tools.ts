/**
 * How the desktop presents each tool call the terminal can render.
 *
 * The host builds a tool call's presentation from the view the terminal draws
 * with: the tool instance's own `view`, else its entry in the view registry.
 * It falls back to the generic presentation (tool name, raw arguments,
 * plain-text result) only when neither exists:
 *
 * - `host`: the window receives the card the terminal draws.
 * - `optOut`: neither host draws a card; the generic presentation is the tool's presentation.
 * - `gap`: the terminal draws a card and the window receives the generic presentation.
 */
import type { DesktopCarrier } from "./carrier";

const OWN_CARD = {
	host: "the card the terminal draws, built from the view on the tool instance or its view-registry entry",
} as const;

const GENERIC_ON_BOTH_HOSTS =
	"no card on either host; the result is a short text confirmation the generic row shows whole";

export const TOOL_PRESENTATIONS: Readonly<Record<string, DesktopCarrier>> = {
	apply_patch: {
		host: "the edit card: apply_patch is the provider-side spelling of edit and shares its view definition",
	},
	argot_load: { optOut: GENERIC_ON_BOTH_HOSTS },
	argot_unload: { optOut: GENERIC_ON_BOTH_HOSTS },
	ask: OWN_CARD,
	ast_edit: OWN_CARD,
	bash: OWN_CARD,
	browser: OWN_CARD,
	checkpoint: { optOut: GENERIC_ON_BOTH_HOSTS },
	debug: OWN_CARD,
	edit: OWN_CARD,
	eval: OWN_CARD,
	github: OWN_CARD,
	goal: OWN_CARD,
	inspect_image: OWN_CARD,
	irc: OWN_CARD,
	job: OWN_CARD,
	launch: OWN_CARD,
	learn: { optOut: GENERIC_ON_BOTH_HOSTS },
	lsp: OWN_CARD,
	manage_skill: { optOut: GENERIC_ON_BOTH_HOSTS },
	memory_edit: { optOut: GENERIC_ON_BOTH_HOSTS },
	read: OWN_CARD,
	recall: OWN_CARD,
	reflect: OWN_CARD,
	report_finding: OWN_CARD,
	report_tool_issue: { optOut: GENERIC_ON_BOTH_HOSTS },
	resolve: OWN_CARD,
	retain: OWN_CARD,
	rewind: { optOut: GENERIC_ON_BOTH_HOSTS },
	search: OWN_CARD,
	search_tool_bm25: OWN_CARD,
	set_cwd: OWN_CARD,
	ssh: OWN_CARD,
	task: OWN_CARD,
	todo: OWN_CARD,
	vibe_kill: OWN_CARD,
	vibe_list: OWN_CARD,
	vibe_send: OWN_CARD,
	vibe_spawn: OWN_CARD,
	vibe_wait: OWN_CARD,
	web_search: OWN_CARD,
	write: OWN_CARD,
	yield: { optOut: "no card on either host; the yielded result reaches the parent, not the reader" },
};
