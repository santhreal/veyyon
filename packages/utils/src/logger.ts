/**
 * Centralized logger for Veyyon.
 *
 * Default: `~/.veyyon/profiles/<name>/logs/veyyon.<DATE>.log` through {@link RotatingLogFile}, no
 * console output (writing to stdout/stderr would corrupt the TUI). Long-running headless services
 * (the auth broker, etc.) call {@link setTransports} to write to stdout instead, so a process
 * supervisor (pm2, journald, k8s) captures the logs.
 *
 * Each entry is one JSON line: `timestamp` (local time with its UTC offset), `level`, `pid`,
 * `message`, then the context's own fields. `pid` keeps concurrent veyyon instances traceable.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { isPromise } from "node:util/types";
import { getLogsDir } from "./dirs";
import { localTime } from "./local-time";
import { RotatingLogFile } from "./log-file";
import { drainModuleLoadEvents } from "./timing-buffer";
import { errorMessage } from "./type-guards";

type LogLevel = "error" | "warn" | "info" | "debug";

/** One destination for formatted lines. */
interface LogSink {
	write(line: string, now: Date): void;
	close(): void;
}

/**
 * JSON.stringify replacer that unwraps {@link Error} instances. Error's own
 * properties are non-enumerable, so a plain `JSON.stringify(err)` produces
 * `"{}"`. Without this, a context like `{ err }` lost every useful field and
 * forensic logs showed only an opaque empty object.
 */
function jsonReplacer(_key: string, value: unknown): unknown {
	if (value instanceof Error) {
		const out: Record<string, unknown> = {
			name: value.name,
			message: value.message,
			stack: value.stack,
		};
		// Preserve `.cause` and any custom enumerable fields the caller attached.
		const errAsRecord = value as unknown as Record<string, unknown>;
		for (const k in errAsRecord) out[k] = errAsRecord[k];
		if (value.cause !== undefined) out.cause = value.cause;
		return out;
	}
	return value;
}

function pad2(value: number): string {
	return value < 10 ? `0${value}` : String(value);
}

/** `YYYY-MM-DDTHH:mm:ss.SSS±HH:MM` in local time. */
function localTimestamp(date: Date): string {
	const {
		year,
		month,
		day,
		hours,
		minutes,
		seconds,
		milliseconds: ms,
		offsetMinutes: offset,
	} = localTime(date.getTime());
	const absolute = Math.abs(offset);
	return (
		`${year}-${pad2(month)}-${pad2(day)}` +
		`T${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}` +
		`.${ms < 10 ? `00${ms}` : ms < 100 ? `0${ms}` : ms}` +
		`${offset < 0 ? "-" : "+"}${pad2(Math.floor(absolute / 60))}:${pad2(absolute % 60)}`
	);
}

/**
 * One log line, newline included. A context's own fields follow the fixed ones, except `level`,
 * `timestamp` and `message`, which the line sets; a truthy context `message` is appended to the
 * line's message after a space.
 */
function formatLine(level: LogLevel, message: string, context: Record<string, unknown> | undefined, now: Date): string {
	const entry: Record<string, unknown> = {
		timestamp: localTimestamp(now),
		level,
		pid: process.pid,
		message: context?.message ? `${message} ${String(context.message)}` : message,
	};
	if (context) {
		for (const key of Object.keys(context)) {
			if (key !== "level" && key !== "timestamp" && key !== "message") entry[key] = context[key];
		}
	}
	return `${JSON.stringify(entry, jsonReplacer)}\n`;
}

/**
 * The directory the live file sink writes to, so a later move is noticed.
 *
 * `undefined` while no file sink exists, and set to an explicit directory when
 * {@link setTransports} was given one (that caller chose the path and owns it).
 */
let fileSinkDir: string | undefined;

/** Whether the live file sink follows {@link getLogsDir} rather than a fixed path. */
let fileSinkFollowsDirs = false;

/**
 * A destination the rebind already failed on, so it is neither retried nor re-announced.
 *
 * The rebind check runs on every emission, so a destination that cannot be written to
 * would otherwise cost one failed `mkdir` and one warning per log line. Cleared as soon
 * as the resolved directory changes again or transports are reconfigured, so a problem
 * that gets fixed is picked up on the next line.
 */
let failedRebindTarget: string | undefined;

