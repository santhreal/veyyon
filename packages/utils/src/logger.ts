import { AsyncLocalStorage } from "node:async_hooks";
import * as fs from "node:fs";
import * as path from "node:path";
import { isPromise } from "node:util/types";
import type * as winston from "winston";
import type DailyRotateFile from "winston-daily-rotate-file";
import { getLogsDir } from "./dirs";
import { errorMessage } from "./type-guards";

let winstonLib: typeof winston | undefined;
function w(): typeof winston {
	if (!winstonLib) winstonLib = require("winston") as typeof winston;
	return winstonLib;
}

let rotateFile: typeof DailyRotateFile | undefined;
function rotateFileCtor(): typeof DailyRotateFile {
	if (!rotateFile) rotateFile = require("winston-daily-rotate-file") as typeof DailyRotateFile;
	return rotateFile;
}

function ensureDir(dir: string): string {
	const resolved = path.resolve(dir);
	fs.mkdirSync(resolved, { recursive: true });
	return resolved;
}

function jsonReplacer(_key: string, value: unknown): unknown {
	if (value instanceof Error) {
		const out: Record<string, unknown> = {
			name: value.name,
			message: value.message,
			stack: value.stack,
		};
		const errAsRecord = value as unknown as Record<string, unknown>;
		for (const k in errAsRecord) out[k] = errAsRecord[k];
		if (value.cause !== undefined) out.cause = value.cause;
		return out;
	}
	return value;
}

let logFormat: winston.Logform.Format | undefined;

function getLogFormat(): winston.Logform.Format {
	const wf = w().format;
	if (!logFormat) {
		logFormat = wf.combine(
			wf.timestamp({ format: "YYYY-MM-DDTHH:mm:ss.SSSZ" }),
			wf.printf(({ timestamp, level, message, ...meta }) => {
				const entry: Record<string, unknown> = {
					timestamp,
					level,
					pid: process.pid,
					message,
				};
				for (const [key, value] of Object.entries(meta)) {
					if (key !== "level" && key !== "timestamp" && key !== "message") {
						entry[key] = value;
					}
				}
				return JSON.stringify(entry, jsonReplacer);
			}),
		);
	}
	return logFormat;
}

let fileTransportDir: string | undefined;
let fileTransportFollowsDirs = false;
let failedRebindTarget: string | undefined;

function makeFileTransport(dir?: string): winston.transport {
	fileTransportFollowsDirs = dir === undefined;
	const resolvedDir = ensureDir(dir ?? getLogsDir());
	fileTransportDir = resolvedDir;
	const Transport = rotateFileCtor();
	const transport = new Transport({
		dirname: resolvedDir,
		filename: "veyyon.%DATE%.log",
		datePattern: "YYYY-MM-DD",
		maxFiles: "7d",
		format: getLogFormat(),
	});
	const onError = (error: Error): void => {
		try {
			process.stderr.write(`[veyyon logger error] ${error.message}\n`);
		} catch {}
	};
	transport.on("error", onError);
	const logStream = (
		transport as unknown as { logStream?: { on?: (event: string, listener: (error: Error) => void) => void } }
	).logStream;
	logStream?.on?.("error", onError);
	return transport;
}

function rebindFileTransportIfMoved(logger: winston.Logger): void {
	if (!fileTransportFollowsDirs || fileTransportDir === undefined) return;
	let current: string;
	try {
		current = getLogsDir();
	} catch {
		return;
	}
	if (current === fileTransportDir || current === failedRebindTarget) return;
	const previous = { dir: fileTransportDir, follows: fileTransportFollowsDirs };
	let rebuilt: winston.transport[];
	try {
		rebuilt = buildTransports(transportOpts);
	} catch (error) {
		fileTransportDir = previous.dir;
		fileTransportFollowsDirs = previous.follows;
		failedRebindTarget = current;
		process.emitWarning(
			`Log output could not follow the config root to "${current}" (${errorMessage(error)}); ` +
				`veyyon is still writing to "${previous.dir}".`,
			{ code: "VEYYON_LOG_REBIND_FAILED" },
		);
		return;
	}
	failedRebindTarget = undefined;
	logger.clear();
	for (const transport of rebuilt) logger.add(transport);
	logger.silent = rebuilt.length === 0;
}

function makeConsoleTransport(): winston.transport {
	return new (w().transports.Console)({ format: getLogFormat() });
}

let transportOpts: { console?: boolean; file?: boolean | string } = { file: true };
let winstonLogger: winston.Logger | undefined;

function buildTransports(opts: { console?: boolean; file?: boolean | string }): winston.transport[] {
	const transports: winston.transport[] = [];
	fileTransportDir = undefined;
	fileTransportFollowsDirs = false;
	failedRebindTarget = undefined;
	if (opts.file) transports.push(makeFileTransport(typeof opts.file === "string" ? opts.file : undefined));
	if (opts.console) transports.push(makeConsoleTransport());
	return transports;
}

