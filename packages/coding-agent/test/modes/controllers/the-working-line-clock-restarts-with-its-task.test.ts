/**
 * WHY: the working line is the one chrome row that must never be stale. A
 * stopped loader left mounted keeps drawing its last frame byte-identically, and
 * an unchanging chrome row is indistinguishable from settled transcript content
 * to the code deciding what may enter scrollback — so a leaked loader does not
 * look like a bug, it looks like history. The per-task clock has the mirror
 * problem: a clock that does not restart when the label changes reports the
 * previous task's elapsed time under the new task's name.
 *
 * Closes the class: every mutation of the loader goes through this controller,
 * so each of its lifecycle verbs (`ensure`, `clear`, `stop`, `abandon`) is
 * asserted on what it leaves in the status container, and the clock is asserted
 * to restart on a label change and to keep counting when the same label repeats.
 *
 * Does NOT catch: the shimmer palette the label is drawn in, nor the 1s
 * heartbeat that calls `refreshTaskClock` — the caller owns that timer.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { Container, type Loader, type TUI } from "@veyyon/tui";
import { Text } from "@veyyon/tui/components/text";
import { WorkingLoaderController } from "../../../src/modes/terminal/controllers/working-loader";
import type { SessionManager } from "../../../src/session/session-manager";
import { initTheme } from "../../../src/theme/theme";

beforeAll(async () => {
	await initTheme();
});

/** The mounted loader, narrowed: every caller below has just called `ensure()`. */
function mountedLoader(controller: WorkingLoaderController): Loader {
	const loader = controller.loader;
	if (!loader) throw new Error("expected a mounted working loader");
	return loader;
}

function makeController(): {
	controller: WorkingLoaderController;
	statusContainer: Container;
	renderRequests: () => number;
} {
	const statusContainer = new Container();
	let renders = 0;
	const ui = {
		requestRender: () => {
			renders += 1;
		},
		requestDirectWrite: () => {},
		requestComponentRender: () => {},
	} as unknown as TUI;
	const sessionManager = { getSessionName: () => "a-session" } as unknown as SessionManager;
	return {
		controller: new WorkingLoaderController({ sessionManager, statusContainer, ui }),
		statusContainer,
		renderRequests: () => renders,
	};
}

describe("the working line clock restarts with its task", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("mounts nothing until asked, then mounts exactly one loader", () => {
		const { controller, statusContainer } = makeController();

		expect(controller.loader).toBeUndefined();
		expect(statusContainer.children.length).toBe(0);

		controller.ensure();

		expect(controller.loader).toBeDefined();
		expect(statusContainer.children).toEqual([mountedLoader(controller)]);

		const first = mountedLoader(controller);
		controller.ensure();

		expect(controller.loader).toBe(first);
		expect(statusContainer.children.length).toBe(1);
	});

	it("shows the default working phase when no task has been named", () => {
		const { controller } = makeController();

		controller.ensure();

		expect(controller.loader?.getText()).toContain("Working…");
	});

	it("applies a task named before the loader existed", () => {
		const { controller } = makeController();

		controller.setMessage("Reading src/app.ts");
		expect(controller.loader).toBeUndefined();

		controller.ensure();

		expect(controller.loader?.getText()).toContain("Reading src/app.ts");
	});

	it("drops a task a cancelled submission will never show", () => {
		const { controller } = makeController();

		controller.setMessage("Reading src/app.ts");
		controller.clearPendingMessage();
		controller.ensure();

		const text = controller.loader?.getText() ?? "";
		expect(text).toContain("Working…");
		expect(text).not.toContain("Reading src/app.ts");
	});

	it("restarts the elapsed clock when the task label changes", () => {
		const { controller } = makeController();

		controller.ensure();
		vi.advanceTimersByTime(65_000);
		controller.refreshTaskClock();
		expect(controller.loader?.getText()).toContain("1:05");

		controller.setMessage("Reading src/app.ts");
		expect(controller.loader?.getText()).toContain("0:00");

		vi.advanceTimersByTime(2_000);
		controller.refreshTaskClock();

		const text = controller.loader?.getText() ?? "";
		expect(text).toContain("Reading src/app.ts");
		expect(text).toContain("0:02");
		expect(text).not.toContain("1:05");
	});

	it("keeps counting when the same label is set again, so a repeat is not a restart", () => {
		const { controller } = makeController();

		controller.ensure();
		controller.setMessage("Reading src/app.ts");
		vi.advanceTimersByTime(4_000);
		controller.setMessage("Reading src/app.ts");

		expect(controller.loader?.getText()).toContain("0:04");
	});

	it("restores the default phase when the task is cleared", () => {
		const { controller } = makeController();

		controller.ensure();
		controller.setMessage("Reading src/app.ts");
		controller.setMessage(undefined);

		expect(controller.loader?.getText()).toContain("Working…");
	});

	it("starts the next run's clock at zero after the loader has gone away", () => {
		const { controller } = makeController();

		controller.ensure();
		vi.advanceTimersByTime(30_000);
		controller.clear();

		controller.ensure();

		expect(controller.loader?.getText()).toContain("0:00");
	});

	it("reports whether there was a loader to clear, and unmounts only its own child", () => {
		const { controller, statusContainer } = makeController();
		const sibling = new Text("a transient overlay");
		statusContainer.addChild(sibling);

		controller.ensure();
		expect(statusContainer.children.length).toBe(1);

		statusContainer.addChild(sibling);
		expect(controller.clear()).toBe(true);
		expect(controller.loader).toBeUndefined();
		expect(statusContainer.children).toEqual([sibling]);

		expect(controller.clear()).toBe(false);
		expect(statusContainer.children).toEqual([sibling]);
	});

	it("empties the whole status container only when the caller asks it to", () => {
		const first = makeController();
		first.controller.ensure();
		first.statusContainer.addChild(new Text("a transient overlay"));
		first.controller.stop(false);

		expect(first.controller.loader).toBeUndefined();
		expect(first.statusContainer.children.length).toBe(1);

		const second = makeController();
		second.controller.ensure();
		second.statusContainer.addChild(new Text("a transient overlay"));
		second.controller.stop(true);

		expect(second.controller.loader).toBeUndefined();
		expect(second.statusContainer.children.length).toBe(0);
	});

	it("stops the loader on stop even when there is nothing else to clear", () => {
		const { controller, statusContainer } = makeController();

		controller.stop(true);
		expect(statusContainer.children.length).toBe(0);
		expect(controller.loader).toBeUndefined();
	});

	it("abandons the loader without touching the container, for a caller that disposes it all", () => {
		const { controller, statusContainer } = makeController();

		controller.ensure();
		const loader = mountedLoader(controller);
		controller.abandon();

		expect(controller.loader).toBeUndefined();
		expect(statusContainer.children).toEqual([loader]);
	});

	it("remounts its loader when something else emptied the status container", () => {
		const { controller, statusContainer, renderRequests } = makeController();

		controller.ensure();
		const loader = mountedLoader(controller);
		statusContainer.disposeChildren();
		expect(statusContainer.children.length).toBe(0);
		const before = renderRequests();

		controller.ensure();

		expect(controller.loader).toBe(loader);
		expect(statusContainer.children).toEqual([loader]);
		expect(renderRequests()).toBeGreaterThan(before);
	});
});
