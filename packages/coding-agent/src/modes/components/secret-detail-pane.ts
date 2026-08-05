/**
 * The detail panel for the one credential the Secrets table has selected.
 *
 * WHY THIS EXISTS. The table can only afford three columns, so most of what the vault records
 * about an entry has nowhere to appear. `VaultEntry.createdAt` is written for every secret and
 * is currently shown nowhere in the product. The expansion log already knows which tools spent
 * each placeholder and how often, but that knowledge is never joined back to the roster, so the
 * question an operator actually arrives with, "why did this placeholder stop expanding", has no
 * screen that answers it. This pane is that screen.
 *
 * WHAT IT REFUSES TO DO. It never reads the vault, the audit log, or the filesystem: the row and
 * the usage figures arrive through the constructor, already gathered by the container. That is
 * what lets its tests assert exact rendered strings against a fixed clock with no temp directory.
 * It also never renders `entry.value`, on this card or anywhere else. The value is the one field
 * a credential manager must be able to hold without displaying, and a detail panel is exactly
 * where that rule would otherwise be broken by accident.
 */
import { type Component, padding, truncateToWidth, wrapTextWithAnsi } from "@veyyon/tui";
import { buildNamePlaceholder } from "../../secrets/placeholder";
import { describeAgo } from "../../secrets/secret-command";
import { describeTimeLeft, type ScopedVaultEntry } from "../../secrets/vault";
import { theme } from "../theme/theme";
import type { ManagerRow, SecretUsageStats } from "./secret-manager-types";

/**
 * Left margin before the label column, matching the table pane's body inset so the two panes
 * read as one card rather than two stacked widgets.
 */
const INDENT = "  ";

/** Gap between the label column and the value column, in one place so measuring matches joining. */
const LABEL_GAP = "  ";

/**
 * Every label this pane can print. Both row kinds draw from one list so the label column is the
 * same width in both, and a selection that moves between a secret and a broken vault file does
 * not shift the values sideways.
 */
const LABELS = ["placeholder", "scope", "added", "expires", "used", "last used", "tools", "status", "repair"] as const;

/** Width of the label column, fixed by the longest label so alignment never depends on the data. */
const LABEL_WIDTH = LABELS.reduce((widest, label) => Math.max(widest, label.length), 0);

/** Cells consumed before a value begins. Every value's room is `width` minus this. */
const VALUE_OFFSET = INDENT.length + LABEL_WIDTH + LABEL_GAP.length;

/**
 * What the used, last-used and tools rows collapse into when the log has never seen this
 * placeholder.
 *
 * A `0` beside an empty tool list reads as a panel that failed to load its data, not as a fact
 * about the secret. Saying it in words removes the ambiguity, and it removes the two rows that
 * carried no information anyway.
 */
const NEVER_USED = "not used yet";

/**
 * What the last-used row says when the log counted uses but recorded no instant for the newest
 * one. That combination means a truncated or hand-edited log, and naming it is better than
 * printing "just now" for a timestamp nobody has.
 */
const UNKNOWN_LAST_USE = "unknown";

/** What the tools row says when uses were counted but no tool name survived with them. */
const UNKNOWN_TOOLS = "none recorded";

/** The phrase the expired colour is keyed off, spelled once so the check cannot drift from `describeTimeLeft`. */
const EXPIRED = "expired";

/**
 * Everything the card knows about one selected credential, as a labelled panel.
 *
 * Constructor injection, in the style of `SecretTablePane`: the row, the joined usage figures and
 * the clock all arrive from the container, so this class holds no state that could disagree with
 * the table above it and its tests need nothing but three plain values.
 */
export class SecretDetailPane implements Component {
	constructor(
		private readonly row: ManagerRow,
		private readonly usage: SecretUsageStats,
		private readonly now: () => number,
	) {}

	render(width: number): readonly string[] {
		const row = this.row;
		return row.kind === "broken" ? this.#brokenLines(row, width) : this.#secretLines(row.entry, width);
	}

