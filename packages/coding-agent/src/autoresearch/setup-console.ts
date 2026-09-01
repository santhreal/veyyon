import { matchesKey } from "@veyyon/tui";
import { clamp } from "@veyyon/utils";
import type { Theme } from "../modes/theme/theme";
import { replaceTabs, truncateToWidth } from "../tools/render-utils";
import { certifierFor, MAX_ATTEMPTS, MAX_BREADTH, MIN_ATTEMPTS, MIN_BREADTH } from "./swarm";
import type { SwarmSetup } from "./types";

/** What the console hands back; null when the user left without starting. */
export interface SwarmSetupResult extends SwarmSetup {
	goal: string;
}

type FieldId = "goal" | "breadth" | "attempts" | "certify";

const FIELD_ORDER: readonly FieldId[] = ["goal", "breadth", "attempts", "certify"] as const;

const SUBTITLE = "Autoresearch with breadth. The model derives the metric from your harness.";

/**
 * Pure state behind the setup console, so the rules are testable without a
 * terminal. The component below is a thin shell over this.
 */
export class SwarmSetupModel {
	goal: string;
	breadth: number;
	attempts: number;
	certify: boolean;
	field: FieldId = "goal";

	constructor(initial: SwarmSetup & { goal?: string }) {
		this.goal = initial.goal ?? "";
		this.breadth = clamp(Math.floor(initial.breadth), MIN_BREADTH, MAX_BREADTH);
		this.attempts = clamp(Math.floor(initial.attempts), MIN_ATTEMPTS, MAX_ATTEMPTS);
		this.certify = initial.certify;
	}

	moveField(delta: number): void {
		const index = FIELD_ORDER.indexOf(this.field);
		const next = (index + delta + FIELD_ORDER.length) % FIELD_ORDER.length;
		this.field = FIELD_ORDER[next];
	}

	/** Left/right on the focused row. The goal row has nothing to adjust. */
	adjust(delta: number): void {
		if (this.field === "breadth") this.breadth = clamp(this.breadth + delta, MIN_BREADTH, MAX_BREADTH);
		else if (this.field === "attempts") this.attempts = clamp(this.attempts + delta, MIN_ATTEMPTS, MAX_ATTEMPTS);
		else if (this.field === "certify") this.certify = !this.certify;
	}

	typeText(text: string): void {
		if (this.field !== "goal") return;
		this.goal += text;
	}

	backspace(): void {
		if (this.field !== "goal") return;
		this.goal = this.goal.slice(0, -1);
	}

	/** A swarm with no goal has nothing to optimize, so starting is refused. */
	canStart(): boolean {
		return this.goal.trim().length > 0;
	}

	result(): SwarmSetupResult {
		return { goal: this.goal.trim(), breadth: this.breadth, attempts: this.attempts, certify: this.certify };
	}

	/**
	 * The work this configuration commits to, in harness runs.
	 *
	 * Breadth and attempts multiply, and neither row states it: breadth 4 with 3
	 * attempts is up to twelve builds and twelve measurements per iteration,
	 * which is the difference between a loop that finishes over lunch and one
	 * that does not. Stated as a ceiling, because an arm that succeeds on its
	 * first try spends one attempt.
	 */
	costSummary(): string {
		const unit = this.breadth === 1 ? "experiment" : "arms";
		const total = this.breadth * this.attempts;
		const runs = total === 1 ? "1 harness run" : `up to ${total} harness runs`;
		return `${this.breadth} ${unit} × ${this.attempts} attempts: ${runs} per iteration.`;
	}

	/**
	 * What the chosen breadth actually buys, stated on screen. A knob whose
	 * effect is invisible is a knob nobody can set correctly: breadth 2 reads
	 * like "a small ring" and is in fact no ring at all.
	 *
	 * The arm count is on the line above, so this states only the topology.
	 */
	certifierSummary(): string {
		if (this.breadth === 1) return "Serial: no arms and no review.";
		if (!this.certify) return "No cross-review: you are the only reviewer.";
		const mode = certifierFor(this.breadth);
		if (mode === "ring") return "Each arm is reviewed by another, and no pair reviews each other.";
		return "The director reviews both arms: a ring needs 3, since 2 arms would review each other.";
	}
}

interface Row {
	id: FieldId;
	label: string;
	value: string;
	/** Empty on the goal row, whose value is free text and would leave it ragged. */
	hint: string;
}

/**
 * One grammar for every hint: a noun phrase naming what the value governs, so
 * the column reads as one list rather than as three sentences that happen to
 * sit under each other. The two that bound an arm's life share a shape, because
 * they are the same kind of limit read from opposite ends.
 */
export function setupRows(model: SwarmSetupModel): Row[] {
	return [
		{ id: "goal", label: "Goal", value: model.goal.length > 0 ? model.goal : "what should get faster?", hint: "" },
		{ id: "breadth", label: "Breadth", value: String(model.breadth), hint: "candidate arms per iteration" },
		{ id: "attempts", label: "Attempts", value: String(model.attempts), hint: "retries before an arm is abandoned" },
		{
			id: "certify",
			label: "Certification",
			value: model.certify ? "on" : "off",
			hint: "cross-review before an arm is kept",
		},
	];
}

/**
 * The keys that do something to the field the cursor is on, and the range the
 * adjust keys move within.
 *
 * One legend listing every key the console accepts stated, on the goal row,
 * that space toggles and the arrows adjust, which is true of neither that field
 * nor that moment, and it never stated breadth's ceiling -- the arrows stopped
 * moving and nothing on screen stated why.
 */
