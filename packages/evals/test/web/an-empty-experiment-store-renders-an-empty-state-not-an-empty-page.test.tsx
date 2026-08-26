/**
 * WHY: the experiments view mapped the fetched array straight into a grid, so a store with
 * no experiments rendered the grid element and nothing inside it. On screen that is a nav
 * bar above blank space, which is what a failed fetch, a crashed render and an empty store
 * all look like — and the store is empty on every first launch.
 *
 * The class this closes: a list view whose empty result is indistinguishable from a broken
 * one. Each of the three states this view has — not loaded, loaded and empty, loaded with
 * rows — is asserted to render something a reader can tell apart from the other two.
 *
 * What it does not catch: a fetch that fails outright, which `usePolled` reports through its
 * own error state (its suite covers the hook), and the styling of any of the three.
 */

import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ExperimentsList } from "../../src/web/components/experiments-index";
import type { ExperimentSummary } from "../../src/wire";

function summary(overrides: Partial<ExperimentSummary> = {}): ExperimentSummary {
	return {
		id: "exp1",
		goal: "prove the arm helps",
		arms: 2,
		runningArms: 0,
		datasets: ["deep-swe"],
		nTotal: 10,
		done: 10,
		pass: 7,
		fail: 3,
		error: 0,
		costUsd: 1.25,
		createdAt: 1000,
		updatedAt: 2000,
		...overrides,
	};
}

describe("the experiments view", () => {
	it("states that nothing has loaded yet before the first response", () => {
		expect(renderToStaticMarkup(<ExperimentsList experiments={null} />)).toContain("loading");
	});

	it("states that the store is empty, and how to put something in it", () => {
		const markup = renderToStaticMarkup(<ExperimentsList experiments={[]} />);
		expect(markup).toContain("no experiments yet");
		expect(markup).toContain("new run");
	});

	it("renders one link per experiment once the store holds any", () => {
		const markup = renderToStaticMarkup(
			<ExperimentsList experiments={[summary(), summary({ id: "exp2", goal: "second" })]} />,
		);
		expect(markup).toContain('href="#/exp/exp1"');
		expect(markup).toContain('href="#/exp/exp2"');
		expect(markup).not.toContain("no experiments yet");
		expect(markup).not.toContain("loading");
	});

	it("keeps the three states apart, so none renders as another", () => {
		const rendered = [null, [], [summary()]].map(experiments =>
			renderToStaticMarkup(<ExperimentsList experiments={experiments} />),
		);
		expect(new Set(rendered).size).toBe(3);
		for (const markup of rendered) expect(markup.length).toBeGreaterThan(0);
	});
});
