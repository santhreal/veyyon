/**
 * The rollback row in `/settings`, and the three states behind it.
 *
 * The row opens a picker whose contents come from the network, and a settings
 * submenu has to return a component before that request can finish. Every way
 * of hiding that gap is a lie the operator cannot see through:
 *
 *   - An empty list while loading reads as a project with no releases.
 *   - An empty list after a failure reads exactly the same, so "offline" and
 *     "nothing published" become indistinguishable — the silent empty catalog
 *     the CLI path refuses (Law 10).
 *   - A row that appears when the host cannot install anything reads as a
 *     feature that exists and is broken, which is worse than no row.
 *
 * So the panel draws all three states, and the row is offered only when a real
 * installer is wired behind it. These tests hold that.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { buildRollbackRows, type RollbackRow } from "@veyyon/coding-agent/cli/rollback-cli";
import {
	RollbackPanelComponent,
	type RollbackPanelContext,
} from "@veyyon/coding-agent/modes/components/rollback-panel";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";

beforeAll(async () => {
	await initTheme(false);
});

const ROWS: RollbackRow[] = buildRollbackRows(
	[
		{ tag: "v1.3.0", version: "1.3.0", publishedAt: "2026-07-01T00:00:00Z" },
		{ tag: "v1.2.0", version: "1.2.0", publishedAt: "2026-06-01T00:00:00Z" },
		{ tag: "v1.1.0", version: "1.1.0", publishedAt: "2026-05-01T00:00:00Z" },
	],
	"1.2.0",
);

interface Harness {
	panel: RollbackPanelComponent;
	installed: string[];
	errors: string[];
	closes: () => number;
	renders: () => number;
}

function harness(overrides: Partial<RollbackPanelContext> = {}): Harness {
	const installed: string[] = [];
	const errors: string[] = [];
	const counts = { closes: 0, renders: 0 };
	const panel = new RollbackPanelComponent({
		currentVersion: "1.2.0",
		openUrl: () => {},
		rollback: async version => {
			installed.push(version);
		},
		reportError: message => errors.push(message),
		requestRender: () => {
			counts.renders++;
		},
		done: () => {
			counts.closes++;
		},
		listReleases: async () => ROWS,
		...overrides,
	});
	return { panel, installed, errors, closes: () => counts.closes, renders: () => counts.renders };
}

/** Let the panel's constructor-launched load settle. */
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

describe("while the release list is loading", () => {
	it("says it is loading rather than drawing an empty list", () => {
		// An empty list here is indistinguishable from a project with no releases.
		const rendered = harness().panel.render(80).join("\n");

		expect(rendered).toContain("Reading published versions");
	});

	it("has no picker yet", () => {
		expect(harness().panel.picker()).toBeNull();
	});

	it("closes on Esc, so a slow request is not a trap", async () => {
		const h = harness({ listReleases: () => new Promise(() => {}) });
		h.panel.handleInput("\x1b");

		expect(h.closes()).toBe(1);
	});
});

describe("once the list arrives", () => {
	it("draws the versions", async () => {
		const h = harness();
		await settle();

		const rendered = h.panel.render(80).join("\n");
		for (const version of ["1.3.0", "1.2.0", "1.1.0"]) expect(rendered).toContain(version);
	});

	it("asks the host to repaint, since nothing else knows the state changed", async () => {
		const h = harness();
		await settle();

		expect(h.renders()).toBeGreaterThan(0);
	});

	it("marks the running version", async () => {
		const h = harness();
		await settle();

		expect(h.panel.render(80).join("\n")).toContain("current");
	});

	it("routes keys to the picker", async () => {
		const h = harness();
		await settle();
		h.panel.handleInput("\x1b[B");

		expect(h.panel.picker()?.selectedRow()?.version).toBe("1.1.0");
	});
});