/** Build the rotating file sink, creating its directory now so an unusable one fails here. */
function makeFileSink(dir?: string): LogSink {
	const target = dir ?? getLogsDir();
	// Everything about a log destination can go wrong after the sink is built: the directory is
	// removed, the disk fills, the volume is unmounted. None of that is a reason to take the process
	// down, and the log line is the least important thing happening at that moment. Announced once
	// per sink through `process.emitWarning`, because the logger is the thing that just failed and a
	// per-line report would be its own flood.
	let announced = false;
	const sink = new RotatingLogFile(target, {
		onError: error => {
			if (announced) return;
			announced = true;
			process.emitWarning(`Log output to "${target}" failed: ${error.message}`, {
				code: "VEYYON_LOG_WRITE_FAILED",
			});
		},
	});
	fileSinkFollowsDirs = dir === undefined;
	fileSinkDir = target;
	return sink;
}

/** Writes each line to stdout, looked up at the time of the write. */
const consoleSink: LogSink = {
	write(line) {
		process.stdout.write(line);
	},
	close() {},
};

/**
 * Desired transport configuration, applied when the sinks are built.
 * Default: file ON (TUI-safe), console OFF.
 */
let transportOpts: { console?: boolean; file?: boolean | string } = { file: true };

/** The active sinks, or `undefined` until the first log emission builds them. */
let sinks: LogSink[] | undefined;

function buildSinks(opts: { console?: boolean; file?: boolean | string }): LogSink[] {
	const built: LogSink[] = [];
	// Cleared first so turning the file sink OFF cannot leave the previous
	// directory recorded, which would make a later move look like a rebind is due.
	fileSinkDir = undefined;
	fileSinkFollowsDirs = false;
	failedRebindTarget = undefined;
	if (opts.file) built.push(makeFileSink(typeof opts.file === "string" ? opts.file : undefined));
	if (opts.console) built.push(consoleSink);
	return built;
}

function closeSinks(active: LogSink[]): void {
	for (const sink of active) {
		try {
			sink.close();
		} catch {}
	}
}

/**
 * Rebind the file sink when the config root has moved under it.
 *
 * The sink resolves its directory ONCE, when it is built, and it is built on the first log
 * emission, which lands somewhere inside whatever the process happened to be doing. A process that
 * moved the config root afterwards kept writing to the OLD directory forever. Two ways that hurts,
 * both silent:
 *
 *  - The lines are not where the operator looks for them. `veyyon logs` and every doc
 *    name the CURRENT config root, and the file there simply has no entries.
 *  - If the old directory has been deleted meanwhile, the open descriptor keeps writing to
 *    an unlinked file and the lines are gone. The emit helpers swallow logging failures
 *    by design, so there is nothing to notice.
 *
 * A sink still bound under a removed temp root also recreates that root when it reopens its file,
 * which is what left 130 `~/.veyyon-*-<id>` directories in a real home directory, each holding only
 * `logs/` and a cache file.
 *
 * Checking on emit rather than being told about the move keeps the dependency one-way:
 * `dirs.ts` resolves every path in the process and must not import the logger.
 * `getLogsDir` is a cached lookup, so the cost is a map read per emission.
 */
function rebindFileSinkIfMoved(active: LogSink[]): LogSink[] {
	if (!fileSinkFollowsDirs || fileSinkDir === undefined) return active;
	let current: string;
	try {
		current = getLogsDir();
	} catch {
		// An unusable HOME is reported by the code that resolves paths for real work,
		// not by a log line's side effect. Keep writing where we already are.
		return active;
	}
	if (current === fileSinkDir) return active;
	// A destination that already failed is not retried, and not re-announced. The check
	// runs on EVERY emission, so without this a single unwritable destination produces one
	// failed `mkdir` and one warning per log line.
	if (current === failedRebindTarget) return active;
	// BUILD FIRST, then swap. Closing first and building second means a failed build
	// (an unwritable directory, a guard refusing the path) leaves the logger with no
	// sinks at all, and since the emit helpers swallow their own failures the process
	// would go quiet for the rest of its life. Keeping the working sink bound is strictly
	// better than that, and the failure is announced rather than absorbed.
	const previous = { dir: fileSinkDir, follows: fileSinkFollowsDirs };
	let rebuilt: LogSink[];
	try {
		rebuilt = buildSinks(transportOpts);
	} catch (error) {
		fileSinkDir = previous.dir;
		fileSinkFollowsDirs = previous.follows;
		failedRebindTarget = current;
		// `process.emitWarning` rather than a log line: the logger is the thing that just
		// failed, so logging the failure is not available. Same reasoning as the XDG
		// refusal in `dirs.ts`.
		process.emitWarning(
			`Log output could not follow the config root to "${current}" (${errorMessage(error)}); ` +
				`veyyon is still writing to "${previous.dir}".`,
			{ code: "VEYYON_LOG_REBIND_FAILED" },
		);
		return active;
	}
	closeSinks(active);
	sinks = rebuilt;
	return rebuilt;
}

