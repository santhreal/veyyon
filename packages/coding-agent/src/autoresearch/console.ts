/**
 * The autoswarm console model: the setup a swarm runs with, the presets, and
 * which actions the swarm's state allows. `/autoswarm` opens a surface on it
 * and takes no arguments; nothing about a swarm is typed as a subcommand.
 * `/autoresearch`, the serial loop, is a command with subcommands and never
 * opens one.
 *
 * Two surfaces read this model. Before a session exists, the launcher in
 * {@link ./launcher} is a centered form that sets the fields and starts the
 * swarm. Over a session, the dashboard in {@link ./screen} is the run ledger
 * with the actions on single keys and the same form one key away. Both draw
 * their fields through {@link LoopConsoleModel.formFields}; the host in
 * {@link ./index} performs what an action asks for. Neither surface is needed
 * to test a rule here.
 */
import type { FormField } from "@veyyon/tui";
import { clamp } from "@veyyon/utils";
import { sanitizeSingleLine } from "@veyyon/utils/wrap";
import { type LoopPreset, presetMatches } from "./presets";
import { certifierFor, MAX_ATTEMPTS, MAX_BREADTH, MIN_ATTEMPTS, MIN_SWARM_BREADTH } from "./swarm";
import type { SwarmSetup } from "./types";

/** Everything the console decides about a loop. */
export interface LoopSetup extends SwarmSetup {
	goal: string;
	maxIterations: number | null;
}

export type ConsoleAction = "start" | "resume" | "pause" | "new" | "stop" | "clear" | "reset";

export type ConsoleFieldId = "goal" | "preset" | "breadth" | "models" | "attempts" | "certify" | "iterations";

/** The loop as it stands on this branch, read by the console each frame. */
export interface ConsoleSituation {
	/** The session recorded on this branch, or null before the first start. */
	session: { name: string; branch: string | null; runs: number } | null;
	/** Whether `autoresearch.sh` is in the tree already. */
	harness: boolean;
	/** The mode is on: the loop's tools are attached and its prompt is injected. */
	modeOn: boolean;
	/** A turn is streaming right now, so there is something to pause. */
	busy: boolean;
	/** Escape stopped the loop's turn and nothing has run since. */
	interrupted: boolean;
	/** The session is recorded on another branch, so it is paused here. */
	pausedOnBranch: string | null;
	/** The session records a baseline commit, so the worktree can be reset to it. */
	baseline: boolean;
}

/** What the console needs from the extension that opened it. */
export interface ConsoleHost {
	situation(): ConsoleSituation;
	modelExists(spec: string): boolean;
	/**
	 * Models close to a spec that does not resolve, as specs `modelExists`
	 * accepts, closest first. A host with no model list has none.
	 */
	modelSuggestions?(spec: string): string[];
	presets(): LoopPreset[];
	savePreset(preset: Omit<LoopPreset, "builtin">): "saved" | "builtin";
	deletePreset(name: string): boolean;
	/** A field changed. Persist it: to the session when one exists, else parked for the start. */
	apply(setup: LoopSetup): void;
	/** Perform an action the situation allowed. `close` when the console should leave so the action can run. */
	act(action: ConsoleAction): "close" | "stay";
}

/** The most iterations the field takes, by arrow or by digits. */
const ITERATIONS_CAP = 999;
/** The most suggestions the models note lists for specs that do not resolve. */
const MODEL_SUGGESTIONS = 3;

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

/**
 * Which actions the swarm's state allows, primary first. Over a session,
 * `new` closes it and starts another with the setup on screen, so a finished
 * or stuck swarm is replaced in one key rather than cleared, reopened and
 * started.
 */
export function actionsFor(situation: ConsoleSituation): ConsoleAction[] {
	const actions: ConsoleAction[] = [];
	if (!situation.session) {
		actions.push("start");
		return actions;
	}
	if (situation.modeOn && situation.busy && !situation.interrupted) actions.push("pause");
	else actions.push("resume");
	actions.push("new");
	if (situation.modeOn) actions.push("stop");
	actions.push("clear");
	if (situation.baseline) actions.push("reset");
	return actions;
}

export const ACTION_LABELS: Record<ConsoleAction, string> = {
	start: "Start swarm",
	resume: "Resume",
	pause: "Pause",
	new: "New session",
	stop: "Stop",
	clear: "Clear session",
	reset: "Reset worktree",
};

