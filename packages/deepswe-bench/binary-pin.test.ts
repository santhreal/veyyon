/**
 * Pinning the binary is the mechanism that lets several days of quota be pooled
 * into one reward comparison, so its edge cases decide whether a day of spend is
 * usable or wasted.
 *
 * THE FAILURE THESE GUARD AGAINST is silent and delayed. If a run meant to be
 * pinned quietly builds from the working tree instead, it stages a different binary
 * sha; nothing complains at the time; the run completes and spends real quota; and
 * `--merge` refuses the pair a day later when the pooling was the entire point.
 * Three runs on 2026-07-25 staged three different binaries without anybody touching
 * the bench, so this is the normal case in a shared tree rather than an unlucky one.
 */

import { describe, expect, test } from "bun:test";
import * as path from "node:path";

import { resolveBinaryPin } from "./binary-pin";

describe("resolveBinaryPin — a pin that silently becomes a rebuild wastes a day of quota", () => {
	/**
	 * No flag means build from the working tree. That is the DEFAULT, not a fallback:
	 * nothing failed and nothing needs announcing, and every unpinned run before this
	 * feature existed behaved exactly this way.
	 */
	test("builds from the working tree when no binary is pinned", () => {
		expect(resolveBinaryPin(undefined)).toEqual({ kind: "build" });
	});

	/**
	 * A pinned path is resolved against the working directory, because a run
	 * directory is named relatively in the docs and by anybody typing it. Resolving
	 * against the bench package instead would find nothing and the run would die at
	 * the file check, which is at least loud, but the relative form is the one in
	 * every example so it has to work.
	 */
	test("resolves a relative run directory against the working directory", () => {
		const pin = resolveBinaryPin("runs/2026-07-25T22-03-11-251Z/assets/vey", "/work/bench");
		expect(pin).toEqual({
			kind: "pinned",
			path: "/work/bench/runs/2026-07-25T22-03-11-251Z/assets/vey",
		});
	});

	/** An absolute path is kept as given, so a binary outside the bench tree can be pinned. */
	test("keeps an absolute path untouched", () => {
		const pin = resolveBinaryPin("/opt/frozen/vey", "/work/bench");
		expect(pin).toEqual({ kind: "pinned", path: "/opt/frozen/vey" });
	});

	/**
	 * AN EMPTY FLAG IS REJECTED RATHER THAN TREATED AS ABSENT, which is the single
	 * most important case here. `--binary ""` or `--binary=` is an operator mistake,
	 * and quietly building from the tree would be a silent fallback in exactly the
	 * situation where a pin was intended: the run looks fine, spends a day of quota,
	 * and cannot be pooled with the run it was supposed to extend.
	 */
	test("refuses an empty path instead of quietly rebuilding", () => {
		const pin = resolveBinaryPin("");
		expect(pin.kind).toBe("invalid");
		expect(pin.kind === "invalid" && pin.reason).toContain("assets/vey");
	});

	/** Whitespace is the same mistake wearing a different shape, and gets the same refusal. */
	test("refuses a whitespace-only path", () => {
		expect(resolveBinaryPin("   ").kind).toBe("invalid");
	});

	/**
	 * Surrounding whitespace on a real path is trimmed rather than refused. It comes
	 * from copying a path out of a log line or a shell history, the intent is
	 * unambiguous, and failing there would send an operator hunting for a typo that
	 * does not exist.
	 */
	test("trims a path that was pasted with surrounding whitespace", () => {
		const pin = resolveBinaryPin("  runs/a/assets/vey \n", "/work");
		expect(pin).toEqual({ kind: "pinned", path: path.resolve("/work", "runs/a/assets/vey") });
	});

	/**
	 * The three outcomes are distinguishable by `kind` alone. A caller that had to
	 * infer "not pinned" from an empty string could not tell the default apart from
	 * the operator mistake, which is the distinction this whole module exists to
	 * preserve.
	 */
	test("distinguishes build, pinned and invalid without inspecting the path", () => {
		const kinds = [resolveBinaryPin(undefined), resolveBinaryPin("x"), resolveBinaryPin("")].map(p => p.kind);
		expect(kinds).toEqual(["build", "pinned", "invalid"]);
	});
});