	/**
	 * A vault file that would not open has no fields to show, so the panel shows the repair
	 * instead. Rendering an empty skeleton of placeholder and expiry rows for a file nobody could
	 * read would suggest the entry exists and is merely blank.
	 */
	#brokenLines(row: Extract<ManagerRow, { kind: "broken" }>, width: number): readonly string[] {
		return [
			this.#field("scope", theme.fg("link", row.scope), width),
			this.#field("status", theme.fg("error", "vault unreadable"), width),
			...this.#prose("repair", row.reason, width),
		];
	}

	#secretLines(entry: ScopedVaultEntry, width: number): readonly string[] {
		const now = this.now();
		const left = describeTimeLeft(entry, now);
		const lines = [
			// Bold, because the placeholder is the only string on this panel the operator will
			// retype into a prompt.
			this.#field("placeholder", theme.bold(buildNamePlaceholder(entry.name)), width),
			this.#field("scope", theme.fg("link", entry.scope), width),
			this.#field("added", theme.fg("dim", describeAgo(now - entry.createdAt)), width),
			// An expired secret is coloured differently from a live one because "this stopped
			// expanding" is the most common reason to have opened this panel at all, and the
			// answer should be findable without reading the words.
			this.#field("expires", theme.fg(left === EXPIRED ? "error" : "dim", left), width),
		];
		if (this.usage.useCount <= 0) {
			lines.push(this.#field("used", theme.fg("muted", NEVER_USED), width));
			return lines;
		}
		const times = this.usage.useCount === 1 ? "1 time" : `${this.usage.useCount} times`;
		const lastUsed = this.usage.lastUsedAt === null ? UNKNOWN_LAST_USE : describeAgo(now - this.usage.lastUsedAt);
		const tools = this.usage.tools.length === 0 ? UNKNOWN_TOOLS : this.usage.tools.join(", ");
		lines.push(
			this.#field("used", theme.fg("dim", times), width),
			this.#field("last used", theme.fg("dim", lastUsed), width),
			this.#field("tools", theme.fg("dim", tools), width),
		);
		return lines;
	}

	/**
	 * One `label  value` row, clipped to `width`.
	 *
	 * The value is truncated rather than wrapped: a long tool list or a sixty-four character
	 * placeholder would otherwise push the panel taller every time the selection moved, and a
	 * card whose height depends on its contents cannot hold a stable scroll position.
	 */
	#field(label: string, value: string, width: number): string {
		const prefix = INDENT + theme.fg("dim", label.padEnd(LABEL_WIDTH)) + LABEL_GAP;
		const room = width - VALUE_OFFSET;
		// At a width too narrow to hold even the label, clip the whole row instead of computing a
		// negative value width. `truncateToWidth` floors at zero, so width 0 and width 1 both
		// yield a short string rather than a throw.
		if (room < 1) return truncateToWidth(prefix + value, width);
		return prefix + truncateToWidth(value, room);
	}

	/**
	 * A label whose value is a sentence, wrapped under the value column.
	 *
	 * Only the repair explanation takes this path. It is prose written for the operator to act on,
	 * and clipping it at the panel edge would cut the instruction in half.
	 */
	#prose(label: string, text: string, width: number): readonly string[] {
		const room = width - VALUE_OFFSET;
		if (room < 1) return [this.#field(label, text, width)];
		const wrapped = wrapTextWithAnsi(text, room);
		if (wrapped.length === 0) return [this.#field(label, "", width)];
		// Continuation rows sit under the value column, so the sentence reads as one block rather
		// than as several unlabelled rows.
		const hang = padding(VALUE_OFFSET);
		return wrapped.map((line, index) =>
			index === 0
				? this.#field(label, theme.fg("muted", line), width)
				: hang + truncateToWidth(theme.fg("muted", line), room),
		);
	}

	invalidate(): void {}
}
