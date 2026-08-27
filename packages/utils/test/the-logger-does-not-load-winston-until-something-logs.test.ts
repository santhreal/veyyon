import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * WHY: every entry point in the product reaches `logger.ts`. `dirs.ts` imports
 * `file-lock.ts` for `withFileLockSync`, and `file-lock.ts` imports this logger
 * for two `logger.warn` calls on failure paths nothing hits at startup. So
 * `veyyon --version` and the interactive launch card both evaluated whatever
 * this module's imports evaluated.
 *
 * `winston` and `winston-daily-rotate-file` cost about 6.6ms of module
 * evaluation between them, and that was paid before the first frame reached the
 * terminal even though no line had been logged. Resolving both on first use
 * took a measured 4.7ms off time-to-first-frame.
 *
 * THE CLASS this closes: a value import at module scope in `logger.ts` that
 * charges every process for a dependency only a log write needs. The guard is
 * the module registry, not a timing threshold, so it cannot flake on a loaded
 * machine and it names the actual defect rather than a slow run.
 *
 * Both directions are asserted, because each fails differently. Only checking
 * "not loaded on import" passes if the accessor is broken and winston never
 * loads at all; only checking "loaded after logging" passes against a plain
 * static import. Together they pin deferral AND resolution.
 *
 * Runs in a subprocess: the registry is process-wide, so a sibling test file
 * that touched winston first would decide the result in a full-suite run.
 *
 * NOT COVERED: how long the deferred work takes, which is a property of the
 * compiled binary and is measured against it, not here. Nor whether some OTHER
 * module on the startup path imports winston — this pins `logger.ts` only.
 */
describe("winston's place in the logger's module graph", () => {
	const loggerUrl = pathToFileURL(path.join(import.meta.dirname, "..", "src", "logger.ts")).href;
	const probe = `
		const winstonModules = () => Object.keys(require.cache).filter(k => k.includes("winston")).length;
		const logger = await import(${JSON.stringify(loggerUrl)});
		const onImport = winstonModules();
		// No transport, so this writes nowhere and still drives the real
		// getWinstonLogger() -> createLogger() path that resolves the package.
		logger.setTransports({ console: false, file: false });
		logger.info("probe");
		process.stdout.write(JSON.stringify({ onImport, afterLog: winstonModules() }));
	`;

	const result = spawnSync(process.execPath, ["-e", probe], {
		encoding: "utf8",
		cwd: path.join(import.meta.dirname, ".."),
	});

	it("stays out of the graph until a line is actually logged", () => {
		expect(result.status).toBe(0);
		const { onImport } = JSON.parse(result.stdout) as { onImport: number };
		expect(onImport).toBe(0);
	});

	it("is resolved by the first log call, so the deferral is not a dead accessor", () => {
		expect(result.status).toBe(0);
		const { afterLog } = JSON.parse(result.stdout) as { afterLog: number };
		expect(afterLog).toBeGreaterThan(0);
	});
});
