import type { Api, Model } from "@veyyon/ai";
import { matchesKey, type SelectItem, SelectList, Spacer, Text } from "@veyyon/tui";
import { clamp } from "@veyyon/utils";
import type { ModelRegistry } from "../../../config/model-registry";
import { normalizeModelPatternList } from "../../../config/model-resolver";
import { settings } from "../../../config/settings";
import type { SettingPath } from "../../../config/settings-schema";
import { hasConfigurableThinkingEffort } from "../../../thinking";
import { getSelectListTheme, theme } from "../../theme/theme";
import { formatSelectorSummary, renderEffortStep } from "../effort-picker";
import { pointerMotionEnabled } from "../modal-shell";
import { ModelSelectorPanel } from "../model-selector";
import { MouseRoutedSubmenu } from "../select-list-mouse-routing";
import { barePickerSelector, replaceModelChainEntry } from "./model-roles-submenu";

const CHAIN_ENTRY_PREFIX = "\u0000chain-entry:";
const CHAIN_ADD_ROW = "\u0000chain-add-row";
const CHAIN_CLEAR_ROW = "\u0000chain-clear-row";

export interface ModelChainSlot {
	write: (chain: string[] | undefined) => void;
}

export class ModelChainSubmenu extends MouseRoutedSubmenu {
	#selectList: SelectList | undefined;
	#chain: string[];

	constructor(
		private readonly slot: SettingPath | ModelChainSlot,
		private readonly registry: ModelRegistry,
		private readonly models: ReadonlyArray<Model>,
		private readonly title: string,
		current: string | string[] | undefined,
		private readonly done: (value?: string) => void,
		private readonly onChange: (value: string[] | undefined) => void,
		private readonly requestRender?: () => void,
	) {
		super();
		this.#chain = normalizeModelPatternList(current);
		if (this.#chain.length === 0) this.#showModelPicker(null);
		else this.#showChain();
	}

	#showChain(): void {
		this.clear();
		this.#selectList = undefined;
		this.addChild(new Text(theme.bold(theme.fg("accent", this.title)), 0, 0));
		this.addChild(new Spacer(1));
		this.addChild(
			new Text(theme.fg("muted", "Tried in order. The rest are used when the one above cannot run."), 0, 0),
		);
		this.addChild(new Spacer(1));

		const items: SelectItem[] = this.#chain.map((selector, index) => ({
			value: `${CHAIN_ENTRY_PREFIX}${index}`,
			label: `${index + 1}. ${formatSelectorSummary(selector)}`,
			description: index === 0 ? "first choice" : "fallback",
		}));
		items.push({ value: CHAIN_ADD_ROW, label: "Add fallback…", description: "pick a model, then its effort" });
		items.push({ value: CHAIN_CLEAR_ROW, label: "Clear (inherit)", description: "follow the main model" });

		this.#selectList = new SelectList(items, clamp(items.length, 1, 12), getSelectListTheme());
		this.#selectList.onSelect = item => {
			if (item.value === CHAIN_ADD_ROW) this.#showModelPicker(null);
			else if (item.value === CHAIN_CLEAR_ROW) this.#clear();
			else this.#showModelPicker(Number(item.value.slice(CHAIN_ENTRY_PREFIX.length)));
			this.requestRender?.();
		};
		this.#selectList.onCancel = () => this.done(this.#chain.join(","));
		this.addChild(this.#selectList);
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", "  Enter edits · Del removes · Esc to go back"), 0, 0));
	}

	#removeSelectedRow(): void {
		const value = this.#selectList?.getSelectedItem?.()?.value;
		if (!value?.startsWith(CHAIN_ENTRY_PREFIX)) return;
		const index = Number(value.slice(CHAIN_ENTRY_PREFIX.length));
		if (!Number.isInteger(index) || index < 0 || index >= this.#chain.length) return;
		this.#chain.splice(index, 1);
		this.#persistChain();
	}

	#showModelPicker(index: number | null): void {
		this.clear();
		this.#selectList = undefined;
		const current = index === null ? undefined : this.#chain[index];
		const position =
			index === 0 ? "first choice" : index === null ? `fallback ${this.#chain.length + 1}` : `fallback ${index + 1}`;
		const panel = new ModelSelectorPanel(
			settings,
			this.registry,
			this.models,
			{
				title: this.#chain.length === 0 ? this.title : `${this.title} · ${position}`,
				description:
					index === null ? "Pick a model to append to the chain." : "Pick a replacement for this position.",
				currentSelector: barePickerSelector(current, this.models as Model<Api>[]) || undefined,
				allowClear: true,
				clearLabel:
					index !== null
						? "(remove this position)"
						: this.#chain.length === 0
							? "(inherit main model)"
							: "(cancel adding fallback)",
			},
			{
				onPick: (model, selector) => {
					if (!hasConfigurableThinkingEffort(model)) {
						this.#store(selector, index);
						return;
					}
					this.#showEffortPicker(selector, model, index);
					this.requestRender?.();
				},
				onClear: () => this.#clearPicker(index),
				onCancel: () => {
					if (this.#chain.length === 0) this.done();
					else this.#showChain();
					this.requestRender?.();
				},
			},
		);
		panel.setHoverMotion({ requestRender: () => this.requestRender?.(), enabled: pointerMotionEnabled() });
		this.addChild(panel);
	}

	#showEffortPicker(selector: string, model: Model, index: number | null): void {
		this.#selectList = renderEffortStep(
			this,
			selector,
			model,
			value => this.#store(value, index),
			() => {
				this.#showModelPicker(index);
				this.requestRender?.();
			},
		);
	}

	#store(value: string, index: number | null): void {
		const next = replaceModelChainEntry(this.#chain, index, value, this.models as Model<Api>[]);
		if (!next) {
			this.#showChain();
			this.requestRender?.();
			return;
		}
		this.#chain = next;
		this.#persistChain();
	}

	#clearPicker(index: number | null): void {
		if (index !== null && Number.isInteger(index) && index >= 0 && index < this.#chain.length) {
			this.#chain.splice(index, 1);
			this.#persistChain();
		} else if (this.#chain.length === 0) {
			this.#clear();
		} else {
			this.#showChain();
			this.requestRender?.();
		}
	}

	#clear(): void {
		this.#chain = [];
		this.#persist(undefined);
		this.onChange(undefined);
		this.done("inherit");
	}

	#persistChain(): void {
		const value = this.#chain.slice();
		this.#persist(value.length === 0 ? undefined : value);
		this.onChange(value.length === 0 ? undefined : value);
		this.#showChain();
		this.requestRender?.();
	}

	#persist(chain: string[] | undefined): void {
		if (typeof this.slot !== "string") {
			this.slot.write(chain);
			return;
		}
		if (chain === undefined) settings.unset(this.slot);
		else settings.set(this.slot, chain as never);
	}

	mouseTarget(): SelectList | ModelSelectorPanel | undefined {
		return (
			this.#selectList ??
			this.children.find((child): child is ModelSelectorPanel => child instanceof ModelSelectorPanel)
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