/**
 * Replace the active log transports. Pass `console: true, file: false` for
 * long-running services (the auth broker, etc.) that want their structured
 * logs piped into a process supervisor instead of the rotating file.
 */
export function setTransports(opts: { console?: boolean; file?: boolean | string }): void {
	transportOpts = opts;
	if (!sinks) return; // applied when the first log emission builds the sinks
	closeSinks(sinks);
	sinks = [];
	sinks = buildSinks(opts);
}

function emit(level: LogLevel, message: string, context: Record<string, unknown> | undefined): void {
	try {
		sinks ??= buildSinks(transportOpts);
		const active = rebindFileSinkIfMoved(sinks);
		if (active.length === 0) return;
		const now = new Date();
		const line = formatLine(level, message, context, now);
		for (const sink of active) sink.write(line, now);
	} catch {
		// Silently ignore logging failures
	}
}

/**
 * Log an error message.
 * @param message - The message to log.
 * @param context - The context to log.
 */
export function error(message: string, context?: Record<string, unknown>): void {
	emit("error", message, context);
}

/**
 * Log a warning message.
 * @param message - The message to log.
 * @param context - The context to log.
 */
export function warn(message: string, context?: Record<string, unknown>): void {
	emit("warn", message, context);
}

/**
 * Log an informational message.
 * @param message - The message to log.
 * @param context - The context to log.
 */
export function info(message: string, context?: Record<string, unknown>): void {
	emit("info", message, context);
}

/**
 * Log a debug message.
 * @param message - The message to log.
 * @param context - The context to log.
 */
export function debug(message: string, context?: Record<string, unknown>): void {
	emit("debug", message, context);
}

// The marker itself lives in `./startup-marker`, which imports nothing but `node:fs`
// so the CLI bootstrap can use it without pulling this module's file sink in.
// Re-exported here because callers reach it as `logger.startupMarker`.
export { startupMarker } from "./startup-marker";

import { startupMarker } from "./startup-marker";

const LOGGED_TIMING_THRESHOLD_MS = 0.5;

interface Span {
	op: string;
	start: number;
	end?: number;
	parent?: Span;
	children: Span[];
	/** Marker / point event without a duration. */
	point?: boolean;
	/** Absolute module path for module-load spans. */
	modulePath?: string;
	/** Own top-level module body / TLA duration for module-load spans. */
	moduleBodyMs?: number;
	/** Resolved static imports for module-load spans. */
	moduleImports?: string[];
}
const spanStorage = new AsyncLocalStorage<Span>();
let gRootSpan: Span | undefined;
let gRecordTimings = false;

export function timingModeIncludes(option: "full" | "x"): boolean {
	const value = process.env.VEYYON_TIMING;
	if (!value) return false;
	if (value === option) return true;
	let start = 0;
	for (let i = 0; i <= value.length; i++) {
		const code = i === value.length ? 44 : value.charCodeAt(i);
		const separator = code === 44 || code === 58 || code === 59 || code === 43 || code <= 32;
		if (!separator) continue;
		if (i > start && value.slice(start, i) === option) return true;
		start = i + 1;
	}
	return false;
}

export function shouldExitAfterTimings(): boolean {
	return timingModeIncludes("x") || timingModeIncludes("full");
}

/**
 * Print collected timings as an indented tree.
 * Each span shows wall duration; parents with children also show "(self)" for unattributed time.
 * Sibling spans are sorted by start time. Spans whose intervals overlap with siblings ran in parallel.
 */
