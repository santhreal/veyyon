/**
 * A filesystem fault has to reach a person, not only the file log.
 *
 * WHY THIS SUITE EXISTS. `fs-optional.ts` opens by declaring that its subject's failure "is not
 * allowed to be silent", and then reported every failure with `logger.warn`. The default transport
 * set is `{ file: true }` with no console transport, and no TUI can write to the console without
 * corrupting its render, so the report reached nobody: a `~/.veyyon/agents` directory that exists and
 * cannot be listed showed the operator "no subagents" and put the reason in a file nobody opens. Two
 * doc comments promised the opposite in so many words. `pathExists` claimed it "fixes what
 * `existsSync` cannot express" by reporting a path that exists and cannot be stat'd, and
 * `PluginManager.doctor` cited that exact sentence as its reason for using `pathExists` over
 * `existsSync`, which made a permissions problem "the kind of broken install doctor is meant to
 * surface" while doctor reported it as `ok`. This is the Law 10 silent fallback the module was written
 * to remove, living inside the module.
 *
 * So what these tests pin is the reach, and the two properties that make the reach trustworthy:
 *
 *   1. A fault raised by `readdirIfPresent` / `statIfPresent` arrives at an attached sink, with the
 *      path, the consequence, and the remedy in the text.
 *   2. Attaching a sink NEVER removes the file-log record, so the structured context stays available
 *      for diagnosis and no configuration reports a fault to fewer places than before.
 *   3. A sink that throws does not break the filesystem read it was reporting on, because these run
 *      inside helpers whose whole contract is to carry on.
 *   4. ENOENT stays silent. If absence raised a fault, every optional config directory in the tree
 *      would raise one on every start, and the channel would be noise within a day, which is the same
 *      outcome as having no channel.
 *   5. TWO ATTACHED SURFACES BOTH GET THE FAULT, and each detaches only itself. The first version of
 *      this module held one slot behind a `setFaultSink`, so a second `createAgentSession` in the same
 *      process REPLACED the first session's sink and the first operator went silent from then on,
 *      which is the exact failure the module was written to remove.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	attachFaultSink,
	type DetachFaultSink,
	type Fault,
	faultSinkCount,
	logger,
	pathExists,
	readdirIfPresent,
	reportFault,
	statIfPresent,
} from "../src/index";

let root: string;
let collected: Fault[];
let warnSpy: ReturnType<typeof spyOn>;
/** Every sink a test attached, detached in `afterEach` so none of them sees the next test's faults. */
let detachers: DetachFaultSink[];

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-fault-sink-"));
	collected = [];
	detachers = [];
	warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
});

afterEach(async () => {
	for (const detach of detachers) detach();
	// The count is asserted rather than assumed: a leaked sink is invisible until it corrupts an
	// unrelated suite, and this module is process-global, so the leak would travel.
	expect(faultSinkCount()).toBe(0);
	warnSpy.mockRestore();
	// Chmod EVERY directory back, not just the root. The unreadable directories these tests create are
	// children of `root`, so restoring only `root` leaves `rm -r` unable to descend and it fails with
	// the same EACCES the test was provoking, which reads as three test failures with ten passing
	// assertions above them.
	await fs.chmod(root, 0o700).catch(() => {});
	for (const entry of await fs.readdir(root, { withFileTypes: true })) {
		if (entry.isDirectory()) await fs.chmod(path.join(root, entry.name), 0o700).catch(() => {});
	}
	await fs.rm(root, { recursive: true, force: true });
});

/** Collect into `collected` for the duration of a test, and register the detach `afterEach` runs. */
function collectFaults(): DetachFaultSink {
	const detach = attachFaultSink(fault => collected.push(fault));
	detachers.push(detach);
	return detach;
}

/** Attach a sink whose faults land in a caller-owned array, for the multi-surface cases. */
function collectInto(bucket: Fault[]): DetachFaultSink {
	const detach = attachFaultSink(fault => bucket.push(fault));
	detachers.push(detach);
	return detach;
}

/**
 * Make a directory unlistable, and say whether that worked.
 *
 * `chmod 0o000` does not stop root, and CI containers routinely run as root, so a test that assumed
 * it worked would assert on a directory it could still read and pass for the wrong reason. Every
 * caller below skips rather than pretends.
 */
