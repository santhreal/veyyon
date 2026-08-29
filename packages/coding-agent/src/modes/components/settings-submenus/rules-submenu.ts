import { type SelectItem, SelectList, Spacer, Text } from "@veyyon/tui";
import { clamp, collapseWhitespace, errorMessage } from "@veyyon/utils";
import { BUILTIN_DEFAULTS_PROVIDER_ID, type Rule, ruleCapability } from "../../../capability/rule";
import { settings } from "../../../config/settings";
import { loadCapability } from "../../../discovery";
import { getSelectListTheme, theme } from "../../theme/theme";
import { MouseRoutedSubmenu } from "../select-list-mouse-routing";

import { RULE_LIST_MAX_ROWS, ruleSectionLabel, ruleSectionRank } from "./rules-submenu-helpers";

export class RulesSubmenu extends MouseRoutedSubmenu {
	#selectList: SelectList | undefined;
	#rules: Rule[] = [];
	#loadError: string | undefined;
	#loaded = false;
	#focused: string | undefined;
	#openSection: string | undefined;
	#focusedSection: string | undefined;

	constructor(
		private readonly cwd: string,
		private readonly onChange: () => void,
		private readonly onCancel: () => void,
		private readonly requestRender?: () => void,
	) {
		super();
		this.#show();
		void this.#load();
	}