export function printTimings(): void {
	if (!gRecordTimings || !gRootSpan) {
		console.error("\n--- Startup Timings ---\n(no markers)\n");
		return;
	}

	gRootSpan.end = performance.now();
	// Splice any preload-captured module-load events into the tree as root
	// children and back-extend the root window over them, so the static-import
	// phase that ran before the first explicit marker becomes visible (the
	// `(modules)` summary below) instead of being lumped into the opaque
	// `(before instrumentation)` figure.
	spliceModuleLoadBuffer();
	const lines: string[] = [];
	lines.push("");
	lines.push("--- Startup timings (hierarchical) ---");
	// performance.now() shares the process-start origin, so the root span's start
	// is the wall time before the first marker — runtime init plus any module
	// loads not captured below. With the module-load preload active this shrinks
	// to ~runtime init because the load phase is back-folded into the window.
	if (gRootSpan.start > LOGGED_TIMING_THRESHOLD_MS) {
		lines.push(`(before instrumentation): ${fmtMs(gRootSpan.start)} [runtime init + module load]`);
	}
	const work: Span[] = [];
	const loads: Span[] = [];
	for (const child of gRootSpan.children) {
		if (isModuleLoadSpan(child)) loads.push(child);
		else work.push(child);
	}
	for (const child of work.sort((a, b) => a.start - b.start)) {
		printSpan(child, 0, lines);
	}
	if (loads.length > 0) {
		printModuleLoadSummary(loads, 0, lines);
	}
	// Surface the root's own unattributed time so the gap between the visible
	// top-level spans and Total isn't silently swallowed.
	const rootSelf = selfTimeOf(gRootSpan);
	if (gRootSpan.children.length > 0 && rootSelf > LOGGED_TIMING_THRESHOLD_MS) {
		lines.push(`(unattributed self): ${fmtMs(rootSelf)}`);
	}
	const totalMs = (gRootSpan.end - gRootSpan.start).toFixed(1);
	lines.push(`Total: ${totalMs}ms (since first marker)`);
	lines.push("--------------------------------------");
	lines.push("");
	console.error(lines.join("\n"));
	gRootSpan.end = undefined;
}

/**
 * Begin recording startup timings under a new root span.
 * Idempotent: a second call while already recording is a no-op, so an explicit
 * starter (main.ts) and any future early starter can coexist.
 */
export function startTiming(): void {
	if (gRecordTimings) return;
	gRootSpan = {
		op: "(root)",
		start: performance.now(),
		parent: undefined,
		children: [],
	};
	gRecordTimings = true;
}

/**
 * Record an externally-measured span as a leaf child of the active span (or root
 * when no span is active). Used by {@link spliceModuleLoadBuffer} to fold
 * preload-captured module windows into the tree.
 */
export function recordModuleLoadSpan(
	path: string,
	start: number,
	durationMs: number,
	bodyMs?: number,
	imports: string[] = [],
): void {
	if (!gRecordTimings || !gRootSpan) return;
	const parent = spanStorage.getStore() ?? gRootSpan;
	const span: Span = {
		op: `load:${shortenLoadPath(path)}`,
		start,
		end: start + durationMs,
		parent,
		children: [],
		modulePath: path,
		moduleBodyMs: bodyMs,
		moduleImports: imports,
	};
	parent.children.push(span);
}

/**
 * Drain the preload's module-load buffer (see module-timer.ts) into the tree as
 * `load:` children of the root, then back-extend the root window to the earliest
 * captured read so the pre-marker load phase is counted in Total rather than
 * hidden as `(before instrumentation)`. No-op when nothing was captured (e.g. no
 * `--preload`, or a compiled binary where module reads are not interceptable).
 */
function spliceModuleLoadBuffer(): void {
	if (!gRootSpan) return;
	const events = drainModuleLoadEvents();
	if (events.length === 0) return;
	let earliest = gRootSpan.start;
	for (const event of events) {
		recordModuleLoadSpan(event.path, event.start, event.durationMs, event.bodyMs, event.imports);
		if (event.start < earliest) earliest = event.start;
	}
	gRootSpan.start = earliest;
}

function shortenLoadPath(p: string): string {
	const cwd = process.cwd();
	if (p.startsWith(`${cwd}/`)) return p.slice(cwd.length + 1);
	const home = process.env.HOME;
	if (home && p.startsWith(`${home}/`)) return `~/${p.slice(home.length + 1)}`;
	return p;
}

/**
 * End timing window and clear buffers.
 */
export function endTiming(): void {
	gRootSpan = undefined;
	gRecordTimings = false;
}

/**
 * Ops of the currently-open span chain (root → deepest), following the most
 * recently started unfinished child at each level. Lets a startup watchdog
 * name the phase a stalled startup is stuck in.
 */