async function makeUnreadable(dir: string): Promise<boolean> {
	await fs.chmod(dir, 0o000);
	try {
		await fs.readdir(dir);
		await fs.chmod(dir, 0o700);
		return false;
	} catch {
		return true;
	}
}

describe("reportFault", () => {
	/**
	 * The file log gets the fault whether or not a surface is attached.
	 *
	 * This is what makes attaching a sink safe to do: it can only ADD reach. If forwarding replaced
	 * the log line, then wiring up a TUI would quietly cost every fault its structured context, and
	 * the person diagnosing from a log file afterwards would find less than before the channel
	 * existed.
	 */
	it("writes the file log with no sink attached", () => {
		reportFault({ source: "filesystem", text: "something went wrong", context: { path: "/x", errno: "EACCES" } });

		expect(warnSpy).toHaveBeenCalledTimes(1);
		expect(warnSpy.mock.calls[0]?.[0]).toBe("filesystem: something went wrong");
		expect(warnSpy.mock.calls[0]?.[1]).toEqual({ path: "/x", errno: "EACCES" });
	});

	/** And still writes it when one IS attached, which is the same guarantee from the other side. */
	it("writes the file log AND forwards to the sink", () => {
		collectFaults();

		reportFault({ source: "plugins", text: "cannot read the plugin tree", context: { path: "/p" } });

		expect(warnSpy).toHaveBeenCalledTimes(1);
		expect(collected).toEqual([{ source: "plugins", text: "cannot read the plugin tree", context: { path: "/p" } }]);
	});

	/**
	 * A throwing sink does not propagate, and the throw is itself recorded.
	 *
	 * These are reported from inside helpers that exist to carry on, so a broken renderer must not
	 * turn a diagnostic into an outage. The second log line matters too: a sink that is silently
	 * failing to deliver is this file's own failure mode one level up, so it cannot be swallowed.
	 */
	it("survives a sink that throws, and records that it threw", () => {
		detachers.push(
			attachFaultSink(() => {
				throw new Error("renderer is gone");
			}),
		);

		expect(() => reportFault({ source: "filesystem", text: "unreadable" })).not.toThrow();

		expect(warnSpy).toHaveBeenCalledTimes(2);
		expect(warnSpy.mock.calls[1]?.[0]).toContain("fault sink threw");
		expect(warnSpy.mock.calls[1]?.[1]).toEqual({ source: "filesystem", error: "Error: renderer is gone" });
	});

	/** Detaching stops delivery, which is what keeps one test's sink out of the next test's faults. */
	it("stops forwarding once the sink is detached", () => {
		const detach = collectFaults();
		reportFault({ source: "a", text: "first" });
		detach();
		reportFault({ source: "b", text: "second" });

		expect(collected.map(f => f.text)).toEqual(["first"]);
	});

	/**
	 * TWO SURFACES BOTH GET THE FAULT. This is the bug that shipped in the first version and the
	 * reason the slot became a set.
	 *
	 * `createAgentSession` attaches as it builds, so a process that opens a second session used to
	 * overwrite the first session's sink: every later fault reached the newer surface only and the
	 * first operator was told nothing, silently, for the rest of the run. The module's own header
	 * argues that a machine-level fault concerns BOTH operators, so the single slot contradicted the
	 * documented contract rather than merely implementing it narrowly.
	 *
	 * Both buckets are asserted on the full fault, not on a count, so a delivery that reached one
	 * surface with the wrong content cannot pass.
	 */
	it("delivers to every attached surface rather than only the newest", () => {
		const first: Fault[] = [];
		const second: Fault[] = [];
		collectInto(first);
		collectInto(second);

		reportFault({ source: "filesystem", text: "the mount is gone", context: { path: "/mnt/x" } });

		const expected = [{ source: "filesystem", text: "the mount is gone", context: { path: "/mnt/x" } }];
		expect(first).toEqual(expected);
		expect(second).toEqual(expected);
		expect(faultSinkCount()).toBe(2);
	});

	/**
	 * One surface detaching leaves the other listening, which is the half a slot cannot express at all.
	 *
	 * A session disposing must stop its own delivery and must not take a sibling session's channel down
	 * with it. With one slot, a dispose that cleared the slot would silence whichever session was still
	 * running, so "detach on dispose" was unimplementable without this.
	 */
	it("detaches one surface without silencing the other", () => {
		const first: Fault[] = [];
		const second: Fault[] = [];
		const detachFirst = collectInto(first);
		collectInto(second);

		detachFirst();
		reportFault({ source: "filesystem", text: "after the first left" });

		expect(first).toEqual([]);
		expect(second.map(f => f.text)).toEqual(["after the first left"]);
		expect(faultSinkCount()).toBe(1);
	});

	/**
	 * A THROWING SINK DOES NOT COST THE OTHER SURFACES THEIR REPORT.
	 *
	 * Delivery is a loop, and a single `try` around the loop would mean one broken renderer turned
	 * every other operator's fault into silence: the Law 10 failure this module removes, reachable
	 * again through the delivery path. The healthy sink is asserted to receive the fault, and the order
	 * puts the thrower first so a loop that aborted on the throw would fail this test.
	 */
	it("keeps delivering after a sink throws", () => {
		const healthy: Fault[] = [];
		detachers.push(
			attachFaultSink(() => {
				throw new Error("first surface is gone");
			}),
		);
		collectInto(healthy);

		expect(() => reportFault({ source: "filesystem", text: "unreadable" })).not.toThrow();

		expect(healthy.map(f => f.text)).toEqual(["unreadable"]);
		expect(warnSpy.mock.calls[1]?.[0]).toContain("fault sink threw");
	});

	/** Detach is idempotent, so a dispose path that runs twice does not have to guard the call. */
	it("ignores a second detach of the same sink", () => {
		const detach = collectFaults();
		detach();
		detach();

		expect(faultSinkCount()).toBe(0);
		reportFault({ source: "a", text: "after detach" });
		expect(collected).toEqual([]);
	});

	/**
	 * The same function attached twice is attached once, so it cannot double-report.
	 *
	 * Identity-keyed on purpose: a surface that registers itself on two code paths should show the
	 * operator one line, not two. Callers wanting two registrations pass two closures, which the
	 * multi-surface tests above do.
	 */
	it("attaches an identical sink only once", () => {
		const seen: Fault[] = [];
		const sink = (fault: Fault): void => {
			seen.push(fault);
		};
		detachers.push(attachFaultSink(sink), attachFaultSink(sink));

		expect(faultSinkCount()).toBe(1);
		reportFault({ source: "a", text: "once" });
		expect(seen).toHaveLength(1);
	});

	/**
	 * A sink may detach itself while handling a fault, and the sinks after it still get that fault.
	 *
	 * A surface that discovers mid-render that it is disposed does exactly this. Delivery walks a
	 * snapshot for that reason: iterating the live set would let one sink's detach decide whether the
	 * rest of them were told, and which sinks those were would depend on insertion order.
	 */
	it("finishes delivering a fault a sink detaches during", () => {
		const later: Fault[] = [];
		const detachSelf = attachFaultSink(() => {
			detachSelf();
		});
		detachers.push(detachSelf);
		collectInto(later);

		reportFault({ source: "filesystem", text: "mid-delivery detach" });

		expect(later.map(f => f.text)).toEqual(["mid-delivery detach"]);
		expect(faultSinkCount()).toBe(1);
	});

	/** No sink attached is the default, so a process that never wires one up is unchanged. */
	it("starts with no sinks attached", () => {
		expect(faultSinkCount()).toBe(0);
	});

	/** An absent context is `{}` rather than `undefined`, so a log transport never sees a hole. */
	it("logs an empty context when the fault carries none", () => {
		reportFault({ source: "filesystem", text: "no detail" });

		expect(warnSpy.mock.calls[0]?.[1]).toEqual({});
	});
});

