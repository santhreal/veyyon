/**
 * The order slash-command categories are shown in when the menu is browsed unfiltered.
 *
 * WHY IT IS NOT IN `builtin-registry.ts`. That module declares every builtin command, so it imports every
 * command implementation and reaches 1,381 modules. This list is eight strings and it decides presentation,
 * which is a question the autocomplete asks without needing a single command body:
 * `modes/prompt-action-autocomplete.ts` imported the registry for this name alone and paid 1,149 marginal
 * modules for it. The registry re-exports the name it used to declare, so nothing else changed.
 *
 * A category not listed here still renders; it sorts after the listed ones by first appearance, which is
 * also where extension-supplied groups (skills, custom, extensions) land. That is why this can be a plain
 * list rather than something derived from the registry: it is an ordering PREFERENCE over categories, not a
 * claim about which categories exist, so it cannot fall out of step with the commands themselves.
 *
 * This module has no imports.
 */

/**
 * Deliberate category sequence: what you reach for most sits first (session and mode control), setup and
 * reference material last. The one owner of the browse order, so registry order stops mattering for headers.
 */
export const BUILTIN_SLASH_COMMAND_CATEGORY_ORDER: readonly string[] = [
	"session",
	"modes",
	"model",
	"context",
	"share",
	"workspace",
	"setup",
	"info",
] as const;
