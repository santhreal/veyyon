/**
 * WHY: expanding a tool after a raw-to-wire update restored its old producer's
 * arguments and discarded its result. Wire snapshots must remain authoritative
 * across expansion, sealing and later notifications from a detached producer.
 * Returning to raw updates must restore producer-backed disclosure. This suite
 * covers all tool lifecycle states, not reconstruction of content absent from
 * an explicitly supplied display model.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { type AnsiPolicy, getAnsiPolicy, setAnsiPolicy, TUI } from "@veyyon/tui";
import type { ToolExecutionBlock, ToolStatus } from "@veyyon/wire/presentation";
import { settleFrames } from "../../../../hosts/terminal/engine/test/helpers/settle-frames";
import { VirtualTerminal } from "../../../../hosts/terminal/engine/test/virtual-terminal";
import { Settings } from "../../src/config/settings";
import { createToolExecutionProducer, type ToolExecutionProducer } from "../../src/presentation/tool-execution";
import { applyPresentationTheme } from "../../src/theme/theme";
import { PROGRESS_RUN_MIN_LINES } from "../../src/tools/core/render-utils";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";
import { createToolExecution } from "../helpers/tool-execution";
import { testTheme } from "./helpers/presentation-theme";

const STATES: { [K in ToolStatus]: { status: K; isError: boolean } } = {
	pending: { status: "pending", isError: false },
	running: { status: "running", isError: false },
	succeeded: { status: "succeeded", isError: false },
	failed: { status: "failed", isError: true },
	aborted: { status: "aborted", isError: true },
	rejected: { status: "rejected", isError: true },
};
let settingsState: SettingsTestState | undefined;
let ansiPolicy: AnsiPolicy;
beforeEach(async () => {
	settingsState = beginSettingsTest();
	ansiPolicy = getAnsiPolicy();
	await Settings.init({ inMemory: true, overrides: { "git.enabled": false } });
	setAnsiPolicy("full");
	applyPresentationTheme(testTheme());
});
afterEach(() => {
	setAnsiPolicy(ansiPolicy);
	restoreSettingsTestState(settingsState);
});

function rawBlock(): ToolExecutionBlock {
	return {
		kind: "tool-execution",
		id: "tool:transition",
		toolCallId: "transition",
		toolName: "transition-tool",
		status: "running",
		timestamp: 1,
		input: JSON.stringify({ source: "INITIAL_ARGUMENT" }),
	};
}
function rig(block: ToolExecutionBlock, source?: ToolExecutionProducer) {
	const terminal = new VirtualTerminal(80, 24, 5_000);
	const tui = new TUI(terminal);
	const component = createToolExecution(block, { ui: tui, dataSource: source });
	tui.addChild(component);
	tui.start();
	return {
		component,
		async screen() {
			tui.requestRender();
			await settleFrames(terminal, tui);
			return terminal
				.getViewport()
				.map(row => Bun.stripANSI(row).trimEnd())
				.join("\n");
		},
		stop() {
			component.dispose();
			tui.stop();
		},
	};
}

test.each(Object.values(STATES).map(state => [state.status, state] as const))(
	"wire %s survives expansion and sealing",
	async (_, state) => {
		const initial = rawBlock();
		const { component, screen, stop } = rig(initial);
		try {
			component.set({
				...initial,
				status: state.status,
				input: JSON.stringify({ source: "CURRENT_ARGUMENT" }),
				...(state.isError ? { error: "CURRENT_WIRE_OUTPUT" } : { output: "CURRENT_WIRE_OUTPUT" }),
				display: { generic: { icon: state.isError ? "error" : "done" } },
			});
			for (const expanded of [false, true, false]) {
				component.setExpanded(expanded);
				const frame = await screen();
				expect(frame).toContain("CURRENT_WIRE_OUTPUT");
				expect(frame).toContain("CURRENT_ARGUMENT");
				expect(frame).not.toContain("INITIAL_ARGUMENT");
			}
			component.seal();
			expect(await screen()).toContain("CURRENT_WIRE_OUTPUT");
		} finally {
			stop();
		}
	},
);

test("a detached producer cannot overwrite the wire result", async () => {
	const source = createToolExecutionProducer({ toolName: "transition-tool", args: { source: "INITIAL_ARGUMENT" } });
	const { component, screen, stop } = rig(source.block, source);
	try {
		component.set({
			...source.block,
			status: "succeeded",
			output: "CURRENT_WIRE_OUTPUT",
			display: { generic: { icon: "done" } },
		});
		source.updateResult({ content: [{ type: "text", text: "OBSOLETE_PRODUCER_OUTPUT" }] });
		component.setExpanded(true);
		const frame = await screen();
		expect(frame).toContain("CURRENT_WIRE_OUTPUT");
		expect(frame).not.toContain("OBSOLETE_PRODUCER_OUTPUT");
	} finally {
		stop();
		source.seal();
	}
});

test("returning from wire to raw updates restores expanded output", async () => {
	const initial = { ...rawBlock(), toolName: "bash", input: JSON.stringify({ command: "cargo build" }) };
	const { component, screen, stop } = rig({ ...initial, display: { generic: { icon: "pending" } } });
	const rows = Array.from({ length: PROGRESS_RUN_MIN_LINES }, (_, index) => `Compiling crate-${index}`);
	try {
		component.set({ ...initial, status: "succeeded", output: rows.join("\n") });
		expect(await screen()).not.toContain(rows[0]!);
		component.setExpanded(true);
		const frame = await screen();
		for (const row of rows) expect(frame).toContain(row);
		component.setExpanded(false);
		expect(await screen()).not.toContain(rows[0]!);
	} finally {
		stop();
	}
});
