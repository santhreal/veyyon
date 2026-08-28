import { AUTO_COMPACTION_THRESHOLD, parseCompactionThreshold } from "@veyyon/agent-core";
import { type SelectItem, SelectList, Spacer, Text } from "@veyyon/tui";
import { settings } from "../../../config/settings";
import type { SubmenuOption } from "../../../config/settings-schema";
import { getSelectListTheme, theme } from "../../theme/theme";
import { MouseRoutedSubmenu } from "../select-list-mouse-routing";
import { TextInputSubmenu } from "../settings-submenus";

const THRESHOLD_CUSTOM_VALUE = "__custom__";

export type ThresholdMode = "auto" | "percent" | "tokens";

export function thresholdModeOf(raw: string): { mode: ThresholdMode; invalidRaw?: string } {
	const spec = parseCompactionThreshold(raw);
	if (spec.kind === "percent") return { mode: "percent" };
	if (spec.kind === "tokens") return { mode: "tokens" };
	return { mode: "auto", ...(spec.invalidRaw !== undefined ? { invalidRaw: spec.invalidRaw } : {}) };
}

export function formatThresholdShort(raw: string): string {
	const spec = parseCompactionThreshold(raw);
	if (spec.kind === "tokens") {
		if (spec.tokens % 1_000_000 === 0) return `${spec.tokens / 1_000_000}M`;
		if (spec.tokens % 1_000 === 0) return `${spec.tokens / 1_000}k`;
		return String(spec.tokens);
	}
	if (spec.kind === "percent") return `${spec.percent}%`;
	return raw;
}

export class CompactionThresholdSubmenu extends MouseRoutedSubmenu {
	#selectList: SelectList | undefined;

	constructor(
		private readonly options: ReadonlyArray<SubmenuOption>,
		private readonly onPersist: () => void,
		private readonly onClose: () => void,
		private readonly requestRender?: () => void,
	) {
		super();
		this.#showModes();
	}