	async #load(): Promise<void> {
		try {
			const result = await loadCapability<Rule>(ruleCapability.id, { cwd: this.cwd });
			const byName = new Map<string, Rule>();
			for (const rule of result.items) {
				if (!byName.has(rule.name)) byName.set(rule.name, rule);
			}
			this.#rules = Array.from(byName.values()).sort(
				(a, b) => ruleSectionRank(a) - ruleSectionRank(b) || a.name.localeCompare(b.name),
			);
		} catch (error) {
			this.#loadError = errorMessage(error);
		}
		this.#loaded = true;
		this.#show();
		this.requestRender?.();
	}

	#disabled(): Set<string> {
		return this.#nameSet("ttsr.disabledRules");
	}

	#enabledExperiments(): Set<string> {
		return this.#nameSet("ttsr.experimentalRules");
	}

	#nameSet(path: "ttsr.disabledRules" | "ttsr.experimentalRules"): Set<string> {
		const stored = settings.get(path);
		const names = Array.isArray(stored) ? stored : [];
		return new Set(names.map(name => String(name).trim()).filter(name => name.length > 0));
	}

	#toggle(name: string): void {
		const rule = this.#rules.find(candidate => candidate.name === name);
		if (rule?.experimental === true) {
			const enabled = this.#enabledExperiments();
			if (enabled.has(name)) enabled.delete(name);
			else enabled.add(name);
			settings.set("ttsr.experimentalRules", Array.from(enabled).sort());
		} else {
			const disabled = this.#disabled();
			if (disabled.has(name)) disabled.delete(name);
			else disabled.add(name);
			settings.set("ttsr.disabledRules", Array.from(disabled).sort());
		}
		this.onChange();
		this.#focused = name;
		this.#show();
		this.requestRender?.();
	}

	#kind(rule: Rule): string {
		if ((rule.condition?.length ?? 0) > 0 || (rule.astCondition?.length ?? 0) > 0) return "on match";
		if (rule.alwaysApply === true) return "always";
		if (rule.description) return "on request";
		return "inert";
	}

	#isOff(rule: Rule, disabled: ReadonlySet<string>, experiments: ReadonlySet<string>, builtinOff: boolean): boolean {
		if (disabled.has(rule.name)) return true;
		if (builtinOff && rule._source?.provider === BUILTIN_DEFAULTS_PROVIDER_ID) return true;
		return rule.experimental === true && !experiments.has(rule.name);
	}

	#sections(): { label: string; rules: Rule[] }[] {
		const sections: { label: string; rules: Rule[] }[] = [];
		for (const rule of this.#rules) {
			const label = ruleSectionLabel(rule);
			const existing = sections.find(section => section.label === label);
			if (existing) existing.rules.push(rule);
			else sections.push({ label, rules: [rule] });
		}
		return sections;
	}

	#sectionSummary(rules: readonly Rule[], off: number): string {
		const total = `${rules.length} rule${rules.length === 1 ? "" : "s"}`;
		if (off === 0) return `${total} · ${theme.fg("success", "all on")}`;
		if (off === rules.length) return `${total} · ${theme.fg("dim", "all off")}`;
		return `${total} · ${theme.fg("dim", `${off} off`)}`;
	}

	#header(subtitle: string): void {
		this.clear();
		this.addChild(new Text(theme.bold(theme.fg("accent", "Rules")), 0, 0));
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("muted", subtitle), 0, 0));
		this.addChild(new Spacer(1));
		this.#selectList = undefined;
	}

	#warnings(builtinOff: boolean): void {
		if (settings.get("ttsr.enabled") !== true) {
			this.addChild(new Text(theme.fg("warning", "  Rule matching is off (Stream Interrupts → TTSR)."), 0, 0));
			this.addChild(new Spacer(1));
		}
		if (builtinOff) {
			this.addChild(new Text(theme.fg("warning", "  Built-in rules are off, so every bundled rule is."), 0, 0));
			this.addChild(new Spacer(1));
		}
	}

	#finishList(items: SelectItem[], focused: string | undefined, action: string, back: string): void {
		const visible = clamp(items.length, 1, RULE_LIST_MAX_ROWS);
		this.#selectList = new SelectList(items, visible, getSelectListTheme(), {
			minPrimaryColumnWidth: 1,
			maxPrimaryColumnWidth: 32,
		});
		const focusedIndex = focused ? items.findIndex(item => item.value === focused) : -1;
		if (focusedIndex >= 0) this.#selectList.setSelectedIndex(focusedIndex);
		this.addChild(this.#selectList);
		this.addChild(new Spacer(1));
		const filterHint = items.length > visible ? " · type to filter" : "";
		this.addChild(new Text(theme.fg("dim", `  ${action}${filterHint} · ${back}`), 0, 0));
	}

	#show(): void {
		if (this.#loadError) {
			this.#header("Every rule this project loads.");
			this.addChild(new Text(theme.fg("error", `  Could not read the rule sources: ${this.#loadError}`), 0, 0));
			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.fg("dim", "  Esc to go back"), 0, 0));
			return;
		}
		if (!this.#loaded) {
			this.#header("Every rule this project loads.");
			this.addChild(new Text(theme.fg("dim", "  Reading rules…"), 0, 0));
			return;
		}
		if (this.#openSection === undefined) this.#showSections();
		else this.#showSection(this.#openSection);
	}

	#showSections(): void {
		const builtinOff = settings.get("ttsr.builtinRules") !== true;
		this.#header("Rules by section. Enter opens one.");
		this.#warnings(builtinOff);

		const disabled = this.#disabled();
		const experiments = this.#enabledExperiments();
		const sections = this.#sections();
		if (sections.length === 0) {
			this.addChild(new Text(theme.fg("dim", "  No rules found."), 0, 0));
			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.fg("dim", "  Esc to go back"), 0, 0));
			return;
		}

		const items: SelectItem[] = new Array(sections.length);
		for (let si = 0; si < sections.length; si++) {
			const section = sections[si]!;
			let off = 0;
			for (let ri = 0; ri < section.rules.length; ri++) {
				if (this.#isOff(section.rules[ri]!, disabled, experiments, builtinOff)) off++;
			}
			items[si] = {
				value: section.label,
				label: section.label,
				description: this.#sectionSummary(section.rules, off),
			};
		}
		this.#finishList(items, this.#focusedSection, "Enter to open", "Esc to go back");
		if (this.#selectList) {
			this.#selectList.onSelect = item => {
				this.#openSection = item.value;
				this.#focusedSection = item.value;
				this.#focused = undefined;
				this.#show();
				this.requestRender?.();
			};
			this.#selectList.onCancel = this.onCancel;
		}
	}

	#showSection(label: string): void {
		const builtinOff = settings.get("ttsr.builtinRules") !== true;
		const section = this.#sections().find(candidate => candidate.label === label);
		if (!section) {
			this.#openSection = undefined;
			this.#showSections();
			return;
		}
		this.#header(`${label} — Enter turns a rule off, or back on.`);
		this.#warnings(builtinOff);

		const disabled = this.#disabled();
		const experiments = this.#enabledExperiments();
		const items: SelectItem[] = section.rules.map(rule => {
			const state = this.#isOff(rule, disabled, experiments, builtinOff)
				? theme.fg("dim", "off")
				: theme.fg("success", "on");
			const detail = rule.description ? ` · ${collapseWhitespace(rule.description)}` : "";
			return {
				value: rule.name,
				label: rule.name,
				description: `${state} · ${this.#kind(rule)}${detail}`,
			};
		});
		this.#finishList(items, this.#focused, "Enter to toggle", "Esc for sections");
		if (this.#selectList) {
			this.#selectList.onSelect = item => this.#toggle(item.value);
			this.#selectList.onCancel = () => {
				this.#openSection = undefined;
				this.#show();
				this.requestRender?.();
			};
		}
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
