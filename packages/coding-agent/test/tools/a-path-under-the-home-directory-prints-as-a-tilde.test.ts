/**
 * WHY THIS EXISTS. `tools/core/shorten-path.ts` was split out of `render-utils` so the launch card's
 * status row stops pulling 94 modules in for one function, and it shipped with no test naming it,
 * while every tool renderer in the product routes its paths through it. The rule it enforces is
 * narrower than "starts with the home directory": `/home/mukund-thirumalai` must not collapse
 * against a home of `/home/mukund`, because a prefix that stops mid-segment is a different account.
 *
 * THE CLASS THIS CLOSES. Not "the home directory becomes a tilde" but "a path that only looks like
 * it lives under home is rewritten anyway", plus the two inputs that reach this function from real
 * renderers: a Win32 path whose separators have to come out POSIX, and a non-string value arriving
 * from a partially streamed tool argument.
 *
 * WHAT IT DOES NOT CATCH. The ambient `os.homedir()` branch, which every case pins explicitly
 * instead, and nothing about truncation or width — a shortened path is still clipped downstream by
 * `truncateToWidth`.
 */

import { describe, expect, it } from "bun:test";
import { shortenPath } from "@veyyon/coding-agent/tools/core/shorten-path";

const HOME = "/home/operator";

describe("a path under the home directory prints as a tilde", () => {
	it("collapses the home directory itself and anything below it", () => {
		expect(shortenPath(HOME, HOME)).toBe("~");
		expect(shortenPath(`${HOME}/src/app.ts`, HOME)).toBe("~/src/app.ts");
	});

	it("leaves a path alone when the home prefix stops mid-segment", () => {
		expect(shortenPath("/home/operator-backup/src/app.ts", HOME)).toBe("/home/operator-backup/src/app.ts");
		expect(shortenPath("/var/log/app.log", HOME)).toBe("/var/log/app.log");
	});

	it("prints a Win32 path below home with POSIX separators", () => {
		expect(shortenPath("C:\\Users\\operator\\src\\app.ts", "C:\\Users\\operator")).toBe("~/src/app.ts");
	});

	it("prints nothing for a value that is not a path", () => {
		expect(shortenPath(undefined, HOME)).toBe("");
		expect(shortenPath(42, HOME)).toBe("");
		expect(shortenPath({ path: `${HOME}/src/app.ts` }, HOME)).toBe("");
	});

	it("rewrites nothing when the caller has no home directory to compare against", () => {
		expect(shortenPath(`${HOME}/src/app.ts`, "")).toBe(`${HOME}/src/app.ts`);
	});
});
