import { getSegmenter, matchesKey, sliceByColumn, visibleWidth } from "@veyyon/tui";
import { clamp } from "@veyyon/utils";
import type { Theme } from "../modes/theme/theme";
import { replaceTabs, truncateToWidth } from "../tools/render-utils";
import { certifierFor, MAX_ATTEMPTS, MAX_BREADTH, MIN_ATTEMPTS, MIN_BREADTH } from "./swarm";
import type { SwarmSetup } from "./types";

/** What the console hands back; null when the user left without starting. */
export interface SwarmSetupResult extends SwarmSetup {
	goal: string;
}

/**
 * What Enter will do, stated on the console. Over a live session it resumes
 * that session with the values shown; otherwise it starts one, and the first
 * turn writes `autoresearch.sh` when the tree has none.
 */
export interface SwarmSetupContext {
	session: { name: string; branch: string | null; runs: number } | null;
	harness: boolean;
}

type FieldId = "goal" | "breadth" | "models" | "attempts" | "certify";

const FIELD_ORDER: readonly FieldId[] = ["goal", "breadth", "models", "attempts", "certify"] as const;

/**
 * Split the models row into one entry per arm, `a0` first. An entry left empty
 * means that arm runs on the session model, so an interior blank is kept and
 * only trailing blanks are dropped: `,gpt-5` is "a0 as configured, a1 on GPT-5"
 * and needs the leading gap.
 */
export function parseArmModels(text: string): string[] {
	const entries = text.split(",").map(entry => entry.trim());
	while (entries.length > 0 && entries[entries.length - 1].length === 0) entries.pop();
	return entries;
}

const SUBTITLE =
	"Each iteration builds one change per arm and keeps the best. The model derives the metric from your harness.";
const HARNESS_FOUND = "autoresearch.sh found: enter starts measuring with it.";
const HARNESS_MISSING = "No autoresearch.sh yet: the first turn writes and validates one before anything is measured.";

/** `text` without its last grapheme cluster, so backspace never splits a surrogate pair or a combining mark. */
function dropLastGrapheme(text: string): string {
	if (text.length === 0) return "";
	const segments = [...getSegmenter().segment(text)];
	if (segments.length === 0) return "";
	const last = segments[segments.length - 1];
	return text.slice(0, last.index);
}

/**
 * Pure state behind the setup console, so the rules are testable without a
 * terminal. The component below is a thin shell over this.
 */
export class SwarmSetupModel {
	goal: string;
	breadth: number;
	attempts: number;
	certify: boolean;
	/** The models row as typed, comma separated. Parsed only at `result()`. */
	models: string;
	field: FieldId = "goal";
	/**
	 * Whether a model spec resolves to an authenticated model, from the same
	 * resolver `--model` uses. Absent in a bare console, which then accepts any
	 * spelling and leaves the refusal to the caller that has a registry.
	 */
	#modelExists: (spec: string) => boolean;
	readonly context: SwarmSetupContext;

	constructor(
		initial: SwarmSetup & {
			goal?: string;
			modelExists?: (spec: string) => boolean;
			context?: SwarmSetupContext;
		},
	) {
		this.goal = initial.goal ?? "";
		this.breadth = clamp(Math.floor(initial.breadth), MIN_BREADTH, MAX_BREADTH);
		this.attempts = clamp(Math.floor(initial.attempts), MIN_ATTEMPTS, MAX_ATTEMPTS);
		this.certify = initial.certify;
		this.models = initial.armModels.join(", ");
		this.#modelExists = initial.modelExists ?? (() => true);
		this.context = initial.context ?? { session: null, harness: false };
	}

	/** What Enter does, from the tree the console opened over. */
	startSummary(): string {
		const { session, harness } = this.context;
		if (session) {
			const where = session.branch ? ` on ${session.branch}` : "";
			const runs = session.runs === 1 ? "1 run" : `${session.runs} runs`;
			return `Resumes session ${session.name}${where} (${runs}) with the values below.`;
		}
		return harness ? HARNESS_FOUND : HARNESS_MISSING;
	}

	/**
	 * The rows the cursor can reach. Per-arm models are a knob on arms, so at
	 * breadth 1 there are no arms and the row is gone rather than inert: a row
	 * that accepts a value it will never apply is a dead flag on screen.
	 */
	fields(): FieldId[] {
		return FIELD_ORDER.filter(id => id !== "models" || this.breadth > 1);
	}