/** What an action does, as a footer or a button states it. */
export const ACTION_VERBS: Record<ConsoleAction, string> = {
	start: "starts the swarm",
	resume: "resumes the swarm",
	pause: "pauses the swarm",
	new: "starts a new session",
	stop: "stops the swarm",
	clear: "clears the session",
	reset: "resets the worktree",
};

/**
 * The key each action sits on in the dashboard's action bar. Start and Resume
 * share `s`, since the situation offers one or the other, never both.
 */
export const ACTION_KEYS: Record<ConsoleAction, string> = {
	start: "s",
	resume: "s",
	pause: "p",
	new: "n",
	stop: "x",
	clear: "c",
	reset: "r",
};

export const FIELD_LABELS: Record<ConsoleFieldId, string> = {
	goal: "Goal",
	preset: "Preset",
	breadth: "Breadth",
	models: "Models",
	attempts: "Attempts",
	certify: "Certify",
	iterations: "Iterations",
};

/** The form row that saves the setup under a name; not a setup field. */
export const SAVE_FIELD = "save";
/** The form row that performs the primary action. */
export const ACTION_FIELD = "action";

/** Footer text while each field has the ring. */
const FIELD_HINTS: Record<ConsoleFieldId, string> = {
	goal: "type the goal",
	preset: "←→ preset · del removes a saved one",
	breadth: `←→ or ${MIN_SWARM_BREADTH}–${MAX_BREADTH} arms`,
	models: "one model per arm, comma separated",
	attempts: `←→ or ${MIN_ATTEMPTS}–${MAX_ATTEMPTS} attempts`,
	certify: "space toggles cross-review",
	iterations: "←→ or type a number · 0 is auto",
};

export class LoopConsoleModel {
	goal: string;
	breadth: number;
	attempts: number;
	certify: boolean;
	/** The models row as typed, comma separated. Parsed at `setup()`. */
	models: string;
	/** 0 is "auto": the model chooses a cap. */
	iterations: number;
	/** The name typed on the save row. */
	presetName = "";
	readonly #host: ConsoleHost;

	constructor(initial: LoopSetup, host: ConsoleHost) {
		// The goal is one field row. A goal that arrived with a tab or a line
		// break (from `/autoresearch goal`, or a session written by hand) would
		// open a hole through the value column, so it is flattened once here;
		// the form's own paste path flattens what is typed later.
		this.goal = sanitizeSingleLine(initial.goal);
		this.breadth = clamp(Math.floor(initial.breadth), MIN_SWARM_BREADTH, MAX_BREADTH);
		this.attempts = clamp(Math.floor(initial.attempts), MIN_ATTEMPTS, MAX_ATTEMPTS);
		this.certify = initial.certify;
		this.models = initial.armModels.join(", ");
		this.iterations = initial.maxIterations ?? 0;
		this.#host = host;
	}

	setup(): LoopSetup {
		return {
			goal: this.goal.trim(),
			breadth: this.breadth,
			attempts: this.attempts,
			certify: this.certify,
			armModels: parseArmModels(this.models).slice(0, this.breadth),
			maxIterations: this.iterations > 0 ? this.iterations : null,
		};
	}

	situation(): ConsoleSituation {
		return this.#host.situation();
	}

