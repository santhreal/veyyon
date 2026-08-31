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
	 * What the chosen breadth actually buys, stated on screen. A knob whose
	 * effect is invisible is a knob nobody can set correctly: breadth 2 reads
	 * like "a small ring" and is in fact no ring at all.
	 */
	certifierSummary(): string {
		if (this.breadth === 1) return "Serial: one experiment per iteration, no arms and no review.";
		if (!this.certify) return `${this.breadth} arms, uncertified: you are the only reviewer.`;
		const mode = certifierFor(this.breadth);
		if (mode === "ring") {
			return `${this.breadth} arms in a review ring: each arm is reviewed by another, and no pair reviews each other.`;
		}
		return `${this.breadth} arms reviewed by the director: a ring needs 3, since 2 arms would review each other.`;
	}
}

interface Row {
	id: FieldId;
	label: string;
	value: string;
	/** Empty on the goal row, whose value is free text and would leave it ragged. */
	hint: string;
}

export function setupRows(model: SwarmSetupModel): Row[] {
	return [
		{ id: "goal", label: "Goal", value: model.goal.length > 0 ? model.goal : "what should get faster?", hint: "" },
		{ id: "breadth", label: "Breadth", value: String(model.breadth), hint: "candidate arms per iteration" },
		{ id: "attempts", label: "Attempts", value: String(model.attempts), hint: "retries before an arm is abandoned" },
		{
			id: "certify",
			label: "Certification",
			value: model.certify ? "on" : "off",
			hint: "arms cross-review before one is kept",
		},
	];
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
 * comes from, what the chosen breadth actually buys, and which key leaves.
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
	lines.push(...prose(model.certifierSummary(), width, line => theme.fg("muted", line)));
	if (!model.canStart()) {
		lines.push(...prose("A goal is required before autoswarm can start.", width, line => theme.fg("warning", line)));
	}
	lines.push("");
	lines.push(...prose("↑↓ field   ←→ adjust   space toggle   enter start   esc cancel", width, dim));
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
