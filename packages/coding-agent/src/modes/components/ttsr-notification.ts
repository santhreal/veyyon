import type { Rule } from "../../capability/rule";
import { withIcon } from "../../modes/theme/icon-label";
import { theme } from "../../modes/theme/theme";
import { actionKeyHint } from "../utils/key-hint";
import { type TranscriptNote, TranscriptNoteComponent } from "./transcript-note";

/** Collapsed view shows at most this many rules before eliding the rest. */
const MAX_COLLAPSED_RULES = 4;

/**
 * A TTSR (Time Traveling Stream Rules) notification: a rule matched and the stream is
 * being rewound. One block can carry several rules, since a single event may match
 * more than one and consecutive notifications merge into the previous block through
 * {@link addRules} while it is still the live transcript tail.
 *
 * It is a {@link TranscriptNoteComponent}, so the rule names and descriptions can use
 * colour: the block used to invert its whole width to get a yellow background, which
 * spent the foreground and left bold and italic as the only styling available inside
 * it.
 */
export class TtsrNotificationComponent extends TranscriptNoteComponent {
	#expanded = false;
	#rules: Rule[];

	constructor(rules: Rule[]) {
		super({ tone: "warning", headline: "", rows: [] });
		this.#rules = [...rules];
		this.#rebuild();
	}

	/** Merge additional rules into this block (deduped by rule name). */
	addRules(rules: Rule[]): void {
		let changed = false;
		for (const rule of rules) {
			if (this.#rules.some(existing => existing.name === rule.name)) continue;
			this.#rules.push(rule);
			changed = true;
		}
		if (changed) this.#rebuild();
	}

	setExpanded(expanded: boolean): void {
		if (this.#expanded !== expanded) {
			this.#expanded = expanded;
			this.#rebuild();
		}
	}

	isExpanded(): boolean {
		return this.#expanded;
	}

	/**
	 * How this block names the expand gesture, or `""` when nothing is bound to it.
	 *
	 * Read at rebuild time rather than at construction, because a rebind takes
	 * effect on the next render and this block outlives one: it merges later rules
	 * into itself through {@link addRules} while it is still the transcript tail.
	 */
	#expandHint(): string {
		return actionKeyHint("app.tools.expand");
	}

	#rebuild(): void {
		this.setNote(this.#rules.length === 1 ? this.#single(this.#rules[0]!) : this.#multi());
	}

	#single(rule: Rule): TranscriptNote {
		const headline = withIcon(theme.icon.warning, `Injecting rule: ${rule.name}  ${theme.icon.rewind}`);
		const desc = (rule.description || rule.content)?.trim();
		if (!desc) return { tone: "warning", headline, rows: [] };

		let displayText = desc;
		let truncated = false;
		if (!this.#expanded) {
			const lines = desc.split("\n");
			if (lines.length > 2) {
				displayText = `${lines.slice(0, 2).join("\n")}…`;
				truncated = true;
			}
		}

		const rows = [theme.italic(theme.fg("text", displayText))];
		const hint = this.#expandHint();
		if (truncated && hint) rows.push(theme.italic(theme.fg("muted", `(${hint} to expand)`)));
		return { tone: "warning", headline, rows };
	}

	#multi(): TranscriptNote {
		const headline = withIcon(theme.icon.warning, `Injecting ${this.#rules.length} rules:  ${theme.icon.rewind}`);
		const visible = this.#expanded ? this.#rules : this.#rules.slice(0, MAX_COLLAPSED_RULES);
		const rows: string[] = [];
		let elidedDetail = false;
		for (const rule of visible) {
			const desc = (rule.description || rule.content)?.trim();
			let line = theme.bold(theme.fg("text", rule.name));
			if (desc) {
				let displayText = desc;
				if (!this.#expanded) {
					// One line per rule when collapsed; full description when expanded.
					const newline = desc.indexOf("\n");
					if (newline !== -1) {
						displayText = `${desc.slice(0, newline).trimEnd()}…`;
						elidedDetail = true;
					}
				}
				line += `${theme.fg("muted", ":")} ${theme.italic(theme.fg("text", displayText))}`;
			}
			rows.push(line);
		}

		const hidden = this.#rules.length - visible.length;
		const hint = this.#expandHint();
		// The COUNT is stated whether or not there is a key to name: a block that hides
		// four rules silently reads as a block with one rule in it.
		if (hidden > 0) {
			rows.push(theme.italic(theme.fg("muted", `… +${hidden} more${hint ? ` (${hint} to expand)` : ""}`)));
		} else if (elidedDetail && hint) {
			rows.push(theme.italic(theme.fg("muted", `(${hint} to expand)`)));
		}
		return { tone: "warning", headline, rows };
	}
}