	#currentRaw(): string {
		return String(settings.get("compaction.threshold") ?? AUTO_COMPACTION_THRESHOLD);
	}

	#marker(active: boolean): string {
		return active ? `${theme.fg("success", theme.status.enabled)} ` : "  ";
	}

	#showModes(): void {
		this.clear();
		this.#selectList = undefined;
		this.addChild(new Text(theme.bold(theme.fg("accent", "Auto-Compaction Threshold")), 0, 0));
		this.addChild(new Spacer(1));
		this.addChild(
			new Text(
				theme.fg(
					"muted",
					"When auto-compaction triggers. Auto uses the model's window minus the reserve; a percent scales with each model's window; a token amount is the same trigger on every model.",
				),
				0,
				0,
			),
		);
		this.addChild(new Spacer(1));

		const raw = this.#currentRaw();
		const { mode, invalidRaw } = thresholdModeOf(raw);
		if (invalidRaw !== undefined) {
			this.addChild(
				new Text(
					theme.fg(
						"warning",
						`Stored value "${invalidRaw}" is not auto, a percent, or a token amount; Auto is in effect.`,
					),
					0,
					0,
				),
			);
			this.addChild(new Spacer(1));
		}

		const current = theme.fg("dim", `(current: ${formatThresholdShort(raw)})`);
		const items: SelectItem[] = [
			{
				value: "auto",
				label: `${this.#marker(mode === "auto")}Auto`,
				description: "The model's context window minus the reserve",
			},
			{
				value: "percent",
				label: `${this.#marker(mode === "percent")}Percent${mode === "percent" ? ` ${current}` : ""}`,
				description: "Scales with each model's window",
			},
			{
				value: "tokens",
				label: `${this.#marker(mode === "tokens")}Tokens${mode === "tokens" ? ` ${current}` : ""}`,
				description: "The same trigger on every model",
			},
		];

		this.#selectList = new SelectList(items, items.length, getSelectListTheme());
		this.#selectList.setSelectedIndex(items.findIndex(item => item.value === mode));
		this.#selectList.onSelect = item => {
			if (item.value === "auto") {
				this.#persist(AUTO_COMPACTION_THRESHOLD);
				return;
			}
			if (item.value === "percent" || item.value === "tokens") {
				this.#showValuePicker(item.value);
				this.requestRender?.();
			}
		};
		this.#selectList.onCancel = this.onClose;
		this.addChild(this.#selectList);
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", "  Enter to choose · Esc to go back"), 0, 0));
	}

	#showValuePicker(mode: "percent" | "tokens"): void {
		this.clear();
		this.#selectList = undefined;
		const title = mode === "percent" ? "Auto-Compaction Threshold — Percent" : "Auto-Compaction Threshold — Tokens";
		this.addChild(new Text(theme.bold(theme.fg("accent", title)), 0, 0));
		this.addChild(new Spacer(1));
		this.addChild(
			new Text(
				theme.fg(
					"muted",
					mode === "percent"
						? "Compact once the context passes this share of the model's window. Follows the window when you switch models."
						: "Compact once the context passes this many tokens, on every model. Larger than the window compacts at the window's edge instead.",
				),
				0,
				0,
			),
		);
		this.addChild(new Spacer(1));

		const raw = this.#currentRaw();
		const presets = this.options.filter(option =>
			mode === "percent" ? option.value.endsWith("%") : /^[0-9_]+$/.test(option.value),
		);
		const items: SelectItem[] = presets.map(option => ({
			value: option.value,
			label: `${this.#marker(option.value === raw)}${option.label}`,
			...(option.description !== undefined ? { description: option.description } : {}),
		}));
		if (thresholdModeOf(raw).mode === mode && !presets.some(option => option.value === raw)) {
			items.unshift({
				value: raw,
				label: `${this.#marker(true)}${formatThresholdShort(raw)} ${theme.fg("dim", "(custom)")}`,
				description: "Set by hand; not one of the presets",
			});
		}
		items.push({
			value: THRESHOLD_CUSTOM_VALUE,
			label: "  Custom…",
			description: mode === "percent" ? "Type any whole percent from 1 to 99" : "Type any token amount",
		});

		this.#selectList = new SelectList(items, Math.min(items.length, 10), getSelectListTheme());
		const currentIndex = items.findIndex(item => item.value === raw);
		if (currentIndex !== -1) this.#selectList.setSelectedIndex(currentIndex);
		this.#selectList.onSelect = item => {
			if (item.value === THRESHOLD_CUSTOM_VALUE) {
				this.#showCustomInput(mode);
			} else {
				this.#persist(item.value);
			}
			this.requestRender?.();
		};
		this.#selectList.onCancel = () => {
			this.#showModes();
			this.requestRender?.();
		};
		this.addChild(this.#selectList);
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", "  Enter to select · Esc to go back"), 0, 0));
	}

	#showCustomInput(mode: "percent" | "tokens"): void {
		this.clear();
		this.#selectList = undefined;
		const raw = this.#currentRaw();
		const input = new TextInputSubmenu(
			mode === "percent" ? "Custom Percent" : "Custom Token Amount",
			mode === "percent"
				? "A whole percent from 1 to 99 (the parser's clamp range); the % sign is optional."
				: "A positive token amount, e.g. 170000. Underscores are fine (170_000).",
			thresholdModeOf(raw).mode === mode ? raw : "",
			value => {
				this.#persist(this.#validateCustom(mode, value));
				this.requestRender?.();
			},
			() => {
				this.#showValuePicker(mode);
				this.requestRender?.();
			},
		);
		this.addChild(input);
	}

	#validateCustom(mode: "percent" | "tokens", value: string): string {
		const text = value.trim();
		if (mode === "percent") {
			const percent = Number(text.replace(/%$/, "").trim());
			if (!Number.isInteger(percent) || percent < 1 || percent > 99) {
				throw new Error(`"${value}" is not a whole percent from 1 to 99.`);
			}
			return `${percent}%`;
		}
		const tokens = Number(text.replace(/_/g, ""));
		if (!Number.isInteger(tokens) || tokens <= 0) {
			throw new Error(`"${value}" is not a positive token amount (e.g. 170000).`);
		}
		return String(tokens);
	}

	#persist(value: string): void {
		settings.set("compaction.threshold", value);
		this.onPersist();
		this.#showModes();
		this.requestRender?.();
	}

	mouseTarget(): SelectList | undefined {
		return this.#selectList;
	}

	handleInput(data: string): void {
		if (this.#selectList) {
			this.#selectList.handleInput(data);
			return;
		}
		this.children[0]?.handleInput?.(data);
	}
}