function getWinstonLogger(): winston.Logger {
	if (!winstonLogger) {
		const transports = buildTransports(transportOpts);
		winstonLogger = w().createLogger({
			level: "debug",
			format: getLogFormat(),
			transports,
			silent: transports.length === 0,
			exitOnError: false,
		});
		return winstonLogger;
	}
	rebindFileTransportIfMoved(winstonLogger);
	return winstonLogger;
}

export function setTransports(opts: { console?: boolean; file?: boolean | string }): void {
	transportOpts = opts;
	if (!winstonLogger) return;
	winstonLogger.clear();
	const transports = buildTransports(opts);
	for (const transport of transports) winstonLogger.add(transport);
	winstonLogger.silent = transports.length === 0;
}

export function error(message: string, context?: Record<string, unknown>): void {
	try {
		getWinstonLogger().error(message, context);
	} catch {}
}

export function warn(message: string, context?: Record<string, unknown>): void {
	try {
		getWinstonLogger().warn(message, context);
	} catch {}
}

export function info(message: string, context?: Record<string, unknown>): void {
	try {
		getWinstonLogger().info(message, context);
	} catch {}
}

export function debug(message: string, context?: Record<string, unknown>): void {
	try {
		getWinstonLogger().debug(message, context);
	} catch {}
}

export { startupMarker } from "./startup-marker";

import { startupMarker } from "./startup-marker";

const LOGGED_TIMING_THRESHOLD_MS = 0.5;