describe("when the release list cannot be read", () => {
	it("names the reason instead of showing an empty list", async () => {
		// "Offline" and "nothing published" must never look the same.
		const h = harness({
			listReleases: async () => {
				throw new Error("HTTP 500 Server Error");
			},
		});
		await settle();

		const rendered = h.panel.render(80).join("\n");
		expect(rendered).toContain("HTTP 500 Server Error");
	});

	it("says how to get out and what to do", async () => {
		const h = harness({
			listReleases: async () => {
				throw new Error("offline");
			},
		});
		await settle();

		expect(h.panel.render(80).join("\n")).toContain("Esc");
	});

	/**
	 * The version list is the only thing that still spends GitHub's API budget,
	 * and that budget belongs to the ADDRESS, so the commonest failure here is a
	 * rate limit somebody else caused while the connection is perfectly fine.
	 * Telling that operator to "check your connection" sends them to look in the
	 * one place the answer is not. The reason line already carries the advice, so
	 * the line under it only says how to retry.
	 */
	it("does not blame the connection, which is usually fine", async () => {
		const h = harness({
			listReleases: async () => {
				throw new Error("HTTP 403 Forbidden — GitHub is rate-limiting this address");
			},
		});
		await settle();

		const rendered = h.panel.render(80).join("\n");
		expect(rendered).toContain("rate-limiting this address");
		expect(rendered).not.toContain("Check your connection");
		expect(rendered).toContain("open it again to retry");
	});

	/**
	 * A long reason has to be readable in a narrow terminal: the rate-limit
	 * message names the limit, what still works and what does not, and a panel
	 * that let it run off the edge would hide the half that says what to do.
	 */
	it("wraps a long reason inside the width it was given", async () => {
		const h = harness({
			listReleases: async () => {
				throw new Error(
					"Failed to fetch the release list from https://api.github.com/repos/santhreal/veyyon/releases: " +
						"HTTP 403 Forbidden — GitHub is rate-limiting this address (the limit is per address and shared)",
				);
			},
		});
		await settle();

		for (const line of h.panel.render(48)) {
			expect(line.replace(/\x1b\[[0-9;]*m/g, "").length).toBeLessThanOrEqual(48);
		}
	});

	it("still closes on Esc", async () => {
		const h = harness({
			listReleases: async () => {
				throw new Error("offline");
			},
		});
		await settle();
		h.panel.handleInput("\x1b");

		expect(h.closes()).toBe(1);
	});

	it("never reaches the installer", async () => {
		const h = harness({
			listReleases: async () => {
				throw new Error("offline");
			},
		});
		await settle();
		h.panel.handleInput("\r");

		expect(h.installed).toEqual([]);
	});
});

describe("choosing a version", () => {
	it("installs exactly the highlighted version", async () => {
		const h = harness();
		await settle();
		h.panel.handleInput("\x1b[B");
		h.panel.handleInput("\r");
		await settle();

		expect(h.installed).toEqual(["1.1.0"]);
	});

	it("closes the panel BEFORE installing, so the install's output survives", async () => {
		// Under the settings overlay the progress and any failure would paint into
		// a screen about to be restored, and the operator would see neither.
		const order: string[] = [];
		const h = harness({
			done: () => order.push("closed"),
			rollback: async () => {
				order.push("installed");
			},
		});
		await settle();
		h.panel.handleInput("\x1b[B");
		h.panel.handleInput("\r");
		await settle();

		expect(order).toEqual(["closed", "installed"]);
	});

	it("reports an install failure through the host, since the panel is gone", async () => {
		// A failure swallowed here would leave the operator believing they moved.
		const h = harness({
			rollback: async () => {
				throw new Error("This is a source install");
			},
		});
		await settle();
		h.panel.handleInput("\x1b[B");
		h.panel.handleInput("\r");
		await settle();

		expect(h.errors.length).toBe(1);
		expect(h.errors[0]).toContain("1.1.0");
		expect(h.errors[0]).toContain("This is a source install");
	});

	it("does not install the version already running", async () => {
		const h = harness();
		await settle();
		h.panel.handleInput("\r");
		await settle();

		expect(h.installed).toEqual([]);
	});
});
