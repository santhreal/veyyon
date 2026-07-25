/**
 * A deliberate leaker, used by `scripts/find-test-leaks.test.ts` to prove the
 * tracer reports a real leak rather than always printing "ok".
 *
 * Named `.fixture.ts`, NOT `.fixture.test.ts`, and this matters: `bun test <dir>`
 * collects anything matching `*.test.ts` wherever it sits, so the old name meant
 * an ordinary `bun test packages/utils/test` ran this file and left
 * `VEYYON_CONFIG_DIR=/tmp/leaked-by-fixture` set for every suite after it. Any
 * later suite that resolved a config directory then failed, and which suites those
 * were depended on file order, which is what made the pollution look
 * nondeterministic. A path passed to `bun test` explicitly runs whatever its name
 * is, so the tracer can still drive this file directly.
 *
 * `find-test-leaks.ts` skips `fixtures/` during its own walk as a second layer.
 */
import { expect, it } from "bun:test";

it("sets VEYYON_CONFIG_DIR and never restores it", () => {
	process.env.VEYYON_CONFIG_DIR = "/tmp/leaked-by-fixture";
	expect(process.env.VEYYON_CONFIG_DIR).toBe("/tmp/leaked-by-fixture");
});

it("restores what it changes, so it must not be reported", () => {
	const before = process.env.VEYYON_CONFIG_DIR;
	process.env.VEYYON_CONFIG_DIR = "/tmp/temporarily-changed";
	if (before === undefined) delete process.env.VEYYON_CONFIG_DIR;
	else process.env.VEYYON_CONFIG_DIR = before;
	expect(process.env.VEYYON_CONFIG_DIR).toBe(before);
});
