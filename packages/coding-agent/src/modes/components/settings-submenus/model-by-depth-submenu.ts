import type { Model } from "@veyyon/ai";
import { matchesKey, type SelectItem, SelectList, Spacer, Text } from "@veyyon/tui";
import { clamp } from "@veyyon/utils";
import type { ModelRegistry } from "../../../config/model-registry";
import { normalizeModelPatternList } from "../../../config/model-resolver";
import { settings } from "../../../config/settings";
import {
	clearSubagentModelByDepthRow,
	nextSubagentModelByDepth,
	SUBAGENT_MODEL_BY_DEPTH_PATH,
	subagentModelByDepthRowPath,
	subagentModelByDepthRows,
} from "../../../task/subagent-settings";
import { getSelectListTheme, theme } from "../../theme/theme";
import { formatSelectorSummary } from "../effort-picker";
import { MouseRoutedSubmenu } from "../select-list-mouse-routing";
import { ModelChainSubmenu } from "./model-chain-submenu";

const DEPTH_ADD_ROW = "\u0000depth-add-row";

export class SubagentModelByDepthSubmenu extends MouseRoutedSubmenu {
	#selectList: SelectList | undefined;

	constructor(
		private readonly registry: ModelRegistry,
		private readonly models: ReadonlyArray<Model>,
		private readonly onChange: () => void,
		private readonly onCancel: () => void,
		private readonly requestRender?: () => void,
	) {
		super();
		this.#showRows();
	}

	#showRows(): void {
		this.clear();
		this.#selectList = undefined;
		this.addChild(new Text(theme.bold(theme.fg("accent", "Models by Depth")), 0, 0));
		this.addChild(new Spacer(1));
		this.addChild(
			new Text(
				theme.fg(
					"muted",
					"A row outranks Subagent Model for a spawn at exactly that depth: 1 is a direct child, 2 a grandchild. Depths without a row follow Subagent Model.",
				),
				0,
				0,
			),
		);
		this.addChild(new Spacer(1));

		const rows = subagentModelByDepthRows(settings);
		const items: SelectItem[] = rows.map(row => {
			const chain = normalizeModelPatternList(row.value);
			const primary = chain[0] === undefined ? "" : formatSelectorSummary(chain[0]);
			const fallbacks = chain.length - 1;
			return {
				value: String(row.depth),
				label: `Depth ${row.depth}`,
				description: fallbacks > 0 ? `${primary}, +${fallbacks}` : primary,
			};
		});
		items.push({
			value: DEPTH_ADD_ROW,
			label: "Add depth…",
			description: `bind a chain to depth ${nextSubagentModelByDepth(settings)}`,
		});

		this.#selectList = new SelectList(items, clamp(items.length, 1, 12), getSelectListTheme());
		this.#selectList.onSelect = item => {
			this.#openDepth(item.value === DEPTH_ADD_ROW ? nextSubagentModelByDepth(settings) : Number(item.value));
			this.requestRender?.();
		};
		this.#selectList.onCancel = this.onCancel;
		this.addChild(this.#selectList);
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", "  Enter edits · Del clears a depth · Esc to go back"), 0, 0));
	}

	#openDepth(depth: number): void {
		this.clear();
		this.#selectList = undefined;
		const current = subagentModelByDepthRows(settings).find(row => row.depth === depth)?.value;
		this.addChild(
			new ModelChainSubmenu(
				subagentModelByDepthRowPath(depth),
				this.registry,
				this.models,
				`Depth ${depth}`,
				current,
				() => {
					if (subagentModelByDepthRows(settings).length === 0) settings.unset(SUBAGENT_MODEL_BY_DEPTH_PATH);
					this.onChange();
					this.#showRows();
					this.requestRender?.();
				},
				() => this.onChange(),
				this.requestRender,
			),
		);
	}

	#removeSelectedRow(): void {
		const value = this.#selectList?.getSelectedItem?.()?.value;
		if (value === undefined || value === DEPTH_ADD_ROW) return;
		clearSubagentModelByDepthRow(settings, Number(value));
		this.onChange();
		this.#showRows();
		this.requestRender?.();
	}

	mouseTarget(): SelectList | ModelChainSubmenu | undefined {
		return (
			this.#selectList ??
			this.children.find((child): child is ModelChainSubmenu => child instanceof ModelChainSubmenu)
		);
	}

	handleInput(data: string): void {
		if (this.#selectList && (matchesKey(data, "delete") || matchesKey(data, "backspace"))) {
			this.#removeSelectedRow();
			return;
		}
		if (this.#selectList) {
			this.#selectList.handleInput(data);
			return;
		}
		this.children[0]?.handleInput?.(data);
	}
}