export function openSpanPath(): string[] {
	const ops: string[] = [];
	let node = gRootSpan;
	while (node) {
		let next: Span | undefined;
		for (let i = node.children.length - 1; i >= 0; i--) {
			if (node.children[i].end === undefined) {
				next = node.children[i];
				break;
			}
		}
		if (!next) break;
		ops.push(next.op);
		node = next;
	}
	return ops;
}

function durationOf(span: Span): number {
	if (span.point || span.end === undefined) return 0;
	return span.end - span.start;
}

/** Self time = total - union of child intervals (handles parallel children correctly). */
function selfTimeOf(span: Span): number {
	const dur = durationOf(span);
	if (span.children.length === 0 || span.point) return dur;
	const intervals = span.children
		.filter(c => !c.point && c.end !== undefined)
		.map(c => [c.start, c.end as number] as const)
		.sort((a, b) => a[0] - b[0]);
	if (intervals.length === 0) return dur;
	let union = 0;
	let curStart = intervals[0][0];
	let curEnd = intervals[0][1];
	for (let i = 1; i < intervals.length; i++) {
		const [s, e] = intervals[i];
		if (s > curEnd) {
			union += curEnd - curStart;
			curStart = s;
			curEnd = e;
		} else if (e > curEnd) {
			curEnd = e;
		}
	}
	union += curEnd - curStart;
	return Math.max(0, dur - union);
}

function fmtMs(ms: number): string {
	if (ms < 1) return `${ms.toFixed(2)}ms`;
	if (ms < 100) return `${ms.toFixed(1)}ms`;
	return `${ms.toFixed(0)}ms`;
}

const MODULE_LOAD_PREFIX = "load:";
const MODULE_LOAD_VERBOSE_TOP = 10;
const MODULE_TREE_MAX_DEPTH = 5;
const MODULE_TREE_ROOT_TOP = 5;
const MODULE_TREE_CHILD_TOP = 8;

interface ModuleTimingNode {
	span: Span;
	/** The span's `modulePath`. A load recorded without one has no node. */
	path: string;
	children: ModuleTimingNode[];
	parents: number;
	body: number;
}

function isModuleLoadSpan(span: Span): boolean {
	return span.op.startsWith(MODULE_LOAD_PREFIX);
}

function printSpan(span: Span, depth: number, lines: string[]): void {
	const indent = "  ".repeat(depth);
	if (span.point) {
		lines.push(`${indent}• ${span.op}`);
		return;
	}
	const dur = durationOf(span);
	if (dur < LOGGED_TIMING_THRESHOLD_MS && span.children.length === 0) return;
	const parallel = isParallel(span);
	const tag = parallel ? " [parallel]" : "";
	const self = selfTimeOf(span);
	const selfStr = span.children.length > 0 && self > LOGGED_TIMING_THRESHOLD_MS ? ` (self ${fmtMs(self)})` : "";
	lines.push(`${indent}${span.op}: ${fmtMs(dur)}${selfStr}${tag}`);

	// Split children into work spans and module-load spans for summarization.
	const work: Span[] = [];
	const loads: Span[] = [];
	for (const child of span.children) {
		if (isModuleLoadSpan(child)) loads.push(child);
		else work.push(child);
	}
	for (const child of work.sort((a, b) => a.start - b.start)) {
		printSpan(child, depth + 1, lines);
	}
	if (loads.length > 0) {
		printModuleLoadSummary(loads, depth + 1, lines);
	}
}

/** Render module-load spans as a dependency-aware DAG/tree. */
function printModuleLoadSummary(loads: Span[], depth: number, lines: string[]): void {
	const nodes = buildModuleTimingGraph(loads);
	lines.push(`${"  ".repeat(depth)}(modules): ${loads.length} loaded, wall ${fmtMs(moduleLoadWallMs(loads))}`);
	if (nodes.length === 0) return;
	const showAll = timingModeIncludes("full");
	const indent = "  ".repeat(depth + 1);
	printTopModuleBodies(nodes, indent, lines, showAll);
	printModuleTree(nodes, depth, lines, showAll);
}

/** Time from the first finished module load's start to the last one's end, 0 when none finished. */
function moduleLoadWallMs(loads: Span[]): number {
	let first = Number.POSITIVE_INFINITY;
	let last = 0;
	for (const span of loads) {
		if (span.end === undefined) continue;
		if (span.start < first) first = span.start;
		if (span.end > last) last = span.end;
	}
	return last > first ? last - first : 0;
}

