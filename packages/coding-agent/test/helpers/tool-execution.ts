/**
 * Build a `ToolExecutionComponent` for a test and stop its animation when that test ends.
 *
 * WHY THIS EXISTS. A live tool block runs a spinner `setInterval` and a 60ms rail interval, each
 * asking the TUI to repaint. `stopAnimation()` clears both, and 16 test files never called it, so each
 * left intervals calling `requestScopedRender` on a component nobody would render again for the rest of
 * the `bun test` process. One of those leaks turned a different suite's global theme mutation into 12
 * failures in three unrelated suites, all reporting a spinner TypeError from code they never touched.
 * A leaked real interval also lands in the next suite that installs fake timers: Bun moves a real
 * interval that fires under a fake clock onto that clock, so `vi.getTimerCount()` counts it there.
 *
 * Each block registers its own `onTestFinished`, which binds to the test (or the `beforeEach`) that is
 * running when the block is built. A module-scope `afterEach` here bound only to the first file that
 * imported this module, because Bun evaluates a module once per process, so every later file in the
 * same process leaked its blocks. A block built in `beforeAll` is stopped as soon as that hook returns.
 * Bun refuses `onTestFinished` inside `test.concurrent`, so a concurrent test builds its blocks through
 * `withToolExecutions`, which stops them when its body settles.
 * Stopping twice is harmless, so a test that also stops a component itself needs no special case.
 */

import { onTestFinished } from "bun:test";
import { ToolExecutionComponent } from "@veyyon/coding-agent/modes/terminal/components/transcript/tool-execution";

/** Builds a tool block; the same parameters as the component's constructor. */
export type ToolExecutionBuilder = (
	...args: ConstructorParameters<typeof ToolExecutionComponent>
) => ToolExecutionComponent;

/** Construct a tool block whose animation is stopped when the current test ends. */
export const createToolExecution: ToolExecutionBuilder = (...args) => {
	const component = new ToolExecutionComponent(...args);
	onTestFinished(() => component.stopAnimation());
	return component;
};

/** Run `body` with a builder whose blocks are stopped when `body` settles, whatever the test kind. */
export async function withToolExecutions<T>(body: (create: ToolExecutionBuilder) => Promise<T>): Promise<T> {
	const built: ToolExecutionComponent[] = [];
	try {
		return await body((...args) => {
			const component = new ToolExecutionComponent(...args);
			built.push(component);
			return component;
		});
	} finally {
		for (const component of built) component.stopAnimation();
	}
}
