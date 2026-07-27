/**
 * Build a `ToolExecutionComponent` for a test and stop its animation afterwards.
 *
 * WHY THIS EXISTS. A live tool block runs an 80ms `setInterval` that ticks the spinner and asks the TUI
 * to repaint. `stopAnimation()` clears it, and 16 test files never called it, so each left an interval
 * calling `requestScopedRender` on a component nobody would render again for the rest of the `bun test`
 * process. One of those leaks turned a different suite's global theme mutation into 12 failures in three
 * unrelated suites, all reporting a spinner TypeError from code they never touched.
 *
 * The interval is no longer able to crash anything, but a process that never quiesces still matters:
 * suites that measure timing or wait for idleness are competing with dead components' repaint requests.
 *
 * So construction goes through here. The `afterEach` below is registered in whichever test file imports
 * this module, which is what makes cleanup automatic rather than 16 hand-written `finally` blocks, and
 * `tool-execution-components-are-stopped.test.ts` fails any test file that constructs one directly.
 * Stopping twice is harmless, so a test that also stops a component itself needs no special case.
 */

import { afterEach } from "bun:test";
import { ToolExecutionComponent } from "@veyyon/coding-agent/modes/components/tool-execution";

const liveComponents: ToolExecutionComponent[] = [];

afterEach(() => {
	for (const component of liveComponents.splice(0)) component.stopAnimation();
});

/** Construct a tool block whose animation is stopped when the current test ends. */
export function createToolExecution(
	...args: ConstructorParameters<typeof ToolExecutionComponent>
): ToolExecutionComponent {
	const component = new ToolExecutionComponent(...args);
	liveComponents.push(component);
	return component;
}