	/** Model specs that do not resolve, in the order typed. */
	unknownModels(): string[] {
		if (this.breadth <= 1) return [];
		return parseArmModels(this.models)
			.slice(0, this.breadth)
			.filter(spec => spec.length > 0 && !this.#modelExists(spec));
	}

	moveField(delta: number): void {
		const fields = this.fields();
		const index = fields.indexOf(this.field);
		const next = (index + delta + fields.length) % fields.length;
		this.field = fields[next];
	}

	/** Left/right on the focused row. A text row has nothing to adjust. */
	adjust(delta: number): void {
		if (this.field === "breadth") {
			this.breadth = clamp(this.breadth + delta, MIN_BREADTH, MAX_BREADTH);
			// Lowering to 1 takes the models row away under the cursor.
			if (!this.fields().includes(this.field)) this.field = "breadth";
		} else if (this.field === "attempts") this.attempts = clamp(this.attempts + delta, MIN_ATTEMPTS, MAX_ATTEMPTS);
		else if (this.field === "certify") this.certify = !this.certify;
	}

	typeText(text: string): void {
		if (this.field === "goal") this.goal += text;
		else if (this.field === "models") this.models += text;
	}

	backspace(): void {
		if (this.field === "goal") this.goal = dropLastGrapheme(this.goal);
		else if (this.field === "models") this.models = dropLastGrapheme(this.models);
	}

	/**
	 * A swarm with no goal has nothing to optimize, so starting is refused. A
	 * model spec that resolves to nothing is refused for the same reason: the
	 * arm would silently run on the session model and the comparison the row
	 * was set up to make would not exist.
	 */
	canStart(): boolean {
		return this.goal.trim().length > 0 && this.unknownModels().length === 0;
	}

	result(): SwarmSetupResult {
		return {
			goal: this.goal.trim(),
			breadth: this.breadth,
			attempts: this.attempts,
			certify: this.certify,
			armModels: this.breadth > 1 ? parseArmModels(this.models).slice(0, this.breadth) : [],
		};
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

	/**
	 * The arm-to-model assignment the models row spells, read back as arms so
	 * nobody has to count commas to find which arm a spec lands on. An unknown
	 * spec is named here rather than in a warning line of its own, since this is
	 * the line that already answers "what will each arm run".
	 */
	modelSummary(): string {
		if (this.breadth <= 1) return "";
		const unknown = this.unknownModels();
		if (unknown.length > 0) return `No model matches ${unknown.map(spec => `"${spec}"`).join(", ")}.`;
		const specs = parseArmModels(this.models);
		if (specs.length === 0) return "Every arm runs on the session model.";
		const assigned: string[] = [];
		for (let arm = 0; arm < this.breadth; arm++) {
			const spec = specs[arm];
			assigned.push(`a${arm} ${spec && spec.length > 0 ? spec : "session model"}`);
		}
		return `${assigned.join(" · ")}.`;
	}
}

interface Row {
	id: FieldId;
	label: string;
	value: string;
	/** Empty on a text row, whose value is free text and would leave it ragged. */
	hint: string;
	/** Free text rather than a value the arrows step through. */
	text: boolean;
	/** Showing a placeholder rather than what the user typed. */
	placeholder: boolean;
}

/**
 * One grammar for every hint: a noun phrase naming what the value governs, so
 * the column reads as one list rather than as three sentences that happen to
 * sit under each other. The two that bound an arm's life share a shape, because
 * they are the same kind of limit read from opposite ends.
 */
export function setupRows(model: SwarmSetupModel): Row[] {
	const rows: Row[] = [
		{
			id: "goal",
			label: "Goal",
			value: model.goal.length > 0 ? model.goal : "what should get faster?",
			hint: "",
			text: true,
			placeholder: model.goal.length === 0,
		},
		{
			id: "breadth",
			label: "Breadth",
			value: String(model.breadth),
			hint: "candidate arms per iteration",
			text: false,
			placeholder: false,
		},
	];
	if (model.breadth > 1) {
		rows.push({
			id: "models",
			label: "Models",
			value: model.models.length > 0 ? model.models : "one per arm, comma separated",
			hint: "",
			text: true,
			placeholder: model.models.length === 0,
		});
	}
	rows.push(
		{
			id: "attempts",
			label: "Attempts",
			value: String(model.attempts),
			hint: "retries before an arm is abandoned",
			text: false,
			placeholder: false,
		},
		{
			id: "certify",
			label: "Certification",
			value: model.certify ? "on" : "off",
			hint: "cross-review before an arm is kept",
			text: false,
			placeholder: false,
		},
	);
	return rows;
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
function keyLegend(model: SwarmSetupModel): string {
	const field = model.field;
	const local =
		field === "goal" || field === "models"
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
	// states what enter does at every value, naming which of the two refusals is
	// in force so the fix is on the key rather than guessed at.
	const enter =
		model.goal.trim().length === 0
			? "enter needs a goal"
			: model.unknownModels().length > 0
				? "enter needs a known model"
				: model.context.session
					? "enter resume"
					: "enter start";
	return `${local}   ↑↓ field   ${enter}   esc cancel`;
}

/**
 * Keeps the caret in view while a long value is typed into a text row. Without
 * this the text runs off the right edge and typing stops appearing to do
 * anything.
 */
function textWindow(value: string, room: number): string {
	if (room <= 0) return "";
	const width = visibleWidth(value);
	if (width <= room) return value;
	if (room <= 1) return "…";
	// Strict: a wide character straddling the left edge is dropped rather than
	// drawn a column past the room.
	return `…${sliceByColumn(value, width - room + 1, room - 1, true)}`;
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

/** Marker and space, label column, then the caret cell a text row reserves. */
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
	const textRoom = width - LABEL_WIDTH - 3;
	const dim = (line: string): string => theme.fg("dim", line);
	const lines: string[] = [theme.bold(theme.fg("accent", "Autoswarm setup"))];
	lines.push(...prose(SUBTITLE, width, dim));
	lines.push(...prose(model.startSummary(), width, line => theme.fg("muted", line)));
	lines.push("");
	for (const row of rows) {
		const focused = row.id === model.field;
		const marker = focused ? theme.fg("accent", "›") : " ";
		const label = theme.fg(focused ? "accent" : "dim", row.label.padEnd(LABEL_WIDTH));
		const text = row.text
			? row.placeholder
				? row.value
				: textWindow(row.value, textRoom)
			: row.value.padEnd(VALUE_WIDTH);
		const shown = replaceTabs(text);
		const caret = focused && row.text ? theme.fg("accent", "▌") : "";
		const value = row.placeholder ? theme.fg("dim", shown) : theme.fg(focused ? "toolTitle" : "muted", shown);
		const hint = row.hint.length > 0 ? theme.fg("dim", `  ${row.hint}`) : "";
		lines.push(truncateToWidth(`${marker} ${label}${value}${caret}${hint}`, width));
	}
	lines.push("");
	// Cost first, topology second: what the loop will run, then how it selects.
	// Both lines are unconditional, so nothing below them moves while a field is
	// being adjusted. The assignment line below them appears with the models row
	// it reads back, on the same breadth condition, so neither moves alone.
	lines.push(...prose(model.costSummary(), width, line => theme.fg("muted", line)));
	lines.push(...prose(model.certifierSummary(), width, dim));
	const models = model.modelSummary();
	if (models.length > 0) lines.push(...prose(models, width, dim));
	lines.push("");
	lines.push(...prose(keyLegend(model), width, dim));
	return lines;
}

/**
 * Keys the console understands. Returns "start" or "cancel" when the console
 * should close, and null while it stays open.
 */
export function handleSetupKey(model: SwarmSetupModel, data: string): "start" | "cancel" | null {
	if (matchesKey(data, "escape") || matchesKey(data, "esc")) return "cancel";
	if (matchesKey(data, "return") || matchesKey(data, "enter")) return model.canStart() ? "start" : null;
	if (matchesKey(data, "up") || matchesKey(data, "shift+tab")) {
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
	// Space toggles certification, but only where it is not ordinary typing: both
	// text rows take it as a character, so `sonnet, gpt-5` types as written.
	if (data === " " && model.field !== "goal" && model.field !== "models") {
		model.adjust(1);
		return null;
	}
	const typed = printableText(data);
	if (typed.length > 0) {
		model.typeText(typed);
		return null;
	}
	return null;
}

/**
 * The text a chunk contributes to a field.
 *
 * A chunk holding ESC is a key sequence rather than text, and contributes
 * nothing: filtering one would type its bracket and letter into the field. Any
 * other control character is a paste artifact. A newline or a tab becomes a
 * space, since a pasted list that ends in a newline used to be rejected whole
 * and insert nothing, and an interior one would otherwise fuse two specs into
 * one token. The rest are dropped.
 */
function printableText(data: string): string {
	let out = "";
	for (const char of data) {
		const code = char.codePointAt(0) ?? 0;
		if (code === 0x1b) return "";
		if (char === "\n" || char === "\r" || char === "\t") {
			out += " ";
			continue;
		}
		if (code < 0x20 || code === 0x7f) continue;
		out += char;
	}
	return out;
}
