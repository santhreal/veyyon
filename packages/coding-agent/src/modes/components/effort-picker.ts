/**
 * The one place that builds a thinking-effort picker step.
 *
 * A model's thinking effort rides its selector string as a `:level` suffix
 * (`provider/id:high`), encoded by {@link formatModelSelectorValue}. Every
 * surface that assigns a model with an effort renders the same rows — an empty
 * "model default thinking" entry first (the bare selector, no suffix), then each
 * effort the model supports, in the model's own order. These helpers are that
 * single source so the settings single-slot picker, the settings role list, and
 * the advisor picker never grow divergent copies.
 */
import type { ThinkingLevel } from "@veyyon/agent-core";
import type { Effort } from "@veyyon/ai";
import { type Container, type SelectItem, SelectList, Spacer, Text } from "@veyyon/tui";
import { formatModelSelectorValue, parseModelString } from "../../config/model-resolver";
import { getSelectListTheme, theme } from "../theme/theme";

/**
 * The effort-picker rows: the empty "model default thinking" entry first (its
 * empty value formats to the bare selector), then each supported effort in the
 * model's own order. Split out so the ordering can be asserted directly.
 */
export function effortStepItems(efforts: readonly Effort[]): SelectItem[] {
	const items: SelectItem[] = [{ value: "", label: "(model default thinking)" }];
	for (const effort of efforts) items.push({ value: effort, label: effort });
	return items;
}

/**
 * Human summary of a stored model selector for a settings row: renders the
 * effort suffix as a readable ` · high` (e.g. `anthropic/claude-sonnet-4-5 · high`)
 * instead of the raw `:high` token, and returns the bare selector unchanged when
 * it carries no effort. Uses the same parser the resolver does, so a model id
 * that legitimately ends in a colon token is left intact. One owner so the
 * single-slot rows and the role list read identically.
 */
export function formatSelectorSummary(raw: string): string {
	const trimmed = raw.trim();
	if (!trimmed) return trimmed;
	const parsed = parseModelString(trimmed);
	return parsed?.thinkingLevel ? `${parsed.provider}/${parsed.id} · ${parsed.thinkingLevel}` : trimmed;
}

/**
 * The single effort-picker step for a fullscreen submenu: clears `container`,
 * renders the effort list into it, and returns the {@link SelectList} so the
 * caller can route keyboard input to it. Selecting a level calls `onPersist`
 * with the selector already carrying the `:level` suffix
 * ({@link formatModelSelectorValue}); the empty first row means "model default
 * thinking" (bare selector). Esc calls `onBack`.
 */
export function renderEffortStep(
	container: Container,
	selector: string,
	efforts: readonly Effort[],
	onPersist: (value: string) => void,
	onBack: () => void,
): SelectList {
	container.clear();
	const items = effortStepItems(efforts);
	const list = new SelectList(items, Math.max(1, items.length), getSelectListTheme());
	list.onSelect = item => {
		// `item.value` is one of the model's own supported efforts (or "" for the
		// model default); `formatModelSelectorValue` spells the `:level` suffix.
		const level = item.value ? (item.value as ThinkingLevel) : undefined;
		onPersist(formatModelSelectorValue(selector, level));
	};
	list.onCancel = onBack;
	container.addChild(new Text(theme.bold(theme.fg("accent", "Thinking effort")), 0, 0));
	container.addChild(new Spacer(1));
	container.addChild(
		new Text(theme.fg("muted", `Effort for ${selector} — applied when this model runs. Per active profile.`), 0, 0),
	);
	container.addChild(new Spacer(1));
	container.addChild(list);
	container.addChild(new Spacer(1));
	container.addChild(new Text(theme.fg("dim", "  Enter / click pick · Esc back to model"), 0, 0));
	return list;
}
