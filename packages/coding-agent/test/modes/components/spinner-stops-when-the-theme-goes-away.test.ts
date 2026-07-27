/**
 * A live spinner whose theme disappears must stop and say so, not throw inside its timer forever.
 *
 * WHY THIS SUITE EXISTS. The spinner tick reads the active theme from a live module binding every 80ms,
 * on purpose, so switching themes takes effect mid-spin. The binding is process-global and merely
 * DECLARED (`export var theme: Theme`), so it holds `undefined` until a theme is applied and holds
 * whatever was published after that. A tick that dereferences it blindly throws from a `setInterval`
 * callback, where there is no caller to catch it: bun reports it as an unhandled error between tests and
 * attributes it to whichever test is running, and the interval keeps firing, so it repeats twelve times
 * a second for the rest of the process.
 *
 * That is not a theoretical failure. A test suite that published a probe object into the binding and did
 * not restore it produced exactly this: 12 failures across session-manager migration, large-session
 * memory guards, and eval/idle-timeout, all reporting
 * `TypeError: undefined is not an object (evaluating 'theme.spinnerFrames.length')` from this line, and
 * none of them having anything to do with spinners or themes. Hours go into a failure list like that
 * before anyone looks at the spinner.
 *
 * So the tick fails LOUD instead: it stops its own animation and warns once. This suite pins that, and
 * pins the ordinary case alongside it, because a guard that also fires when the theme is fine would stop
 * every spinner in the product.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import type { ToolExecutionComponent } from "@veyyon/coding-agent/modes/components/tool-execution";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import { setActiveTheme, theme } from "@veyyon/coding-agent/modes/theme/theme-binding";
import type { Theme } from "@veyyon/coding-agent/modes/theme/theme-class";
import type { TUI } from "@veyyon/tui";
import { logger } from "@veyyon/utils";
import { createToolExecution } from "../../helpers/tool-execution";

const WARNING = "Spinner stopped: the active theme has no spinner frames";

let realTheme: Theme;
let warnings: Array<{ message: string; fields: Record<string, unknown> }>;

/** A component whose args are still streaming, which is what starts the spinner interval. */
function liveComponent(): ToolExecutionComponent {
	return createToolExecution(
		"eval",
		{ language: "py", code: "import time\ntime.sleep(10)" },
		{},
		undefined,
		{ requestRender: vi.fn(), requestComponentRender: vi.fn() } as unknown as TUI,
		process.cwd(),
	);
}

function warningsNamed(message: string): Array<Record<string, unknown>> {
	return warnings.filter(entry => entry.message === message).map(entry => entry.fields);
}

beforeAll(async () => {
	await initTheme();
	realTheme = theme;
});

afterEach(() => {
	setActiveTheme(realTheme);
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("a spinner whose theme is replaced by something that is not a theme", () => {
	/**
	 * The regression, driven the way it actually happened: a probe object published into the binding
	 * while a spinner is already running. One tick must be enough to stop it.
	 */
	it("stops the animation instead of throwing every tick", () => {
		vi.useFakeTimers();
		warnings = [];
		vi.spyOn(logger, "warn").mockImplementation((message: string, fields?: Record<string, unknown>) => {
			warnings.push({ message, fields: fields ?? {} });
		});
		const component = liveComponent();
		component.render(80);

		setActiveTheme({ name: "probe" } as unknown as Theme);
		vi.advanceTimersByTime(240);

		expect(warningsNamed(WARNING)).toHaveLength(1);
		component.stopAnimation();
	});

	/**
	 * And the report names what went wrong, because "no spinner frames" and "no theme at all" are
	 * different faults: the first is a malformed theme, the second is a render before startup finished.
	 */
	it("says whether the theme was unset or merely frameless", () => {
		vi.useFakeTimers();
		warnings = [];
		vi.spyOn(logger, "warn").mockImplementation((message: string, fields?: Record<string, unknown>) => {
			warnings.push({ message, fields: fields ?? {} });
		});
		const component = liveComponent();
		component.render(80);

		setActiveTheme(undefined as unknown as Theme);
		vi.advanceTimersByTime(120);

		expect(warningsNamed(WARNING)[0]?.theme).toBe("unset");
		expect(warningsNamed(WARNING)[0]?.tool).toBe("eval");
		component.stopAnimation();
	});

	/**
	 * Stopping means stopping: a guard that warned but left the interval alive would still fire twelve
	 * times a second, which is the half of the bug that made it expensive rather than merely wrong.
	 */
	it("does not keep warning after it has stopped", () => {
		vi.useFakeTimers();
		warnings = [];
		vi.spyOn(logger, "warn").mockImplementation((message: string, fields?: Record<string, unknown>) => {
			warnings.push({ message, fields: fields ?? {} });
		});
		const component = liveComponent();
		component.render(80);

		setActiveTheme({ name: "probe" } as unknown as Theme);
		vi.advanceTimersByTime(80 * 50);

		expect(warningsNamed(WARNING)).toHaveLength(1);
		component.stopAnimation();
	});
});

describe("a spinner with a working theme", () => {
	/**
	 * The guard must not fire on the ordinary case. Without this, a check written slightly wrong (say
	 * `theme.spinnerFrames.length > 0`, which an empty-frames theme legitimately hits) would silently
	 * stop every spinner in the product and warn on every tool call.
	 */
	it("keeps animating and reports nothing", () => {
		vi.useFakeTimers();
		warnings = [];
		vi.spyOn(logger, "warn").mockImplementation((message: string, fields?: Record<string, unknown>) => {
			warnings.push({ message, fields: fields ?? {} });
		});
		const component = liveComponent();

		const first = component.render(80).join("\n");
		vi.advanceTimersByTime(120);
		const second = component.render(80).join("\n");

		expect(second).not.toBe(first);
		expect(warningsNamed(WARNING)).toEqual([]);
		component.stopAnimation();
	});
});