function keyLegend(field: FieldId, canStart: boolean): string {
	const local =
		field === "goal"
			? "type to edit"
			: field === "breadth"
				? `←→ ${MIN_BREADTH} to ${MAX_BREADTH}`
				: field === "attempts"
					? `←→ ${MIN_ATTEMPTS} to ${MAX_ATTEMPTS}`
					: "space toggle";
	// The refusal is printed on the key it applies to. It was a warning line of
	// its own, which appeared the moment the goal was cleared and disappeared on
	// the next character, moving the legend during typing -- and the legend it
	// moved still printed `enter start`, which enter did not do. One line, and it
	// states what enter does at both values.
	const enter = canStart ? "enter start" : "enter needs a goal";
	return `${local}   ↑↓ field   ${enter}   esc cancel`;
}

/**
 * Keeps the caret in view while a long goal is typed. Without this the text
 * runs off the right edge and typing stops appearing to do anything.
 */
function goalWindow(goal: string, room: number): string {
	if (room <= 0 || goal.length <= room) return goal;
	return `…${goal.slice(goal.length - room + 1)}`;
}

/**
 * The value column, from the bounds each field can reach rather than the value
 * it holds now: `attempts` crossing 9 and `certify` toggling off widen the
 * current maximum by a column, and a width read off the live values moved the
 * whole hint column sideways on the keystroke that did it. The bar is the same
 * for every field, so the hints stand still while the numbers change.
 */
const VALUE_WIDTH = Math.max(
	String(MAX_BREADTH).length,
	String(MAX_ATTEMPTS).length,
	String(MIN_BREADTH).length,
	String(MIN_ATTEMPTS).length,
	"off".length,
);

/** Marker and space, label column, then the caret cell the goal row reserves. */
const LABEL_WIDTH = 14;

/**
 * Sentences and key legends wrap; only the field rows, whose value is windowed
 * to the caret, are cut. A truncated sentence loses its last clause, and the
 * clause at the end of each of these is the one that matters: where the metric
 * comes from, what the chosen breadth provides, and which key leaves.
 */
function prose(text: string, width: number, paint: (line: string) => string): string[] {
	return Bun.wrapAnsi(text, Math.max(20, width), { trim: false }).split("\n").map(paint);
}

export function renderSetupConsole(model: SwarmSetupModel, width: number, theme: Theme): string[] {
	const rows = setupRows(model);
	const goalRoom = width - LABEL_WIDTH - 3;
	const dim = (line: string): string => theme.fg("dim", line);
	const lines: string[] = [theme.bold(theme.fg("accent", "Autoswarm setup"))];
	lines.push(...prose(SUBTITLE, width, dim));
	lines.push("");
	for (const row of rows) {
		const focused = row.id === model.field;
		const marker = focused ? theme.fg("accent", "›") : " ";
		const label = theme.fg(focused ? "accent" : "dim", row.label.padEnd(LABEL_WIDTH));
		const isGoal = row.id === "goal";
		const empty = isGoal && model.goal.length === 0;
		const text = isGoal ? (empty ? row.value : goalWindow(row.value, goalRoom)) : row.value.padEnd(VALUE_WIDTH);
		const shown = replaceTabs(text);
		const caret = focused && isGoal ? theme.fg("accent", "▌") : "";
		const value = empty ? theme.fg("dim", shown) : theme.fg(focused ? "toolTitle" : "muted", shown);
		const hint = row.hint.length > 0 ? theme.fg("dim", `  ${row.hint}`) : "";
		lines.push(truncateToWidth(`${marker} ${label}${value}${caret}${hint}`, width));
	}
	lines.push("");
	// Cost first, topology second: what the loop will run, then how it selects.
	// Both lines are unconditional, so nothing below them moves while a field is
	// being adjusted.
	lines.push(...prose(model.costSummary(), width, line => theme.fg("muted", line)));
	lines.push(...prose(model.certifierSummary(), width, dim));
	lines.push("");
	lines.push(...prose(keyLegend(model.field, model.canStart()), width, dim));
	return lines;
}

/**
 * Keys the console understands. Returns "start" or "cancel" when the console
 * should close, and null while it stays open.
 */
export function handleSetupKey(model: SwarmSetupModel, data: string): "start" | "cancel" | null {
	if (matchesKey(data, "escape") || matchesKey(data, "esc")) return "cancel";
	if (matchesKey(data, "return") || matchesKey(data, "enter")) return model.canStart() ? "start" : null;
	if (matchesKey(data, "up")) {
		model.moveField(-1);
		return null;
	}
	if (matchesKey(data, "down") || matchesKey(data, "tab")) {
		model.moveField(1);
		return null;
	}
	if (matchesKey(data, "left")) {
		model.adjust(-1);
		return null;
	}
	if (matchesKey(data, "right")) {
		model.adjust(1);
		return null;
	}
	if (matchesKey(data, "backspace")) {
		model.backspace();
		return null;
	}
	// Space toggles certification, but only where it is not ordinary typing.
	if (data === " " && model.field !== "goal") {
		model.adjust(1);
		return null;
	}
	if (isPrintable(data)) {
		model.typeText(data);
		return null;
	}
	return null;
}

/**
 * Printable text. An escape sequence is rejected by the control-character scan,
 * since ESC is itself 0x1b, so it needs no separate check; empty input scans to
 * nothing and appends nothing.
 */
function isPrintable(data: string): boolean {
	for (const char of data) {
		const code = char.codePointAt(0) ?? 0;
		if (code < 0x20 || code === 0x7f) return false;
	}
	return true;
}
