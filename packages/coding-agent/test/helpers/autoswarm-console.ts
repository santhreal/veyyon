/**
 * Drives the autoswarm setup form the way its two hosts do: the launcher and
 * the dashboard both wrap {@link SetupFormComponent} around a
 * {@link LoopConsoleModel} and run an action through `model.perform`. A test
 * that presses keys here presses them against the production form, not a
 * fake of it.
 */
import {
	type ConsoleAction,
	type ConsoleHost,
	type ConsoleSituation,
	LoopConsoleModel,
	type LoopSetup,
} from "@veyyon/coding-agent/autoresearch/console";
import { BUILTIN_PRESETS, type LoopPreset } from "@veyyon/coding-agent/autoresearch/presets";
import { SetupFormComponent } from "@veyyon/coding-agent/autoresearch/setup-form";
import { stripAnsi } from "@veyyon/utils";

export const NO_SESSION: ConsoleSituation = {
	session: null,
	harness: false,
	modeOn: false,
	busy: false,
	interrupted: false,
	pausedOnBranch: null,
	baseline: false,
};

export interface RecordingHost extends ConsoleHost {
	/** Every setup the model applied, in order. */
	applied: LoopSetup[];
	/** Every action the model ran, in order. */
	acted: ConsoleAction[];
}

/** A host that records what the model does to it; `act` closes unless overridden. */
export function recordingHost(overrides: Partial<ConsoleHost> & { presets?: () => LoopPreset[] } = {}): RecordingHost {
	const applied: LoopSetup[] = [];
	const acted: ConsoleAction[] = [];
	return {
		applied,
		acted,
		situation: () => NO_SESSION,
		modelExists: () => true,
		presets: () => [...BUILTIN_PRESETS],
		savePreset: () => "saved",
		deletePreset: () => true,
		apply: setup => applied.push(setup),
		act: action => {
			acted.push(action);
			return "close";
		},
		...overrides,
	};
}

export interface ConsoleDrive {
	model: LoopConsoleModel;
	host: RecordingHost;
	form: SetupFormComponent;
	/** What each action pressed on the form came back as. */
	outcomes: ("close" | "stay" | "refused")[];
	cancels: number;
	/** Put the ring on `id` and press `keys` against it. */
	press: (id: string, ...keys: string[]) => void;
	/** Type `text` one character at a time into the field with the ring. */
	type: (text: string) => void;
	/** The form as painted, ANSI stripped. */
	frame: (width?: number) => string[];
}

const DEFAULT_SETUP: LoopSetup = {
	goal: "make it faster",
	breadth: 3,
	attempts: 1,
	certify: true,
	armModels: [],
	maxIterations: null,
};

/** A model over `host` with `initial` on top of a valid default setup, and the form around it. */
export function driveConsole(initial: Partial<LoopSetup> = {}, host: RecordingHost = recordingHost()): ConsoleDrive {
	const model = new LoopConsoleModel({ ...DEFAULT_SETUP, ...initial }, host);
	const outcomes: ConsoleDrive["outcomes"] = [];
	const drive: ConsoleDrive = {
		model,
		host,
		form: undefined as never,
		outcomes,
		cancels: 0,
		press: (id, ...keys) => {
			drive.form.focus(id);
			for (const key of keys) drive.form.handleInput(key);
		},
		type: text => {
			for (const char of text) drive.form.handleInput(char);
		},
		frame: (width = 68) => drive.form.render(width).map(line => stripAnsi(line)),
	};
	drive.form = new SetupFormComponent({
		model,
		onAction: action => outcomes.push(model.perform(action)),
		onCancel: () => {
			drive.cancels += 1;
		},
	});
	return drive;
}
