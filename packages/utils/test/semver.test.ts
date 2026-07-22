import { describe, expect, it } from "bun:test";
import { compareDottedNumeric, compareSemver, isNewerVersion } from "@veyyon/utils/semver";

/**
 * The hand-rolled comparator this module replaced, kept verbatim so the
 * regression cases below can assert against the real historical behavior
 * rather than a description of it.
 *
 * It lived in `cli/update-cli.ts` and decided whether `veyyon update` had
 * anything to install.
 */
function handRolledComparator(a: string, b: string): number {
	const pa = a.split(".").map(Number);
	const pb = b.split(".").map(Number);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const na = pa[i] || 0;
		const nb = pb[i] || 0;
		if (na !== nb) return na - nb;
	}
	return 0;
}

const sign = (n: number): number => (n < 0 ? -1 : n > 0 ? 1 : 0);

describe("compareSemver", () => {
	describe("ordering", () => {
		it("orders by major, then minor, then patch", () => {
			expect(sign(compareSemver("2.0.0", "1.9.9"))).toBe(1);
			expect(sign(compareSemver("1.3.0", "1.2.9"))).toBe(1);
			expect(sign(compareSemver("1.2.4", "1.2.3"))).toBe(1);
			expect(sign(compareSemver("1.2.3", "1.2.4"))).toBe(-1);
		});

		it("compares numerically, not as text", () => {
			// The bug a string sort would introduce: "1.9.0" sorts after "1.10.0"
			// lexically, so a text comparison reports 1.9.0 as the newer release and
			// a user on 1.9.0 would never be offered 1.10.0.
			expect(sign(compareSemver("1.10.0", "1.9.0"))).toBe(1);
			expect(sign(compareSemver("1.2.10", "1.2.9"))).toBe(1);
		});

		it("reports equal versions as equal", () => {
			expect(compareSemver("1.2.3", "1.2.3")).toBe(0);
		});

		it("sorts a list ascending when used directly as a sort comparator", () => {
			const sorted = ["1.10.0", "1.2.3-rc.1", "2.0.0", "1.2.3", "1.9.0"].sort(compareSemver);
			expect(sorted).toEqual(["1.2.3-rc.1", "1.2.3", "1.9.0", "1.10.0", "2.0.0"]);
		});
	});

	describe("tag prefixes", () => {
		it("ignores a leading v so a git tag compares against a package version", () => {
			// Release tags are `v1.2.3` while package.json carries `1.2.3`. Callers
			// used to strip the prefix themselves, and a caller that forgot compared
			// a NaN.
			expect(compareSemver("v1.2.3", "1.2.3")).toBe(0);
			expect(sign(compareSemver("v15.13.0", "15.12.6"))).toBe(1);
			expect(sign(compareSemver("15.12.6", "v15.13.0"))).toBe(-1);
		});
	});

	describe("prerelease precedence", () => {
		it("ranks a prerelease below its own release", () => {
			expect(sign(compareSemver("1.2.3-rc.1", "1.2.3"))).toBe(-1);
			expect(sign(compareSemver("1.2.3", "1.2.3-rc.1"))).toBe(1);
		});

		it("orders prerelease identifiers alphabetically, not by their trailing number", () => {
			// REGRESSION: the hand-rolled comparator read `1.2.3-alpha.5` as
			// [1,2,0,5] and `1.2.3-beta.1` as [1,2,0,1], so it declared alpha the
			// newer of the two. A user on an alpha was told they were up to date and
			// never received the beta.
			expect(sign(compareSemver("1.2.3-alpha.5", "1.2.3-beta.1"))).toBe(-1);
			expect(sign(compareSemver("1.2.3-rc.1", "1.2.3-alpha.9"))).toBe(1);
			expect(sign(handRolledComparator("1.2.3-alpha.5", "1.2.3-beta.1"))).toBe(1);
		});

		it("orders numeric prerelease parts numerically", () => {
			expect(sign(compareSemver("1.2.3-beta.10", "1.2.3-beta.2"))).toBe(1);
		});

		it("ranks a bare prerelease below the same prerelease with an identifier", () => {
			expect(sign(compareSemver("1.0.0-alpha", "1.0.0-alpha.1"))).toBe(-1);
		});
	});

	describe("build metadata", () => {
		it("ignores build metadata, which carries no precedence", () => {
			// REGRESSION: the hand-rolled comparator turned `3+build` into NaN and
			// then 0, ranking `1.2.3+build.7` *below* `1.2.3`. Semver says build
			// metadata is not part of precedence, so the two rank equal.
			expect(compareSemver("1.2.3+build.7", "1.2.3")).toBe(0);
			expect(compareSemver("1.2.3", "1.2.3+build.7")).toBe(0);
			expect(sign(handRolledComparator("1.2.3+build.7", "1.2.3"))).toBe(-1);
		});
	});

	describe("divergence from the comparator this replaced", () => {
		it("disagrees with the hand-rolled comparator on every case that motivated this module", () => {
			// Locks the reason this owner exists. If someone reintroduces the
			// split/Number idiom, these pairs are what breaks.
			const divergent: Array<[string, string]> = [
				["1.2.3-alpha.5", "1.2.3-beta.1"],
				["1.2.3-rc.1", "1.2.3-alpha.9"],
				["1.2.3+build.7", "1.2.3"],
				["1.2.3", "1.2.3+build.7"],
			];
			for (const [a, b] of divergent) {
				expect(sign(compareSemver(a, b))).not.toBe(sign(handRolledComparator(a, b)));
			}
		});

		it("agrees with it on the plain numeric cases, which is why the bug stayed hidden", () => {
			const agreeing: Array<[string, string]> = [
				["1.10.0", "1.9.0"],
				["2.0.0", "1.9.9"],
				["1.2.3", "1.2.3"],
				["1.2.3-beta", "1.2.3"],
			];
			for (const [a, b] of agreeing) {
				expect(sign(compareSemver(a, b))).toBe(sign(handRolledComparator(a, b)));
			}
		});
	});
});

