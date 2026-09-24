/**
 * The autoswarm console, projected for a window.
 *
 * `/autoswarm` opens one console model, `LoopConsoleModel`, and that model
 * decides every value on it: what a row holds, what a step formats to, which
 * actions the swarm's state allows and why one of them cannot run. The
 * terminal draws that model as a card; a window draws the projection below.
 * Nothing here decides anything about a swarm — a rule restated in a second
 * host is a rule that drifts — and the run ledger is composed from the same
 * `state` helpers the terminal's screen composes it from.
 */
import type { FormField } from "@veyyon/tui";
import {
	ACTION_LABELS,
	ACTION_VERBS,
	type ConsoleAction,
	type LoopConsoleModel,
	SAVE_FIELD,
} from "../autoresearch/console";
import { formatElapsed, formatPercentChange } from "../autoresearch/helpers";
import { loadPresets } from "../autoresearch/presets";
import {
	currentResults,
	findBaselineMetric,
	findBaselineResult,
	findBestKeptResult,
	measuredMetric,
	metricLabel,
	runTag,
} from "../autoresearch/state";
import type { AutoresearchRuntime, ExperimentResult, ExperimentState } from "../autoresearch/types";
import type {
	AutoswarmActionView,
	AutoswarmConsoleView,
	AutoswarmFieldView,
	AutoswarmNoteView,
	AutoswarmRunView,
	AutoswarmSwarmView,
} from "./wire";

/** What the preset row states while the fields match no preset. */
const NO_PRESET = "custom shape";
/** What a row states for the run measuring now, which has no metric yet. */
const MEASURING = "measuring";
/** The outcome word for that row: it has produced no verdict to carry. */
const IN_FLIGHT = "live";
/** The last lines of harness output a live run carries into the ledger. */
const TAIL_LINES = 6;

/** A row the window draws, or null for the notes and the button drawn elsewhere. */
function fieldView(field: FormField, removable: (preset: string) => boolean): AutoswarmFieldView | null {
	const base = { id: field.id, hint: "hint" in field ? (field.hint ?? "") : "" };
	if (field.kind === "text") {
		return {
			...base,
			kind: "Text",
			label: field.label,
			display: field.value,
			text: field.value,
			placeholder: field.placeholder ?? null,
			number: null,
			min: null,
			max: null,
			on: null,
			options: [],
		};
	}
	if (field.kind === "stepper") {
		return {
			...base,
			kind: "Stepper",
			label: field.label,
			display: field.format ? field.format(field.value) : String(field.value),
			text: null,
			placeholder: null,
			number: field.value,
			min: field.min,
			max: field.max,
			on: null,
			options: [],
		};
	}
	if (field.kind === "toggle") {
		return {
			...base,
			kind: "Toggle",
			label: field.label,
			display: field.value ? (field.labels?.on ?? "on") : (field.labels?.off ?? "off"),
			text: null,
			placeholder: null,
			number: null,
			min: null,
			max: null,
			on: field.value,
			options: [],
		};
	}
	if (field.kind === "segmented") {
		return {
			...base,
			kind: "Segmented",
			label: field.label,
			display: field.value ?? NO_PRESET,
			text: null,
			placeholder: null,
			number: null,
			min: null,
			max: null,
			on: null,
			options: field.options.map(option => ({
				value: option.value,
				label: option.label,
				selected: option.value === field.value,
				removable: removable(option.value),
			})),
		};
	}
	return null;
}

/** Each action the swarm's state allows, primary first, with what stops it. */
function actionViews(model: LoopConsoleModel): AutoswarmActionView[] {
	const actions = model.actions();
	return actions.map((action: ConsoleAction, index: number) => ({
		action,
		label: ACTION_LABELS[action],
		verb: ACTION_VERBS[action],
		primary: index === 0,
		blocker: model.blocker(action),
	}));
}