describe("readdirIfPresent", () => {
	/**
	 * A directory that exists and cannot be listed raises a fault naming the CONSEQUENCE.
	 *
	 * The old text was "Could not list a directory while looking for agent definitions", which tells
	 * an operator what syscall failed and not what they have lost. The empty array is the dangerous
	 * part: it is indistinguishable from "nothing configured", so the text has to say that the thing
	 * they configured was not loaded, and has to name the two causes worth checking.
	 */
	it("raises a fault naming the directory, what was lost, and the remedy", async () => {
		const dir = path.join(root, "agents");
		await fs.mkdir(dir);
		await fs.writeFile(path.join(dir, "one.md"), "x");
		if (!(await makeUnreadable(dir))) return;
		collectFaults();

		const entries = await readdirIfPresent(dir, "agent definitions");

		expect(entries).toEqual([]);
		expect(collected).toHaveLength(1);
		expect(collected[0]?.source).toBe("filesystem");
		expect(collected[0]?.text).toContain(dir);
		expect(collected[0]?.text).toContain("agent definitions");
		expect(collected[0]?.text).toContain("could not be listed");
		expect(collected[0]?.text).toContain("permissions");
		expect(collected[0]?.context).toMatchObject({ dir, what: "agent definitions" });
		expect(String(collected[0]?.context?.error)).toContain("EACCES");
	});

	/**
	 * A MISSING directory raises nothing.
	 *
	 * Every optional config directory in the tree is usually absent, so a fault here would fire
	 * several times on every start and the operator would learn to ignore the channel. Absence is
	 * data, not a fault, and that distinction is the whole reason these helpers exist.
	 */
	it("stays silent for a directory that is not there", async () => {
		collectFaults();

		expect(await readdirIfPresent(path.join(root, "nope"), "managed skills")).toEqual([]);

		expect(collected).toEqual([]);
		expect(warnSpy).not.toHaveBeenCalled();
	});

	/** A readable directory returns its entries and raises nothing. */
	it("returns entries without a fault when the directory is readable", async () => {
		const dir = path.join(root, "skills");
		await fs.mkdir(dir);
		await fs.writeFile(path.join(dir, "a.md"), "x");
		collectFaults();

		const entries = await readdirIfPresent(dir, "managed skills");

		expect(entries.map(e => e.name)).toEqual(["a.md"]);
		expect(collected).toEqual([]);
	});
});