/** The modules with the longest own body or top-level await, longest first. */
function printTopModuleBodies(nodes: ModuleTimingNode[], indent: string, lines: string[], showAll: boolean): void {
	// A copy: the tree below orders `nodes` itself when no module is a root, and ties keep input order.
	const byBody = nodes.slice().sort(compareModuleNodes);
	const topBody = showAll ? byBody : byBody.slice(0, MODULE_LOAD_VERBOSE_TOP);
	lines.push(`${indent}top body/TLA:`);
	for (const node of topBody) {
		if (!showAll && node.body < LOGGED_TIMING_THRESHOLD_MS) break;
		lines.push(`${indent}  ${node.span.op}: body ${fmtMs(node.body)} (total ${fmtMs(durationOf(node.span))})`);
	}
	if (!showAll && byBody.length > MODULE_LOAD_VERBOSE_TOP) {
		lines.push(`${indent}  … ${byBody.length - MODULE_LOAD_VERBOSE_TOP} more (VEYYON_TIMING=full to show all)`);
	}
}

/** The import tree from every module nothing imports, or from every module when all are imported. */
function printModuleTree(nodes: ModuleTimingNode[], depth: number, lines: string[], showAll: boolean): void {
	const indent = "  ".repeat(depth + 1);
	const roots = nodes.filter(node => node.parents === 0);
	const treeRoots = (roots.length > 0 ? roots : nodes).sort((a, b) => durationOf(b.span) - durationOf(a.span));
	const visibleRoots = showAll ? treeRoots : treeRoots.slice(0, MODULE_TREE_ROOT_TOP);
	lines.push(`${indent}tree:`);
	// Every node removes itself from `ancestors` on the way out, so one set serves every root.
	const tree: ModuleTree = { lines, rendered: new Set(), ancestors: new Set(), showAll };
	for (const node of visibleRoots) renderModuleTimingNode(node, depth + 2, tree);
	if (!showAll && treeRoots.length > MODULE_TREE_ROOT_TOP) {
		lines.push(`${indent}  … ${treeRoots.length - MODULE_TREE_ROOT_TOP} more roots (VEYYON_TIMING=full to show all)`);
	}
}

function buildModuleTimingGraph(loads: Span[]): ModuleTimingNode[] {
	const nodes = new Map<string, ModuleTimingNode>();
	for (const span of loads) {
		const path = span.modulePath;
		if (!path || span.end === undefined) continue;
		nodes.set(path, { span, path, children: [], parents: 0, body: span.moduleBodyMs ?? 0 });
	}
	for (const node of nodes.values()) {
		for (const childPath of node.span.moduleImports ?? []) {
			const child = nodes.get(childPath);
			if (!child || child === node) continue;
			node.children.push(child);
			child.parents++;
		}
	}
	for (const node of nodes.values()) {
		node.children.sort(compareModuleNodes);
	}
	return Array.from(nodes.values());
}

function compareModuleNodes(a: ModuleTimingNode, b: ModuleTimingNode): number {
	const bodyDiff = b.body - a.body;
	if (Math.abs(bodyDiff) > 0.001) return bodyDiff;
	return durationOf(b.span) - durationOf(a.span);
}

/** The state one module tree render threads through its recursion. */
interface ModuleTree {
	lines: string[];
	/** Modules already printed with their imports; a later occurrence prints as `[already shown]`. */
	rendered: Set<string>;
	/** Modules on the path from the root to the node being printed; a repeat is an import cycle. */
	ancestors: Set<string>;
	showAll: boolean;
}

/** One module of the import tree at `depth`, then its imports one level deeper. */
function renderModuleTimingNode(node: ModuleTimingNode, depth: number, tree: ModuleTree): void {
	const path = node.path;
	const total = durationOf(node.span);
	if (!tree.showAll && total < LOGGED_TIMING_THRESHOLD_MS && node.children.length === 0) return;
	const cycle = tree.ancestors.has(path);
	const alreadyRendered = tree.rendered.has(path);
	const suffix = cycle ? " [cycle]" : alreadyRendered ? " [already shown]" : "";
	// A `repeat` is a flat string. Appending two spaces to the parent's indent instead nests a rope
	// level per depth in JavaScriptCore, and a full report then takes 40% longer to print.
	const indent = "  ".repeat(depth);
	tree.lines.push(moduleNodeLine(node, total, indent, suffix));
	if (cycle || alreadyRendered) return;
	tree.rendered.add(path);
	tree.ancestors.add(path);
	renderModuleImports(node, depth, indent, tree);
	tree.ancestors.delete(path);
}

