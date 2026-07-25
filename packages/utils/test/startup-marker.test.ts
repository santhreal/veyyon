/**
 * `startupMarker`: the one synchronous line that survives a hang during startup.
 *
 * WHY THIS SUITE EXISTS. These markers exist for the failure where nothing else reports:
 * startup blocks inside a synchronous call (`dlopen`, sync fs on a dead mount, `spawnSync`)
 * and the process never reaches the point where the timing tree is printed. The last marker
 * on stderr is then the only evidence of which phase was entered. Two properties carry that,
 * and both are the kind a refactor quietly breaks: the write has to reach FILE DESCRIPTOR 2
 * synchronously, so it cannot be reordered or buffered past a blocked event loop, and the
 * whole thing has to stay off unless `VEYYON_DEBUG_STARTUP` is set, since every phase of every
 * run would otherwise print.
 *
 * Both are asserted by running the function in a CHILD process and reading its real stderr,
 * not by stubbing `fs.writeSync`, which Bun makes read-only on the module namespace anyway. A
 * stub would also assert the wrong thing: that a function was called, rather than that bytes
 * reached the descriptor a hung process still flushes.
 *
 * The function also existed TWICE, in `logger.ts` and in `cli.ts`, the second copy documented
 * as deliberate: the CLI bootstrap must not pull in the winston-backed logger module, so
 * `veyyon --version` does not load a logging stack. That constraint is real, so the function
 * now lives in a module whose only dependency is `node:fs` and both import it, which is why
 * this suite also asserts what the module is allowed to import.
 */

import { describe, expect, it } from "bun:test";
import * as path from "node:path";

const MODULE_PATH = path.join(import.meta.dir, "../src/startup-marker.ts");

/**
 * Call `startupMarker` in a child process and return what landed on its stderr.
 *
 * `flag` is the value of `VEYYON_DEBUG_STARTUP`, or null to leave it unset.
 */
function runMarkers(markers: readonly string[], flag: string | null): string {
	const script = [
		`const { startupMarker } = await import(${JSON.stringify(MODULE_PATH)});`,
		...markers.map(marker => `startupMarker(${JSON.stringify(marker)});`),
	].join("\n");
	const env: Record<string, string> = { ...process.env } as Record<string, string>;
	if (flag === null) delete env.VEYYON_DEBUG_STARTUP;
	else env.VEYYON_DEBUG_STARTUP = flag;

	const result = Bun.spawnSync([process.execPath, "-e", script], { env, stderr: "pipe", stdout: "pipe" });

	return new TextDecoder().decode(result.stderr);
}

describe("with VEYYON_DEBUG_STARTUP set", () => {
	/** The exact bytes, prefix and newline included: this line is grepped out of a scrollback. */
	it("writes one prefixed line to stderr", () => {
		expect(runMarkers(["native:loadNative:start"], "1")).toBe("[startup] native:loadNative:start\n");
	});

	it("keeps each marker on its own line, in call order", () => {
		expect(runMarkers(["a:start", "a:done"], "1")).toBe("[startup] a:start\n[startup] a:done\n");
	});

	/** Any non-empty value enables it: this is a debug switch, not a level. */
	it("is enabled by any non-empty value", () => {
		expect(runMarkers(["phase"], "true")).toContain("[startup] phase");
		expect(runMarkers(["phase"], "0")).toContain("[startup] phase");
	});

	/** Nothing goes to stdout: a marker must not contaminate output a caller is parsing. */
	it("writes to stderr only", () => {
		const script = `const { startupMarker } = await import(${JSON.stringify(MODULE_PATH)});\nstartupMarker("phase");`;
		const result = Bun.spawnSync([process.execPath, "-e", script], {
			env: { ...process.env, VEYYON_DEBUG_STARTUP: "1" } as Record<string, string>,
			stderr: "pipe",
			stdout: "pipe",
		});

		expect(new TextDecoder().decode(result.stdout)).toBe("");
		expect(new TextDecoder().decode(result.stderr)).toBe("[startup] phase\n");
	});
});

describe("without the flag", () => {
	/** Silence is the default: every phase of every run would print otherwise. */
	it("writes nothing at all", () => {
		expect(runMarkers(["phase"], null)).toBe("");
	});

	/** An empty value is what an unset shell variable expands to, and is not a request to enable. */
	it("treats an empty value as off", () => {
		expect(runMarkers(["phase"], "")).toBe("");
	});
});

describe("the write itself", () => {
	/**
	 * `fs.writeSync(2, …)` rather than `console.error` or `process.stderr.write`: only the raw
	 * synchronous write is guaranteed to land before a blocked event loop, and landing is the
	 * entire point of the marker. Asserted on the source, because a stream-based write produces
	 * the same bytes in a healthy process and differs only in the hang this exists to diagnose.
	 */
	it("goes through fs.writeSync to descriptor 2", async () => {
		const source = await Bun.file(MODULE_PATH).text();

		expect(source).toContain("fs.writeSync(2,");
		expect(source).not.toContain("console.");
		expect(source).not.toContain("process.stderr");
	});

	/**
	 * A marker must never be the thing that breaks startup: stderr can be closed or full, and a
	 * diagnostic that throws while diagnosing is worse than a missing line.
	 */
	it("swallows a failing write rather than throwing", async () => {
		const source = await Bun.file(MODULE_PATH).text();

		expect(source).toContain("try {");
		expect(source).toContain("} catch {");
	});
});

describe("the module itself", () => {
	/**
	 * The reason it is a module of its own. `cli.ts` kept a copy specifically so the `--version`
	 * path would not import the winston-backed logger; a shared owner only honours that if it
	 * stays free of everything but `node:fs`. An import added here is what would silently pull a
	 * logging stack back into the bootstrap.
	 */
	it("imports nothing but node:fs", async () => {
		const source = await Bun.file(MODULE_PATH).text();
		const imports = [...source.matchAll(/^import .* from "([^"]+)";$/gm)].map(match => match[1]);

		expect(imports).toEqual(["node:fs"]);
	});

	it("is what both former owners now use, and neither defines its own", async () => {
		for (const name of ["logger.ts", "cli.ts"]) {
			const source = await Bun.file(path.join(import.meta.dir, "../src", name)).text();

			expect(source).not.toContain("function startupMarker(");
			expect(source).toContain('from "./startup-marker"');
		}
	});
});