describe("statIfPresent and pathExists", () => {
	/**
	 * An unreadable path raises a fault saying the answer is a GUESS.
	 *
	 * "Treating it as absent" was the defect written down: the caller then behaves as though the path
	 * is not there, so a probe switches a feature off and reports nothing. The text has to say that
	 * the absent answer is not a fact, because the return value cannot say it.
	 */
	it("raises a fault that says the path is being treated as absent", async () => {
		const dir = path.join(root, "locked");
		await fs.mkdir(dir);
		const target = path.join(dir, "marker");
		await fs.writeFile(target, "x");
		if (!(await makeUnreadable(dir))) return;
		collectFaults();

		const stat = await statIfPresent(target, "the plugins directory");

		expect(stat).toBeUndefined();
		expect(collected).toHaveLength(1);
		expect(collected[0]?.text).toContain(target);
		expect(collected[0]?.text).toContain("the plugins directory");
		expect(collected[0]?.text).toContain("treated as absent");
		expect(collected[0]?.context).toMatchObject({ path: target, what: "the plugins directory" });
	});

	/**
	 * `pathExists` answers `false` for that case and raises the SAME fault.
	 *
	 * It is a one-line wrapper over `statIfPresent`, so this is not a second code path. It is pinned
	 * anyway because `pathExists` is the function whose doc comment made the false promise and the one
	 * `plugin doctor` calls, so the promise is asserted where the caller reads it.
	 */
	it("answers false and still raises the fault", async () => {
		const dir = path.join(root, "locked2");
		await fs.mkdir(dir);
		const target = path.join(dir, "marker");
		await fs.writeFile(target, "x");
		if (!(await makeUnreadable(dir))) return;
		collectFaults();

		expect(await pathExists(target, "the plugins node_modules")).toBe(false);
		expect(collected).toHaveLength(1);
		expect(collected[0]?.text).toContain("the plugins node_modules");
	});

	/** A path that is simply not there raises nothing, for the same reason as the directory case. */
	it("stays silent for a path that is not there", async () => {
		collectFaults();

		expect(await pathExists(path.join(root, "absent"), "a marker file")).toBe(false);
		expect(await statIfPresent(path.join(root, "absent"), "a marker file")).toBeUndefined();

		expect(collected).toEqual([]);
		expect(warnSpy).not.toHaveBeenCalled();
	});

	/** A present path stats normally, so the guard has not been bought by reporting everything. */
	it("returns the stat for a path that is there", async () => {
		const target = path.join(root, "present");
		await fs.writeFile(target, "hello");
		collectFaults();

		const stat = await statIfPresent(target, "a marker file");

		expect(stat?.size).toBe(5);
		expect(await pathExists(target, "a marker file")).toBe(true);
		expect(collected).toEqual([]);
	});
});
