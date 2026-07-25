/**
 * Preload that arms the process-global leak tracer for one test file.
 *
 * Kept separate from `global-state-leak-tracer.ts` because that module is also
 * imported by `scripts/find-test-leaks.ts` to parse the leak lines back out, and
 * `bun:test` hooks throw when the importing process is not the test runner. This
 * file is only ever loaded through `bun test --preload`.
 *
 * See `global-state-leak-tracer.ts` for what counts as a leak and why.
 */
import { afterAll, afterEach, beforeEach } from "bun:test";
// Imported for its registration side effect, before the baseline is taken below,
// so the module-state probes are part of the very first snapshot.
import "./global-state-leak-probes";
import { createLeakWatcher, LEAK_FILE_ENV } from "./global-state-leak-tracer";

const watcher = createLeakWatcher(process.env[LEAK_FILE_ENV] ?? "unknown");

beforeEach(() => watcher.enter());
afterEach(() => watcher.leave());
// Registered here, before the test file is loaded, so it runs AFTER the file's own
// `afterAll`: a suite that moves a global between its tests and puts it back at
// the end pollutes nothing, and must not be reported.
afterAll(() => watcher.finish());
