/**
 * The file transport follows the config root when it moves.
 *
 * The transport resolves its directory once, when the logger is built, and the logger
 * is built on the FIRST log emission — somewhere inside whatever the process happened
 * to be doing. A process that moved the config root afterwards kept writing to the OLD
 * directory forever: the operator finds an empty log file at the location every doc
 * names, and if the old directory has since been deleted the open stream writes to an
 * unlinked file and the lines are gone. The emit helpers swallow logging failures, so
 * nothing reports either case.
 *
 * It is also what left 130 `~/.veyyon-<suite>-<id>` directories in a real home directory,
 * each holding only `logs/` and a cache file: `file-stream-rotator` calls `mkDirForFile`
 * before every `createWriteStream`, so a stream open recreates the whole tree, and a
 * transport still bound under a removed temp root put it back.
 *
 * So these assertions are about the directory on disk rather than the transport object:
 * where the bytes land, and that the abandoned directory stays abandoned. Asserting only
 * the new location is not enough — a rebind that DROPPED the transport instead of
 * replacing it would satisfy that and lose every log line in the process.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getLogsDir, refreshDirsFromEnv } from "@veyyon/utils/dirs";
import * as logger from "@veyyon/utils/logger";
import { Snowflake } from "@veyyon/utils/snowflake";

/** Config roots live under the home directory, so a temp one is reached from it. */
function makeRoot(label: string): { absolute: string; envValue: string } {
	const absolute = path.join(os.tmpdir(), `veyyon-logger-rebind-${label}-${Snowflake.next()}`);
	mkdirSync(absolute, { recursive: true });
	return { absolute, envValue: path.relative(os.homedir(), absolute) };
}

/** Point the resolver at `root` and confirm it actually took: the whole bug class here
 * is redirecting one root and asserting a different one. */
function useRoot(envValue: string): string {
	process.env.VEYYON_CONFIG_DIR = envValue;
	refreshDirsFromEnv();
	return getLogsDir();
}

function logFileCount(logsDir: string): number {
	if (!existsSync(logsDir)) return 0;
	return readdirSync(logsDir).filter(name => name.includes("veyyon.")).length;
}

/**
 * Wait for a log file to appear, briefly.
 *
 * The file transport writes asynchronously, so asserting immediately after an emit
 * races the stream open. Polling with a deadline keeps the assertion about WHERE the
 * bytes land instead of about how fast the stream opens, and a timeout still fails the
 * test rather than passing on an empty directory.
 */
async function waitForLogFile(logsDir: string, timeoutMs = 2000): Promise<number> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const count = logFileCount(logsDir);
		if (count > 0) return count;
		await Bun.sleep(20);
	}
	return logFileCount(logsDir);
}

const first = makeRoot("first");
const second = makeRoot("second");
const saved = {
	configDir: process.env.VEYYON_CONFIG_DIR,
	stateHome: process.env.XDG_STATE_HOME,
	dataHome: process.env.XDG_DATA_HOME,
	cacheHome: process.env.XDG_CACHE_HOME,
};

let firstLogsDir = "";
let secondLogsDir = "";

beforeAll(() => {
	// XDG would move the logs out of the config root and make the move under test
	// invisible, which is exactly the "redirected one root, asserted another" trap.
	delete process.env.XDG_STATE_HOME;
	delete process.env.XDG_DATA_HOME;
	delete process.env.XDG_CACHE_HOME;
	// The logger is process-global shared state and other suites in this process leave
	// it turned OFF (`logger-no-transports` and `logger-error-serialization` both end on
	// `{ file: false, console: false }`). Claiming the default file transport here is not
	// optional tidiness: without it every assertion below reads an empty directory and
	// the suite passes or fails on suite ORDER rather than on the behavior under test.
	// Order matters: redirect the config root BEFORE claiming the file transport.
	// `setTransports` builds the transport eagerly, so doing it first opens a stream in
	// the developer's real `~/.veyyon`, which the real-data tripwire rightly refuses.
	firstLogsDir = useRoot(first.envValue);
	logger.setTransports({ file: true });
	logger.info("logger-rebind: first root");
});

