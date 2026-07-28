/**
 * The last line of `veyyon setup status`, which is the line a reader actually looks at.
 *
 * It was a tally — "13 ok, 1 warnings, 0 errors" — so the reader had to do the
 * arithmetic to find out whether anything was actually wrong, the two counts that
 * are usually zero were printed anyway, and it said "1 warnings" for as long as it
 * existed. A health check's closing line should be the verdict.
 *
 * `initTheme` first: the status glyphs come from the theme, and without it every
 * case below dies on `theme.status` rather than asserting anything.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { formatDoctorResults } from "@veyyon/coding-agent/extensibility/plugins/doctor";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";

beforeAll(() => {
	initTheme();
});

describe("formatDoctorResults ends with a verdict, not a tally", () => {
	const ok = { name: "a", status: "ok" as const, message: "fine" };
	const warn = { name: "b", status: "warning" as const, message: "look at this" };
	const err = { name: "c", status: "error" as const, message: "broken" };

	it("says everything works when every check passed", () => {
		const out = formatDoctorResults([ok, { ...ok, name: "d" }]);
		expect(out.trim().split("\n").at(-1)).toBe("Everything works. 2 checks passed.");
	});

	it("still says everything works when the worst result is a warning, and counts them", () => {
		// A warning is not a failure, and telling the reader it is sends them
		// hunting for a problem that is not there.
		expect(formatDoctorResults([ok, warn]).trim().split("\n").at(-1)).toBe(
			"Everything works. 1 warning worth reading.",
		);
		expect(
			formatDoctorResults([ok, warn, { ...warn, name: "e" }])
				.trim()
				.split("\n")
				.at(-1),
		).toBe("Everything works. 2 warnings worth reading.");
	});

	it("leads with the failures when there are any", () => {
		expect(formatDoctorResults([ok, warn, err]).trim().split("\n").at(-1)).toBe("1 check failed. 1 check passed.");
	});

	/** The bug in the old line, pinned so it cannot come back. */
	it("never writes a plural for a count of one", () => {
		const out = formatDoctorResults([ok, warn]);
		expect(out).not.toContain("1 warnings");
		expect(out).not.toContain("1 errors");
		expect(out).not.toContain("1 checks");
	});
});