describe("isNewerVersion", () => {
	it("is true only for a strictly newer candidate", () => {
		expect(isNewerVersion("1.2.4", "1.2.3")).toBe(true);
		expect(isNewerVersion("2.0.0", "1.9.9")).toBe(true);
	});

	it("is false for the same version, so a poll does not reinstall what is present", () => {
		expect(isNewerVersion("1.2.3", "1.2.3")).toBe(false);
		expect(isNewerVersion("v1.2.3", "1.2.3")).toBe(false);
	});

	it("is false for an older candidate, so a registry that lags cannot force a downgrade", () => {
		expect(isNewerVersion("1.2.2", "1.2.3")).toBe(false);
	});

	it("does not treat a prerelease of the installed version as an upgrade", () => {
		expect(isNewerVersion("1.2.3-rc.1", "1.2.3")).toBe(false);
	});

	it("treats the release as an upgrade over its own prerelease", () => {
		expect(isNewerVersion("1.2.3", "1.2.3-rc.1")).toBe(true);
	});
});

describe("compareDottedNumeric", () => {
	/**
	 * The hand-rolled comparator from `web/scrapers/hackage.ts`, kept verbatim so
	 * the divergence below is proven against the real historical behavior.
	 */
	function hackageComparator(a: string, b: string): number {
		const aParts = a.split(".").map(part => Number.parseInt(part, 10) || 0);
		const bParts = b.split(".").map(part => Number.parseInt(part, 10) || 0);
		const max = Math.max(aParts.length, bParts.length);
		for (let i = 0; i < max; i++) {
			const delta = (aParts[i] || 0) - (bParts[i] || 0);
			if (delta !== 0) return delta;
		}
		return 0;
	}

	/** The hand-rolled comparator from `scripts/fix-changelogs.ts`, ascending. */
	function changelogComparator(left: string, right: string): number {
		const leftParts = left.split(".").map(part => Number.parseInt(part, 10));
		const rightParts = right.split(".").map(part => Number.parseInt(part, 10));
		const limit = Math.max(leftParts.length, rightParts.length);
		for (let index = 0; index < limit; index++) {
			const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
			if (difference !== 0) return difference;
		}
		return 0;
	}

	describe("ordering", () => {
		it("compares component by component, numerically", () => {
			expect(sign(compareDottedNumeric("1.2.10", "1.2.9"))).toBe(1);
			expect(sign(compareDottedNumeric("1.9.0", "1.10.0"))).toBe(-1);
			expect(sign(compareDottedNumeric("2.0", "1.99.99"))).toBe(1);
		});

		it("treats a missing component as zero, so 1.2 and 1.2.0 rank equal", () => {
			expect(compareDottedNumeric("1.2", "1.2.0")).toBe(0);
			expect(compareDottedNumeric("1.2.0.0", "1.2")).toBe(0);
		});

		it("orders versions with more than three components, which semver cannot", () => {
			// Haskell PVP versions routinely have four. `Bun.semver.order` throws on
			// them, which is why this owner exists next to `compareSemver` rather
			// than callers reaching for the wrong one.
			expect(sign(compareDottedNumeric("1.2.3.4", "1.2.3"))).toBe(1);
			expect(sign(compareDottedNumeric("1.2.3.4", "1.2.3.5"))).toBe(-1);
		});

		it("sorts a list ascending when used directly as a sort comparator", () => {
			expect(["1.10", "1.2.3.4", "2.0", "1.2"].sort(compareDottedNumeric)).toEqual([
				"1.2",
				"1.2.3.4",
				"1.10",
				"2.0",
			]);
		});
	});

	describe("non-numeric components", () => {
		it("never ranks a non-numeric component equal to zero", () => {
			// REGRESSION: `Number.parseInt("x", 10) || 0` is 0, so the hackage
			// comparator ranked `1.x.3` equal to `1.0.3` and the latest-version
			// lookup could pick either.
			expect(compareDottedNumeric("1.x.3", "1.0.3")).not.toBe(0);
			expect(hackageComparator("1.x.3", "1.0.3")).toBe(0);
		});

		it("never returns NaN, so a sort order is never left to the engine", () => {
			// REGRESSION: the changelog comparator had no `|| 0` guard at all, so a
			// non-numeric part produced `NaN - 0` = NaN. `Array.prototype.sort` with
			// a NaN-returning comparator has implementation-defined results.
			expect(Number.isNaN(compareDottedNumeric("1.x.3", "1.0.3"))).toBe(false);
			expect(Number.isNaN(changelogComparator("1.x.3", "1.0.3"))).toBe(true);
		});

		it("is a consistent ordering, so a sort cannot depend on comparison order", () => {
			const pairs: Array<[string, string]> = [
				["1.x.3", "1.0.3"],
				["1.beta", "1.alpha"],
				["1.2", "1.two"],
			];
			for (const [a, b] of pairs) {
				expect(sign(compareDottedNumeric(a, b))).toBe(-sign(compareDottedNumeric(b, a)));
			}
		});

		it("still ranks identical non-numeric versions equal", () => {
			expect(compareDottedNumeric("1.x.3", "1.x.3")).toBe(0);
		});
	});

	describe("agreement with the comparators this replaced", () => {
		it("matches both of them on the purely numeric cases, which is why the bugs stayed hidden", () => {
			const numeric: Array<[string, string]> = [
				["1.2.10", "1.2.9"],
				["1.9.0", "1.10.0"],
				["2.0.0", "2.0.0"],
				["1.2.3.4", "1.2.3"],
			];
			for (const [a, b] of numeric) {
				expect(sign(compareDottedNumeric(a, b))).toBe(sign(hackageComparator(a, b)));
				expect(sign(compareDottedNumeric(a, b))).toBe(sign(changelogComparator(a, b)));
			}
		});
	});
});