afterAll(() => {
	for (const [key, value] of Object.entries(saved)) {
		const name = {
			configDir: "VEYYON_CONFIG_DIR",
			stateHome: "XDG_STATE_HOME",
			dataHome: "XDG_DATA_HOME",
			cacheHome: "XDG_CACHE_HOME",
		}[key] as string;
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	refreshDirsFromEnv();
	// Leave the logger where it was found: off, so a later suite sees what it expected.
	logger.setTransports({ file: false, console: false });
	rmSync(first.absolute, { force: true, recursive: true });
	rmSync(second.absolute, { force: true, recursive: true });
});

describe("the log file's location", () => {
	/** The control. Without it, "nothing in the first root" below would pass on a
	 * logger that never wrote anywhere at all. */
	it("is inside the config root that was active on the first emission", async () => {
		expect(firstLogsDir.startsWith(first.absolute)).toBe(true);
		expect(await waitForLogFile(firstLogsDir)).toBeGreaterThan(0);
	});

	/** THE regression, in two halves. The abandoned root must stay gone... */
	it("does not come back to a removed config root on the next emission", async () => {
		rmSync(first.absolute, { force: true, recursive: true });
		expect(existsSync(first.absolute)).toBe(false);

		secondLogsDir = useRoot(second.envValue);
		logger.info("logger-rebind: second root");
		// Wait for the write to LAND somewhere before judging the old directory: the
		// transport opens its stream asynchronously, so checking immediately would pass
		// even when the recreation is about to happen a millisecond later.
		await waitForLogFile(secondLogsDir);

		expect(existsSync(first.absolute)).toBe(false);
	});

	/** ...and the bytes must actually arrive in the new one, not silently go nowhere.
	 * A rebind that dropped the transport instead of replacing it would satisfy the
	 * assertion above and lose every log line in the process. */
	it("moves to the new config root", async () => {
		expect(secondLogsDir.startsWith(second.absolute)).toBe(true);
		expect(await waitForLogFile(secondLogsDir)).toBeGreaterThan(0);
	});

	/** Every level goes through the same builder, so the rebind must not depend on
	 * which one happened to be called first. */
	it("keeps writing to the new root for every level", async () => {
		logger.warn("logger-rebind: warn");
		logger.error("logger-rebind: error");
		logger.debug("logger-rebind: debug");

		expect(existsSync(first.absolute)).toBe(false);
		expect(await waitForLogFile(secondLogsDir)).toBeGreaterThan(0);
	});
});

describe("a rebind that cannot succeed", () => {
	/**
	 * The rebuild has to happen BEFORE the swap.
	 *
	 * Clearing the transports first and building second means an unwritable destination
	 * leaves the logger with NO transports, and because the emit helpers swallow their
	 * own failures the process then goes quiet for the rest of its life while winston
	 * prints "Attempt to write logs with no transports" on every single line. That is
	 * the worse outcome by far: a temporary problem with one directory turns into losing
	 * all logging. Keeping the working transport bound and announcing the failure is the
	 * loud fallback; going silent is the banned one.
	 */
	it("keeps writing to the previous directory and says so", async () => {
		const working = makeRoot("working");
		const workingLogs = useRoot(working.envValue);
		logger.setTransports({ file: true });
		logger.info("logger-rebind: before the unwritable move");
		expect(await waitForLogFile(workingLogs)).toBeGreaterThan(0);
		const before = logFileCount(workingLogs);

		// A file where the config root must be a directory: every mkdir under it fails
		// with ENOTDIR, which is a real unwritable destination rather than a mock.
		const blocked = path.join(os.tmpdir(), `veyyon-logger-rebind-blocked-${Snowflake.next()}`);
		writeFileSync(blocked, "not a directory");
		const warnings: string[] = [];
		const onWarning = (warning: Error): void => {
			warnings.push(warning.message);
		};
		process.on("warning", onWarning);
		try {
			process.env.VEYYON_CONFIG_DIR = path.relative(os.homedir(), blocked);
			refreshDirsFromEnv();
			logger.info("logger-rebind: into the unwritable root");
			await Bun.sleep(50);
		} finally {
			process.off("warning", onWarning);
		}

		// The line still lands where the logger was already bound, and the failure is
		// announced instead of absorbed.
		expect(logFileCount(workingLogs)).toBeGreaterThanOrEqual(before);
		expect(warnings.join("\n")).toContain(blocked);
		expect(warnings.join("\n")).toContain(workingLogs);

		rmSync(blocked, { force: true });
		rmSync(working.absolute, { force: true, recursive: true });
	});

	/**
	 * Announced ONCE, not once per line.
	 *
	 * The rebind check runs on every emission, so an unwritable destination costs a failed
	 * `mkdir` and a warning for every log line the process ever writes. The first version
	 * of this fix emitted 4626 warnings in a single `packages/coding-agent` run, which is
	 * the same absorbed failure as before wearing a louder costume: nobody reads warning
	 * number 300. One warning per destination is the contract.
	 */
	it("announces a failed destination once, not on every line", async () => {
		const working = makeRoot("repeat");
		const workingLogs = useRoot(working.envValue);
		logger.setTransports({ file: true });
		logger.info("logger-rebind: before the repeated failure");
		expect(await waitForLogFile(workingLogs)).toBeGreaterThan(0);

		const blocked = path.join(os.tmpdir(), `veyyon-logger-rebind-repeat-${Snowflake.next()}`);
		writeFileSync(blocked, "not a directory");
		const warnings: string[] = [];
		const onWarning = (warning: Error): void => {
			if (warning.message.includes(blocked)) warnings.push(warning.message);
		};
		process.on("warning", onWarning);
		try {
			process.env.VEYYON_CONFIG_DIR = path.relative(os.homedir(), blocked);
			refreshDirsFromEnv();
			for (let i = 0; i < 25; i++) logger.info(`logger-rebind: repeated line ${i}`);
			await Bun.sleep(50);
		} finally {
			process.off("warning", onWarning);
		}

		expect(warnings).toHaveLength(1);

		rmSync(blocked, { force: true });
		rmSync(working.absolute, { force: true, recursive: true });
	});
});

describe("a log destination that fails after the transport was built", () => {
	/**
	 * A log line must never take the process down.
	 *
	 * A transport is an EventEmitter and an `error` with no listener is an UNCAUGHT
	 * exception, and `winston-daily-rotate-file` forwards `new`, `rotate` and `logRemoved`
	 * from its underlying rotator but NOT `error`. So a destination that goes wrong while
	 * the stream is opening — the directory removed, the disk full, the volume unmounted —
	 * crashed whatever was running. This was not theoretical: the rebind made it reachable
	 * in ordinary use, and `keybindings-migration` started dying on an `ENOENT` for a temp
	 * logs directory its own cleanup had just removed.
	 *
	 * The listener is attached to the rotator's stream as well as the transport for exactly
	 * that gap, and this is the test that fails if either half is dropped.
	 */
	it("does not throw out of the emit path", async () => {
		const vanishing = makeRoot("vanishing");
		const logsDir = useRoot(vanishing.envValue);
		logger.setTransports({ file: true });
		logger.info("logger-rebind: before the directory vanishes");
		expect(await waitForLogFile(logsDir)).toBeGreaterThan(0);

		// Remove the whole tree while the transport is live, then keep logging. The rotator
		// re-creates the directory on its next open, so this is not the same as the unwritable
		// case above: here the open can succeed or fail depending on timing, and neither
		// outcome may reach the caller as a throw.
		rmSync(vanishing.absolute, { force: true, recursive: true });

		expect(() => {
			for (let i = 0; i < 20; i++) logger.info(`logger-rebind: after removal ${i}`);
		}).not.toThrow();
		await Bun.sleep(100);

		rmSync(vanishing.absolute, { force: true, recursive: true });
	});
});

describe("an explicitly configured log directory", () => {
	/** `setTransports({ file: "<dir>" })` is a caller naming the path itself, and that
	 * choice must survive a config-root move: following the resolver there would take
	 * a service's logs away from the directory its supervisor is tailing. */
	it("is not moved by a config-root change", async () => {
		const explicit = path.join(second.absolute, "explicit-logs");
		logger.setTransports({ file: explicit });
		logger.info("logger-rebind: explicit dir");
		expect(await waitForLogFile(explicit)).toBeGreaterThan(0);

		const third = makeRoot("third");
		useRoot(third.envValue);
		logger.info("logger-rebind: after move");
		await Bun.sleep(100);

		expect(existsSync(path.join(third.absolute, "logs"))).toBe(false);
		expect(logFileCount(explicit)).toBeGreaterThan(0);
		rmSync(third.absolute, { force: true, recursive: true });
		logger.setTransports({ file: true });
	});
});