/** `op: total (body …, wait …) [shared]` for one module of the import tree, between `indent` and `suffix`. */
function moduleNodeLine(node: ModuleTimingNode, total: number, indent: string, suffix: string): string {
	const timing =
		node.body > LOGGED_TIMING_THRESHOLD_MS || node.children.length > 0
			? ` (body ${fmtMs(node.body)}, wait ${fmtMs(Math.max(0, total - node.body))})`
			: "";
	const shared = node.parents > 1 ? " [shared]" : "";
	return `${indent}${node.span.op}: ${fmtMs(total)}${timing}${shared}${suffix}`;
}

/** The imports of `node` at `depth`, or a count of them past {@link MODULE_TREE_MAX_DEPTH}. */
function renderModuleImports(node: ModuleTimingNode, depth: number, indent: string, tree: ModuleTree): void {
	if (!tree.showAll && tree.ancestors.size >= MODULE_TREE_MAX_DEPTH) {
		if (node.children.length > 0) {
			tree.lines.push(`${indent}  … ${node.children.length} imports deeper (VEYYON_TIMING=full to show all)`);
		}
		return;
	}
	const visibleChildren = tree.showAll ? node.children : node.children.slice(0, MODULE_TREE_CHILD_TOP);
	for (const child of visibleChildren) renderModuleTimingNode(child, depth + 1, tree);
	if (!tree.showAll && node.children.length > MODULE_TREE_CHILD_TOP) {
		tree.lines.push(
			`${indent}  … ${node.children.length - MODULE_TREE_CHILD_TOP} more imports (VEYYON_TIMING=full to show all)`,
		);
	}
}

/** A span is parallel if it overlaps a sibling that started before it. */
function isParallel(span: Span): boolean {
	const parent = span.parent;
	if (!parent || span.end === undefined) return false;
	for (const sibling of parent.children) {
		if (sibling === span || sibling.end === undefined || sibling.point) continue;
		// Overlap test: A overlaps B iff A.start < B.end && B.start < A.end
		if (sibling.start < span.end && span.start < sibling.end) return true;
	}
	return false;
}

/**
 * Time a span. Three forms:
 *   time(op)                    — point event (zero-duration breadcrumb)
 *   time(op, fn, ...args)        — wrap fn in a span; returns fn's return value (sync or Promise)
 *
 * Spans nest hierarchically via AsyncLocalStorage: a child started inside another span's fn
 * (even across awaits) becomes that span's child. Parallel children are recorded as siblings
 * with overlapping intervals.
 */
export function time(op: string): void;
export function time<T, A extends unknown[]>(op: string, fn: (...args: A) => T, ...args: A): T;
export function time<T, A extends unknown[]>(op: string, fn?: (...args: A) => T, ...args: A): T | undefined {
	const recording = gRecordTimings && gRootSpan !== undefined;

	if (fn === undefined) {
		startupMarker(op);
		if (!recording) return undefined as T;
		const parent = spanStorage.getStore() ?? gRootSpan!;
		const now = performance.now();
		parent.children.push({ op, start: now, end: now, parent, children: [], point: true });
		return undefined as T;
	}

	if (!recording && !process.env.VEYYON_DEBUG_STARTUP) {
		return fn(...args);
	}

	startupMarker(`${op}:start`);
	let span: Span | undefined;
	if (recording) {
		const parent = spanStorage.getStore() ?? gRootSpan!;
		span = { op, start: performance.now(), parent, children: [] };
		parent.children.push(span);
	}

	const finish = (ok: boolean): void => {
		if (span) span.end = performance.now();
		startupMarker(ok ? `${op}:done` : `${op}:fail`);
	};
	try {
		const result = span ? spanStorage.run(span, () => fn(...args)) : fn(...args);
		if (isPromise(result)) {
			return result.then(
				value => {
					finish(true);
					return value;
				},
				error => {
					finish(false);
					throw error;
				},
			) as T;
		}
		finish(true);
		return result;
	} catch (error) {
		finish(false);
		throw error;
	}
}
