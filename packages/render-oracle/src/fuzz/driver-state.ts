import type { TUI } from "@veyyon/tui/tui";
import type { VirtualTerminal } from "../terminal/virtual-terminal";
import { type DriverShadowState, getShadowWindowTop } from "./driver-shadow";
import type { StressModel } from "./model";
import type { AppliedOperation, OperationLogEntry, OperationLogKind } from "./operations";
import type { StressComponent } from "./overlay-model";
import type { StressRandomStreams } from "./random";
import { writeReplayLog } from "./scenarios";
import { formatSeed, snapshotDump, snapshotSummary } from "./snapshot";
import type {
	ExpectedFrame,
	JsonObject,
	Scenario,
	Snapshot,
	StressChildEntry,
	StressOverlayEntry,
	TerminalStressTraits,
} from "./types";

export interface DriverFailState {
	scenario: Scenario;
	opLog: OperationLogEntry[];
	traits: TerminalStressTraits;
	operationCoverage: Map<OperationLogKind, number>;
	shadow: DriverShadowState;
	writeLog: string[];
	children: StressChildEntry[];
	overlays: StressOverlayEntry[];
	model: StressModel;
}

export function failStressInvariant(
	state: DriverFailState,
	message: string,
	op: AppliedOperation,
	before: Snapshot,
	after: Snapshot,
	index: number,
	extra: JsonObject,
): never {
	const replayLogPath = writeReplayLog(state.scenario, state.opLog);
	const replay = `TUI_STRESS_REPLAY=${JSON.stringify({
		scenario: state.scenario.name,
		seed: formatSeed(state.scenario.seed),
		iterations: index + 1,
	})}`;
	const replayLog = `TUI_STRESS_REPLAY_LOG=${replayLogPath}`;
	const fullDump = Bun.env.TUI_STRESS_FULL_DUMP === "1";
	const dump = {
		message,
		scenario: state.scenario.name,
		seed: formatSeed(state.scenario.seed),
		opIndex: index,
		replay,
		replayLog,
		replayLogPath,
		op: { kind: op.kind, detail: op.detail },
		extra,
		traits: state.traits,
		tags: state.scenario.tags,
		operationCoverage: Object.fromEntries(state.operationCoverage.entries()),
		lastOperations: state.opLog.slice(-50),
		shadow: {
			committed: state.shadow.shadowCommitted,
			windowTop: getShadowWindowTop(state.shadow),
			tapeLength: state.shadow.shadowTape.length,
			frameLength: state.shadow.shadowFrame.length,
			geometryChanged: state.shadow.shadowFrameGeometryChanged,
			overlayVisible: state.shadow.shadowFrameOverlay,
		},
		lastWrites: state.writeLog.slice(-4).map(write => JSON.stringify(write.slice(-400))),
		children: state.children.map(child => ({
			id: child.id,
			active: child.active,
			focused: child.component.focused,
			lines: child.model.debugLines(),
		})),
		overlays: state.overlays.map(overlay => ({
			id: overlay.id,
			hidden: overlay.hidden,
			focused: overlay.component.focused,
			sentinel: overlay.sentinel,
			options: overlay.detail,
			lines: overlay.model.debugLines(),
		})),
		before: fullDump ? snapshotDump(before) : snapshotSummary(before),
		after: fullDump ? snapshotDump(after) : snapshotSummary(after),
		model: fullDump ? state.model.debugLines() : undefined,
		opLog: fullDump ? state.opLog : undefined,
		fullDump: fullDump ? true : "set TUI_STRESS_FULL_DUMP=1 for complete buffers and op log",
	};
	throw new Error(`TUI render stress invariant failed: ${message}\n${JSON.stringify(dump, null, 2)}`);
}

export interface OverlayOpsContext {
	overlays: StressOverlayEntry[];
	hiddenOverlaySentinels: Set<string>;
	allocOverlayId: () => number;
	streams: StressRandomStreams;
	term: VirtualTerminal;
	tui: TUI;
	settle: () => Promise<void>;
}

export interface ChildOpsContext {
	children: StressChildEntry[];
	component: StressComponent;
	tui: TUI;
	streams: StressRandomStreams;
	term: VirtualTerminal;
	renderContentFrame: () => void;
	settle: () => Promise<void>;
}

export interface EmptyOverflowOpsContext {
	children: StressChildEntry[];
	component: StressComponent;
	model: StressModel;
	tui: TUI;
	term: VirtualTerminal;
	streams: StressRandomStreams;
	expectedFrame: () => ExpectedFrame;
	settle: () => Promise<void>;
}

export interface BurstStepContext {
	model: StressModel;
	term: VirtualTerminal;
	scenario: Scenario;
	streams: StressRandomStreams;
	tui: TUI;
}

export interface CoalescedBurstContext extends BurstStepContext {
	renderContentFrame: () => void;
	settle: () => Promise<void>;
}

export interface CheckpointContext {
	term: VirtualTerminal;
	tui: TUI;
	traits: TerminalStressTraits;
	settle: () => Promise<void>;
}

export interface AssertionsContext {
	scenario: Scenario;
	traits: TerminalStressTraits;
	term: VirtualTerminal;
	overlays: StressOverlayEntry[];
	hiddenOverlaySentinels: Set<string>;
	everDuplicatedFrameLines: Set<string>;
	shadow: DriverShadowState;
	hasVisibleOverlay: () => boolean;
	fail: (
		message: string,
		op: AppliedOperation,
		before: Snapshot,
		after: Snapshot,
		index: number,
		extra: JsonObject,
	) => never;
}

export interface DriverApplyOpContext {
	scenario: Scenario;
	traits: TerminalStressTraits;
	streams: StressRandomStreams;
	term: VirtualTerminal;
	tui: TUI;
	model: StressModel;
	component: StressComponent;
	children: StressChildEntry[];
	overlays: StressOverlayEntry[];
	hiddenOverlaySentinels: Set<string>;
	allocOverlayId: () => number;
	expectedFrame: () => ExpectedFrame;
	renderContentFrame: () => void;
	settle: () => Promise<void>;
}