interface Span {
	op: string;
	start: number;
	end?: number;
	parent?: Span;
	children: Span[];
	point?: boolean;
	modulePath?: string;
	moduleBodyMs?: number;
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

export function printTimings(): void {
	if (!gRootSpan) return;
	spliceModuleLoadBuffer();
	const lines: string[] = ["\nStartup Timings:"];
	for (const child of gRootSpan.children) {
		printSpan(child, 1, lines);
	}
	lines.push(`Total: ${fmtMs(durationOf(gRootSpan))}\n`);
	process.stdout.write(lines.join("\n"));
}

export function startTiming(): void {
	if (gRecordTimings) return;
	gRecordTimings = true;
	const now = performance.now();
	gRootSpan = { op: "total", start: now, children: [] };
}

function recordModuleLoadSpan(
	path: string,
	start: number,
	durationMs: number,
	bodyMs?: number,
	imports: string[] = [],
): void {
	if (!gRecordTimings || !gRootSpan) return;
	const parent = spanStorage.getStore() ?? gRootSpan;
	parent.children.push({
		op: `${MODULE_LOAD_PREFIX}${shortenLoadPath(path)}`,
		start,
		end: start + durationMs,
		parent,
		children: [],
		modulePath: path,
		moduleBodyMs: bodyMs,
		moduleImports: imports,
	});
}

function spliceModuleLoadBuffer(): void {
	try {
		const { drainModuleTimerBuffer } = require("./module-timer") as {
			drainModuleTimerBuffer?: () => Array<[string, number, number, number | undefined, string[]]>;
		};
		if (!drainModuleTimerBuffer) return;
		for (const [p, start, duration, body, imports] of drainModuleTimerBuffer()) {
			recordModuleLoadSpan(p, start, duration, body, imports);
		}
	} catch {}
}

function shortenLoadPath(p: string): string {
	const cwd = process.cwd();
	if (p.startsWith(cwd)) return `.${p.slice(cwd.length)}`;
	const nm = p.indexOf("/node_modules/");
	if (nm !== -1) return p.slice(nm + 1);
	return p;
}

export function endTiming(): void {
	if (gRootSpan) gRootSpan.end = performance.now();
	gRecordTimings = false;
}

export function openSpanPath(): string[] {
	const ops: string[] = [];
	let node = gRootSpan;
	while (node) {
		let next: Span | undefined;
		for (let i = node.children.length - 1; i >= 0; i--) {
			if (node.children[i]!.end === undefined) {
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
	const end = span.end ?? performance.now();
	return Math.max(0, end - span.start);
}

function selfTimeOf(span: Span): number {
	const total = durationOf(span);
	const intervals: Array<[number, number]> = [];
	for (const child of span.children) {
		if (child.point) continue;
		intervals.push([child.start, child.end ?? performance.now()]);
	}
	if (intervals.length === 0) return total;
	intervals.sort((a, b) => a[0] - b[0]);
	let unionDur = 0;
	let [curStart, curEnd] = intervals[0]!;
	for (let i = 1; i < intervals.length; i++) {
		const [s, e] = intervals[i]!;
		if (s <= curEnd) {
			curEnd = Math.max(curEnd, e);
		} else {
			unionDur += curEnd - curStart;
			curStart = s;
			curEnd = e;
		}
	}
	unionDur += curEnd - curStart;
	return Math.max(0, total - unionDur);
}

function fmtMs(ms: number): string {
	return `${ms.toFixed(1)}ms`;
}

const MODULE_LOAD_PREFIX = "load:";
const MODULE_LOAD_VERBOSE_TOP = 10;
const MODULE_TREE_MAX_DEPTH = 5;
const MODULE_TREE_ROOT_TOP = 5;
const MODULE_TREE_CHILD_TOP = 8;

interface ModuleTimingNode {
	span: Span;
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

function printModuleLoadSummary(loads: Span[], depth: number, lines: string[]): void {
	const childIndent = "  ".repeat(depth);
	const grandIndent = "  ".repeat(depth + 1);
	let unionStart = Number.POSITIVE_INFINITY;
	let unionEnd = 0;
	for (const span of loads) {
		if (span.end === undefined) continue;
		if (span.start < unionStart) unionStart = span.start;
		if (span.end > unionEnd) unionEnd = span.end;
	}
	const wall = unionEnd > unionStart ? unionEnd - unionStart : 0;
	const nodes = buildModuleTimingGraph(loads);
	lines.push(`${childIndent}(modules): ${loads.length} loaded, wall ${fmtMs(wall)}`);
	if (nodes.length === 0) return;

	const showAll = timingModeIncludes("full");
	const byBody = nodes.slice().sort(compareModuleNodes);
	const topBody = showAll ? byBody : byBody.slice(0, MODULE_LOAD_VERBOSE_TOP);
	lines.push(`${grandIndent}top body/TLA:`);
	for (const node of topBody) {
		if (!showAll && node.body < LOGGED_TIMING_THRESHOLD_MS) break;
		lines.push(`${grandIndent}  ${node.span.op}: body ${fmtMs(node.body)} (total ${fmtMs(durationOf(node.span))})`);
	}
	if (!showAll && byBody.length > MODULE_LOAD_VERBOSE_TOP) {
		lines.push(`${grandIndent}  … ${byBody.length - MODULE_LOAD_VERBOSE_TOP} more (VEYYON_TIMING=full to show all)`);
	}

	const roots = nodes.filter(node => node.parents === 0);
	const treeRoots = (roots.length > 0 ? roots : nodes).sort((a, b) => durationOf(b.span) - durationOf(a.span));
	const visibleRoots = showAll ? treeRoots : treeRoots.slice(0, MODULE_TREE_ROOT_TOP);
	lines.push(`${grandIndent}tree:`);
	const rendered = new Set<string>();
	for (const node of visibleRoots) {
		renderModuleTimingNode(node, depth + 2, lines, rendered, new Set<string>(), showAll);
	}
	if (!showAll && treeRoots.length > MODULE_TREE_ROOT_TOP) {
		lines.push(
			`${grandIndent}  … ${treeRoots.length - MODULE_TREE_ROOT_TOP} more roots (VEYYON_TIMING=full to show all)`,
		);
	}
}

function buildModuleTimingGraph(loads: Span[]): ModuleTimingNode[] {
	const nodes = new Map<string, ModuleTimingNode>();
	for (const span of loads) {
		if (!span.modulePath || span.end === undefined) continue;
		nodes.set(span.modulePath, { span, children: [], parents: 0, body: span.moduleBodyMs ?? 0 });
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

function renderModuleTimingNode(
	node: ModuleTimingNode,
	depth: number,
	lines: string[],
	rendered: Set<string>,
	ancestors: Set<string>,
	showAll: boolean,
): void {
	const path = node.span.modulePath;
	if (!path) return;
	const indent = "  ".repeat(depth);
	const total = durationOf(node.span);
	if (!showAll && total < LOGGED_TIMING_THRESHOLD_MS && node.children.length === 0) return;
	const wait = Math.max(0, total - node.body);
	const shared = node.parents > 1 ? " [shared]" : "";
	const timing =
		node.body > LOGGED_TIMING_THRESHOLD_MS || node.children.length > 0
			? ` (body ${fmtMs(node.body)}, wait ${fmtMs(wait)})`
			: "";
	const alreadyRendered = rendered.has(path);
	const cycle = ancestors.has(path);
	const suffix = cycle ? " [cycle]" : alreadyRendered ? " [already shown]" : "";
	lines.push(`${indent}${node.span.op}: ${fmtMs(total)}${timing}${shared}${suffix}`);
	if (cycle || alreadyRendered) return;
	rendered.add(path);
	ancestors.add(path);
	if (!showAll && ancestors.size >= MODULE_TREE_MAX_DEPTH) {
		if (node.children.length > 0) {
			lines.push(`${indent}  … ${node.children.length} imports deeper (VEYYON_TIMING=full to show all)`);
		}
		ancestors.delete(path);
		return;
	}
	const visibleChildren = showAll ? node.children : node.children.slice(0, MODULE_TREE_CHILD_TOP);
	for (const child of visibleChildren) {
		renderModuleTimingNode(child, depth + 1, lines, rendered, ancestors, showAll);
	}
	if (!showAll && node.children.length > MODULE_TREE_CHILD_TOP) {
		lines.push(
			`${indent}  … ${node.children.length - MODULE_TREE_CHILD_TOP} more imports (VEYYON_TIMING=full to show all)`,
		);
	}
	ancestors.delete(path);
}

function isParallel(span: Span): boolean {
	const parent = span.parent;
	if (!parent || span.end === undefined) return false;
	for (const sibling of parent.children) {
		if (sibling === span || sibling.end === undefined || sibling.point) continue;
		if (sibling.start < span.end && span.start < sibling.end) return true;
	}
	return false;
}

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
			return (result as Promise<unknown>).then(
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
