/**
 * Every first-party module of `@veyyon/utils` evaluates without error when it is the first module a
 * process imports.
 *
 * WHY: an import cycle is harmless in the order the product happens to load it and fatal in
 * another. `dirs.ts` reaches the logger through `file-lock.ts`, so a logger dependency that imports
 * a value back from `dirs.ts` evaluates first whenever `dirs.ts` is the entry, and reads that value
 * in its temporal dead zone (`ReferenceError: Cannot access 'APP_NAME' before initialization`).
 * Every tool, test and script that imports `dirs.ts` directly then crashes at load, while the CLI,
 * which enters through another module, starts fine.
 *
 * THE CLASS: a cycle whose module-scope code reads a binding from a module that has not finished
 * evaluating. The sweep lists `src/` at run time, so a new module is covered on arrival, and each
 * module runs in its own process because the module registry is process-wide.
 *
 * NOT COVERED: `src/vendor/`, which is third-party code reached only through its own index, and a
 * cycle that reads the uninitialized binding inside a function called later rather than at module
 * scope.
 */
import { describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const SRC = path.join(import.meta.dirname, "..", "src");
const CONCURRENCY = 16;

function firstPartyModules(dir: string): string[] {
	const out: string[] = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (full !== path.join(SRC, "vendor")) out.push(...firstPartyModules(full));
		} else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
			out.push(full);
		}
	}
	return out;
}

function importAlone(file: string): Promise<string | undefined> {
	const { promise, resolve } = Promise.withResolvers<string | undefined>();
	const child = spawn(process.execPath, ["-e", `await import(${JSON.stringify(pathToFileURL(file).href)})`], {
		cwd: path.dirname(SRC),
		stdio: ["ignore", "ignore", "pipe"],
	});
	let stderr = "";
	child.stderr.on("data", chunk => {
		stderr += String(chunk);
	});
	child.on("close", code => {
		if (code === 0) resolve(undefined);
		else resolve(stderr.split("\n").find(line => /\w*Error:/.test(line)) ?? `exit ${code}`);
	});
	return promise;
}

describe("utils modules as the entry of a process", () => {
	it("each one loads", async () => {
		const modules = firstPartyModules(SRC);
		// The sweep ran over the tree rather than an empty listing.
		expect(modules).toContain(path.join(SRC, "dirs.ts"));
		expect(modules).toContain(path.join(SRC, "logger.ts"));
		const failures: Record<string, string> = {};
		for (let i = 0; i < modules.length; i += CONCURRENCY) {
			const batch = modules.slice(i, i + CONCURRENCY);
			const results = await Promise.all(batch.map(importAlone));
			results.forEach((failure, j) => {
				if (failure !== undefined) failures[path.relative(SRC, batch[j] as string)] = failure;
			});
		}
		expect(failures).toEqual({});
	}, 120_000);
});