	/** Model specs that do not resolve, in the order typed. */
	unknownModels(): string[] {
		return parseArmModels(this.models)
			.slice(0, this.breadth)
			.filter(spec => spec.length > 0 && !this.#host.modelExists(spec));
	}

	/** Why the loop cannot start with what is on screen, or null when it can. */
	startBlocker(): string | null {
		if (this.goal.trim().length === 0) return "needs a goal";
		const unknown = this.unknownModels();
		if (unknown.length > 0) return `no model matches ${unknown.map(spec => `"${spec}"`).join(", ")}`;
		return null;
	}

	/** What one iteration costs in harness runs, as a ceiling. */
	costSummary(): string {
		const total = this.breadth * this.attempts;
		return `${this.breadth} arms × ${this.attempts} ${this.attempts === 1 ? "attempt" : "attempts"}: up to ${total} harness runs per iteration.`;
	}

	/** What the chosen breadth buys: the review topology. */
	certifierSummary(): string {
		if (!this.certify) return "No cross-review: you are the only reviewer.";
		const mode = certifierFor(this.breadth);
		if (mode === "ring") return "Each arm is reviewed by another, and no pair reviews each other.";
		return "The director reviews both arms: a ring needs 3, since 2 arms would review each other.";
	}

	/** The arm-to-model assignment the models row spells, read back as arms. */
	modelSummary(): string {
		const unknown = this.unknownModels();
		if (unknown.length > 0) {
			const named = unknown.map(spec => `"${spec}"`).join(", ");
			// What the host has that is close to what was typed, so a typo is
			// fixed from the card rather than from a model list opened elsewhere.
			const close = unknown.flatMap(spec => this.#host.modelSuggestions?.(spec) ?? []);
			const distinct = [...new Set(close)].slice(0, MODEL_SUGGESTIONS);
			return distinct.length > 0
				? `No model matches ${named}. Close: ${distinct.join(", ")}.`
				: `No model matches ${named}.`;
		}
		const specs = parseArmModels(this.models);
		if (specs.length === 0) return "Every arm runs on the session model.";
		const assigned: string[] = [];
		for (let arm = 0; arm < this.breadth; arm++) {
			const spec = specs[arm];
			assigned.push(`a${arm} ${spec && spec.length > 0 ? spec : "session model"}`);
		}
		// A spec past the last arm was dropped without a word: the setup this row
		// persists keeps one spec per arm, since the session's prompt lists every
		// entry as an arm, so a spec typed at breadth 3 was gone after the
		// breadth stepper came down and the console was reopened. Naming it here
		// is what lets the reader raise breadth back or delete it on purpose.
		const spare = specs.slice(this.breadth).filter(spec => spec.length > 0);
		const unused =
			spare.length === 0
				? ""
				: ` ${spare.map(spec => `"${spec}"`).join(", ")} ${spare.length === 1 ? "has" : "have"} no arm at breadth ${this.breadth}.`;
		return `${assigned.join(" · ")}.${unused}`;
	}

	/** The harness, as the first turn finds it. */
	harnessSummary(): string {
		return this.#host.situation().harness
			? "autoresearch.sh found: the first turn measures with it."
			: "No autoresearch.sh yet: the first turn writes and validates one before anything is measured.";
	}

	/** The preset the fields currently equal, if any. */
	presetInForce(): LoopPreset | null {
		const setup = this.setup();
		return this.#host.presets().find(preset => presetMatches(preset, setup)) ?? null;
	}

	applyPreset(preset: LoopPreset): void {
		this.breadth = preset.breadth;
		this.attempts = preset.attempts;
		this.certify = preset.certify;
		this.models = preset.armModels.join(", ");
		this.iterations = preset.maxIterations ?? 0;
		this.#host.apply(this.setup());
	}

	/** Remove the preset the fields equal, when it is a saved one. */
	deletePresetInForce(): boolean {
		const preset = this.presetInForce();
		if (!preset || preset.builtin) return false;
		return this.#host.deletePreset(preset.name);
	}

	/** Save the setup on screen under `presetName`; true when it was saved. */
	savePreset(): boolean {
		const name = this.presetName.trim();
		if (name.length === 0) return false;
		const { goal: _goal, ...shape } = this.setup();
		if (this.#host.savePreset({ name, ...shape }) !== "saved") return false;
		this.presetName = "";
		return true;
	}

	/** The actions the situation allows, primary first. */
	actions(): ConsoleAction[] {
		return actionsFor(this.#host.situation());
	}

	/** The first action the loop allows: what the form's button and Enter on the Goal row perform. */
	primaryAction(): ConsoleAction {
		return this.actions()[0];
	}

	/** Why `action` cannot run right now, or null when it can. */
	blocker(action: ConsoleAction): string | null {
		const situation = this.#host.situation();
		if (!actionsFor(situation).includes(action)) return "not available now";
		if (action === "start" || action === "new") return this.startBlocker();
		if (action === "resume" && situation.pausedOnBranch !== null)
			return `recorded on ${situation.pausedOnBranch}: check that branch out first`;
		return null;
	}

	/**
	 * Perform `action`. `"close"` when the surface should leave so the action
	 * can run, `"stay"` when it ran in place, `"refused"` when the situation or
	 * the setup blocks it.
	 */
	perform(action: ConsoleAction): "close" | "stay" | "refused" {
		if (this.blocker(action) !== null) return "refused";
		return this.#host.act(action);
	}

	/** Footer text while `id` has the ring. */
	hint(id: string): string {
		if (id === SAVE_FIELD) return "type a name · enter saves";
		if (id === ACTION_FIELD) return `enter ${ACTION_VERBS[this.primaryAction()]}`;
		const field = id as ConsoleFieldId;
		if (field === "goal") {
			const primary = this.primaryAction();
			const enter = primary === "start" || primary === "resume" ? ` · enter ${ACTION_VERBS[primary]}` : "";
			return `${FIELD_HINTS.goal}${enter}`;
		}
		return FIELD_HINTS[field] ?? "";
	}

	/**
	 * The form: every setup field, the preset chooser, the summaries, and the
	 * primary action as a button. Every change is applied to the host as it is
	 * made, so a value typed is a value persisted, and a surface that closes
	 * mid-edit loses nothing.
	 */
	formFields(options: { onAction: (action: ConsoleAction) => void }): FormField[] {
		const apply = (): void => this.#host.apply(this.setup());
		const presets = this.#host.presets();
		const inForce = this.presetInForce();
		const primary = this.primaryAction();
		const blocker = this.blocker(primary);
		const fields: FormField[] = [
			{
				kind: "text",
				id: "goal",
				label: FIELD_LABELS.goal,
				value: this.goal,
				placeholder: "what to optimize",
				hint: this.hint("goal"),
				onChange: value => {
					this.goal = value;
					apply();
				},
				onSubmit: () => {
					if (primary === "start" || primary === "resume") options.onAction(primary);
				},
			},
			{
				kind: "segmented",
				id: "preset",
				label: FIELD_LABELS.preset,
				options: presets.map(preset => ({ value: preset.name, label: preset.name })),
				value: inForce?.name ?? null,
				hint: this.hint("preset"),
				onChange: name => {
					const preset = presets.find(entry => entry.name === name);
					if (preset) this.applyPreset(preset);
				},
			},
			{
				kind: "stepper",
				id: "breadth",
				label: FIELD_LABELS.breadth,
				value: this.breadth,
				min: MIN_SWARM_BREADTH,
				max: MAX_BREADTH,
				format: value => `${value} ${value === 1 ? "arm" : "arms"}`,
				hint: this.hint("breadth"),
				onChange: value => {
					this.breadth = value;
					apply();
				},
			},
			{
				kind: "text",
				id: "models",
				label: FIELD_LABELS.models,
				value: this.models,
				placeholder: "session model for every arm",
				hint: this.hint("models"),
				onChange: value => {
					this.models = value;
					apply();
				},
			},
			{
				kind: "stepper",
				id: "attempts",
				label: FIELD_LABELS.attempts,
				value: this.attempts,
				min: MIN_ATTEMPTS,
				max: MAX_ATTEMPTS,
				hint: this.hint("attempts"),
				onChange: value => {
					this.attempts = value;
					apply();
				},
			},
			{
				kind: "toggle",
				id: "certify",
				label: FIELD_LABELS.certify,
				value: this.certify,
				hint: this.hint("certify"),
				onChange: value => {
					this.certify = value;
					apply();
				},
			},
			{
				kind: "stepper",
				id: "iterations",
				label: FIELD_LABELS.iterations,
				value: this.iterations,
				min: 0,
				max: ITERATIONS_CAP,
				format: value => (value === 0 ? "auto" : String(value)),
				hint: this.hint("iterations"),
				onChange: value => {
					this.iterations = value;
					apply();
				},
			},
			{ kind: "note", id: "cost", text: `${this.costSummary()} ${this.certifierSummary()}` },
			{ kind: "note", id: "models-summary", text: this.modelSummary() },
			{ kind: "note", id: "harness", text: this.harnessSummary() },
			{
				kind: "button",
				id: ACTION_FIELD,
				label: ACTION_LABELS[primary],
				primary: true,
				disabled: blocker,
				hint: this.hint(ACTION_FIELD),
				onPress: () => options.onAction(primary),
			},
			{
				kind: "text",
				id: SAVE_FIELD,
				label: "Save as",
				value: this.presetName,
				placeholder: "preset name",
				hint: this.hint(SAVE_FIELD),
				onChange: value => {
					this.presetName = value;
				},
				onSubmit: () => {
					this.savePreset();
				},
			},
		];
		return fields;
	}
}
