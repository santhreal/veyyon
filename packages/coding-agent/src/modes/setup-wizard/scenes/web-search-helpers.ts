import type { SelectItem } from "@veyyon/tui";
import { SEARCH_PROVIDER_OPTIONS } from "../../../web/search/types";

export const MAX_VISIBLE = 8;

/** Reuse search provider metadata as the single source of truth for labels/descriptions. */
export const WEB_SEARCH_ITEMS: readonly SelectItem[] = SEARCH_PROVIDER_OPTIONS.map(option => ({
	value: option.value,
	label: option.label,
	description: option.description,
}));

export type Availability = "checking" | boolean;

/** "Web search" panel: picks the provider the web_search tool should prefer and reports whether the highlighted provider is ready to use given current */