/** What one logged run states when the ledger opens it. */
function runDetail(result: ExperimentResult, state: ExperimentState): string[] {
	const lines: string[] = [];
	if (result.description.length > 0) lines.push(result.description);
	if (result.arm !== null) lines.push(`Arm: ${result.arm}`);
	if (result.model !== null) lines.push(`Model: ${result.model}`);
	if (result.certifiedBy !== null) lines.push(`Certified by: ${result.certifiedBy}`);
	if (result.commit.length > 0) lines.push(`Commit: ${result.commit}`);
	for (const metric of state.secondaryMetrics) {
		const value = result.metrics[metric.name];
		if (value !== undefined) lines.push(`${metric.name}: ${value}${metric.unit}`);
	}
	if (result.justification !== null) lines.push(`Justification: ${result.justification}`);
	if (result.flaggedReason !== null) lines.push(`Flagged: ${result.flaggedReason}`);
	for (const path of result.scopeDeviations) lines.push(`Outside scope: ${path}`);
	return lines;
}

/** The ledger: the run measuring now, then every logged run, newest first. */
function runViews(runtime: AutoresearchRuntime): AutoswarmRunView[] {
	const state = runtime.state;
	const results = currentResults(state.results, state.currentSegment);
	const baseline = findBaselineResult(state.results, state.currentSegment);
	const baselineMetric = findBaselineMetric(state.results, state.currentSegment);
	const best = findBestKeptResult(state.results, state.currentSegment, state.bestDirection);
	const rows: AutoswarmRunView[] = results
		.map(result => {
			const measured = measuredMetric(result);
			return {
				label: result.runNumber === null ? MEASURING : `#${result.runNumber}`,
				arm: result.arm,
				metric: metricLabel(result, state.metricUnit),
				delta: measured === null ? null : (formatPercentChange(measured, baselineMetric) ?? null),
				outcome: runTag(result, result === best, result === baseline),
				best: result === best,
				detail: runDetail(result, state),
			};
		})
		.reverse();
	const running = runtime.runningExperiment;
	if (running !== null) {
		const tail = running.tail.split("\n").filter(line => line.trim().length > 0);
		rows.unshift({
			label: `#${running.runNumber}`,
			arm: runtime.activeArm?.arm ?? null,
			metric: MEASURING,
			delta: null,
			outcome: IN_FLIGHT,
			best: false,
			detail: [running.command, `Running ${formatElapsed(Date.now() - running.startedAt)}`].concat(
				tail.slice(-TAIL_LINES),
			),
		});
	}
	return rows;
}

/** The swarm recorded on this branch, or null before the first start. */
function swarmView(runtime: AutoresearchRuntime): AutoswarmSwarmView | null {
	const state = runtime.state;
	if (state.sessionId === null) return null;
	const best = findBestKeptResult(state.results, state.currentSegment, state.bestDirection);
	return {
		name: state.name,
		branch: state.branch,
		goal: state.goal ?? runtime.goal ?? "",
		runs: currentResults(state.results, state.currentSegment).length,
		best: best ? metricLabel(best, state.metricUnit) : null,
		running: runtime.runningExperiment?.command ?? null,
	};
}

/**
 * The console as the window holds it. `fields` is the console's own form, so
 * a row the model adds is a row the window draws without being told about it.
 * A null `model` is the ledger on its own, which `/autoresearch status` opens:
 * runs and the swarm, with nothing on the window to change. A null `runtime`
 * is the launcher, opened on a branch that carries no swarm to report.
 */
export function autoswarmConsoleView(
	session: string,
	model: LoopConsoleModel | null,
	fields: readonly FormField[],
	runtime: AutoresearchRuntime | null,
): AutoswarmConsoleView {
	const saved = new Set(loadPresets().flatMap(preset => (preset.builtin ? [] : [preset.name])));
	const rows: AutoswarmFieldView[] = [];
	const notes: AutoswarmNoteView[] = [];
	for (const field of fields) {
		if (field.kind === "note") {
			notes.push({ id: field.id, text: field.text });
			continue;
		}
		const row = fieldView(field, name => saved.has(name));
		if (row !== null) rows.push(row);
	}
	return {
		session,
		swarm: runtime === null ? null : swarmView(runtime),
		fields: rows,
		notes,
		actions: model === null ? [] : actionViews(model),
		runs: runtime === null ? [] : runViews(runtime),
		// The console's own save row, named so the window draws its save
		// control beside that row rather than guessing which one it is.
		save_field: rows.some(row => row.id === SAVE_FIELD) ? SAVE_FIELD : null,
	};
}
