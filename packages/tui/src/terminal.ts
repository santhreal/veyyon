import { dlopen, FFIType, ptr } from "bun:ffi";
import * as fs from "node:fs";
import { $env, isBunTestRuntime, isTerminalHeadless } from "@veyyon/utils/env";
import * as logger from "@veyyon/utils/logger";
import * as postmortem from "@veyyon/utils/postmortem";
import { restoreTerminalStderr, suppressTerminalStderr } from "@veyyon/utils/stderr-guard";
import { errorMessage } from "@veyyon/utils/type-guards";
import { setKittyProtocolActive } from "./keys";
import { OSC11_RESET_BACKGROUND_SEQUENCE, osc11SetBackgroundSequence, oscChannelTo8Bit } from "./paint-ground";
import { StdinBuffer } from "./stdin-buffer";
import {
	isInsideTmux,
	NotifyProtocol,
	setCellDimensions,
	setOsc99Supported,
	TERMINAL,
	wrapTmuxPassthrough,
} from "./terminal-capabilities";
import { type HangulCompatibilityJamoWidth, setHangulCompatibilityJamoWidth } from "./utils";
import {
	consumeWindowFocusEvent,
	FOCUS_REPORTING_DISABLE,
	FOCUS_REPORTING_ENABLE,
	setWindowFocusState,
} from "./window-focus";

const TERMINAL_PROGRESS_KEEPALIVE_MS = 1000;
const TERMINAL_PROGRESS_ACTIVE_SEQUENCE = "\x1b]9;4;3\x07";
const TERMINAL_PROGRESS_CLEAR_SEQUENCE = "\x1b]9;4;0;\x07";
const WINDOWS_TERMINAL_OSC11_POLL_MS = 30_000;
export function resolveHangulCompatibilityJamoWidthFromTerminalIdentity(
	env: NodeJS.ProcessEnv = Bun.env,
): HangulCompatibilityJamoWidth {
	if (
		env.GHOSTTY_RESOURCES_DIR ||
		env.TERM_PROGRAM?.toLowerCase() === "ghostty" ||
		env.TERM?.toLowerCase().includes("ghostty")
	) {
		return 2;
	}
	return "platform";
}

function shouldEnableModifyOtherKeysFallback(env: NodeJS.ProcessEnv = Bun.env): boolean {
	if (isInsideTmux(env)) return false;
	if (!env.SSH_CONNECTION && !env.SSH_TTY && !env.SSH_CLIENT) return true;
	return TERMINAL.id !== "base" && TERMINAL.id !== "trueColor";
}

function shouldPollWindowsTerminalAppearance(env: NodeJS.ProcessEnv = Bun.env): boolean {
	if (process.platform !== "win32") return false;
	if (!env.WT_SESSION) return false;
	return !env.TERM_PROGRAM || env.TERM_PROGRAM.toLowerCase() === "windows_terminal";
}
const MAX_CONPTY_WRITE_CHUNK_BYTES = 16 * 1024;

export function chunkForConPTY(data: string, maxChunkBytes: number = MAX_CONPTY_WRITE_CHUNK_BYTES): string[] {
	if (Buffer.byteLength(data, "utf8") <= maxChunkBytes) return [data];
	const chunks: string[] = [];
	const len = data.length;
	let pos = 0;
	while (pos < len) {
		let bytes = 0;
		let lastNewlineEnd = -1;
		let i = pos;
		while (i < len) {
			const cu = data.charCodeAt(i);
			let cuLen = 1;
			let cuBytes: number;
			if (cu < 0x80) {
				cuBytes = 1;
			} else if (cu < 0x800) {
				cuBytes = 2;
			} else if (cu >= 0xd800 && cu < 0xdc00) {
				const next = i + 1 < len ? data.charCodeAt(i + 1) : 0;
				if (next >= 0xdc00 && next < 0xe000) {
					cuBytes = 4;
					cuLen = 2;
				} else {
					cuBytes = 3;
				}
			} else {
				cuBytes = 3;
			}
			if (bytes + cuBytes > maxChunkBytes && i > pos) {
				const cut = lastNewlineEnd > pos ? lastNewlineEnd : i;
				chunks.push(data.slice(pos, cut));
				pos = cut;
				break;
			}
			bytes += cuBytes;
			i += cuLen;
			if (cu === 0x0a) lastNewlineEnd = i;
		}
		if (i >= len) {
			chunks.push(data.slice(pos));
			pos = len;
		}
	}
	return chunks;
}

const FATAL_WRITE_CODES = new Set(["EPIPE", "EBADF", "ENXIO", "ERR_STREAM_DESTROYED", "ERR_STREAM_WRITE_AFTER_END"]);

const MAX_CONSECUTIVE_WRITE_FAILURES = 8;

export function terminalWriteErrorCode(err: unknown): string | undefined {
	if (err && typeof err === "object" && "code" in err) {
		const code = (err as { code?: unknown }).code;
		if (typeof code === "string") return code;
	}
	return undefined;
}

export type WriteFailureDecision = "disable-fatal" | "disable-exhausted" | "retry";

export function decideTerminalWriteFailure(err: unknown, consecutiveFailures: number): WriteFailureDecision {
	const code = terminalWriteErrorCode(err);
	if (code !== undefined && FATAL_WRITE_CODES.has(code)) return "disable-fatal";
	if (consecutiveFailures >= MAX_CONSECUTIVE_WRITE_FAILURES) return "disable-exhausted";
	return "retry";
}

let activeTerminal: ProcessTerminal | null = null;
let terminalEverStarted = false;
let altScreenActive = false;

let osc11BackgroundOverridden = false;

export const ENHANCED_PASTE_MODE = 5522;

let enhancedPasteArmed = false;
let terminalRestoreRegistered = false;

function registerPostmortemTerminalRestore(): void {
	if (terminalRestoreRegistered) return;
	terminalRestoreRegistered = true;
	postmortem.register("terminal-restore", () => {
		emergencyTerminalRestore();
	});
}

export function setAltScreenActive(active: boolean): void {
	altScreenActive = active;
}

const stdoutErrorHandlers = new Set<(err: Error) => void>();
let stdoutErrorListenerInstalled = false;

function onStdoutError(err: Error): void {
	for (const handler of stdoutErrorHandlers) handler(err);
}

function registerStdoutErrorHandler(handler: (err: Error) => void): () => void {
	stdoutErrorHandlers.add(handler);
	if (!stdoutErrorListenerInstalled) {
		process.stdout.on("error", onStdoutError);
		stdoutErrorListenerInstalled = true;
	}
	return () => {
		stdoutErrorHandlers.delete(handler);
	};
}

const STD_INPUT_HANDLE = -10;
const ENABLE_VIRTUAL_TERMINAL_INPUT = 0x0200;
const CP_UTF8 = 65001;

let consoleCodepageGuard: (() => void) | null | undefined;

function ensureWindowsConsoleUtf8(): void {
	if (consoleCodepageGuard === undefined) consoleCodepageGuard = createConsoleCodepageGuard();
	consoleCodepageGuard?.();
}

let lastWarnedCodepage = 0;

function createConsoleCodepageGuard(): (() => void) | null {
	if (process.platform !== "win32") return null;
	try {
		const kernel32 = dlopen("kernel32.dll", {
			GetConsoleOutputCP: { args: [], returns: FFIType.u32 },
			SetConsoleOutputCP: { args: [FFIType.u32], returns: FFIType.bool },
			GetConsoleCP: { args: [], returns: FFIType.u32 },
			SetConsoleCP: { args: [FFIType.u32], returns: FFIType.bool },
		});
		return () => {
			try {
				const outCp = kernel32.symbols.GetConsoleOutputCP();
				if (outCp !== 0 && outCp !== CP_UTF8) {
					kernel32.symbols.SetConsoleOutputCP(CP_UTF8);
					if (outCp !== lastWarnedCodepage) {
						lastWarnedCodepage = outCp;
						logger.warn("console output codepage changed by a child process; restoring UTF-8", {
							codepage: outCp,
						});
					}
				}
				const inCp = kernel32.symbols.GetConsoleCP();
				if (inCp !== 0 && inCp !== CP_UTF8) {
					kernel32.symbols.SetConsoleCP(CP_UTF8);
				}
			} catch {
				consoleCodepageGuard = null;
			}
		};
	} catch {
		return null;
	}
}
export function emergencyTerminalRestore(): void {
	try {
		restoreTerminalStderr();
		const terminal = activeTerminal;
		if (terminal) {
			terminal.stop();
			if (altScreenActive) {
				terminal.write("\x1b[?1049l");
				altScreenActive = false;
			}
			if (osc11BackgroundOverridden) {
				terminal.write(OSC11_RESET_BACKGROUND_SEQUENCE);
				osc11BackgroundOverridden = false;
			}
			terminal.showCursor();
		} else if (terminalEverStarted && !isTerminalHeadless()) {
			process.stdout.write(
				"\x1b[?2026l" + // End synchronized output
					"\x1b[?7h" + // Restore autowrap
					"\x1b[?2004l" + // Disable bracketed paste
					FOCUS_REPORTING_DISABLE + // Stop focus reporting (mode 1004)
					"\x1b[?2031l" + // Disable Mode 2031 appearance notifications
					"\x1b[?2048l" + // Disable in-band resize notifications
					(enhancedPasteArmed ? "\x1b[?5522l" : "") +
					"\x1b[<u" + // Pop kitty keyboard protocol
					"\x1b[>4;0m" + // Disable modifyOtherKeys fallback
					"\x1b[?1006l\x1b[?1003l\x1b[?1000l" + // Disable mouse tracking (fullscreen overlays)
					(altScreenActive ? "\x1b[?1049l" : "") +
					(osc11BackgroundOverridden ? OSC11_RESET_BACKGROUND_SEQUENCE : "") +
					"\x1b[?25h", // Show cursor
			);
			altScreenActive = false;
			osc11BackgroundOverridden = false;
			if (process.stdin.setRawMode) {
				process.stdin.setRawMode(false);
			}
		}
	} catch {}
}
export type TerminalAppearance = "dark" | "light";
export interface Terminal {
	start(onInput: (data: string) => void, onResize: () => void): void;

	stop(): void;

	drainInput(maxMs?: number, idleMs?: number): Promise<void>;

	write(data: string): void;

	get columns(): number;
	get rows(): number;

	get kittyProtocolActive(): boolean;

	get kittyEnableSequence(): string | null;

	readonly keyboardEnhancementEnterSequence?: string | null;

	readonly keyboardEnhancementExitSequence?: string | null;

	moveBy(lines: number): void; // Move cursor up (negative) or down (positive) by N lines

	hideCursor(): void; // Hide the cursor
	showCursor(): void; // Show the cursor

	clearLine(): void; // Clear current line
	clearFromCursor(): void; // Clear from cursor to end of screen
	clearScreen(): void; // Clear entire screen and move cursor to (0,0)

	setTitle(title: string): void; // Set terminal window title

	setProgress(active: boolean): void;

	onAppearanceChange(callback: (appearance: TerminalAppearance) => void): void;
	get appearance(): TerminalAppearance | undefined;
	readonly backgroundColor?: string | undefined;
	onBackgroundColorChange?(callback: (hex: string) => void): void;
	setBackgroundColor?(hex: string): void;
	resetBackgroundColor?(): void;
	onPrivateModeReport?(callback: (mode: number, supported: boolean) => void): void;
	requestEnhancedPaste?(): void;
}

export function isConPTYHosted(): boolean {
	if (process.platform === "win32") return true;
	return process.platform === "linux" && (!!$env.WSL_DISTRO_NAME || !!$env.WSL_INTEROP);
}

type Da1SentinelOwner =
	| { kind: "keyboard" }
	| { kind: "osc11" }
	| { kind: "privateMode"; mode: number }
	| { kind: "osc99Probe"; id: string };

let nextOsc99ProbeId = 1;

function parseOsc99KeyValues(section: string): Map<string, string> {
	const values = new Map<string, string>();
	for (const part of section.split(":")) {
		const eq = part.indexOf("=");
		if (eq !== 1) continue;
		values.set(part.slice(0, eq), part.slice(eq + 1));
	}
	return values;
}
const XTERM_SCROLL_TO_BOTTOM_MODES = [1010, 1011] as const;

export const STARTUP_PRIVATE_MODE_PROBES: readonly number[] = [
	2026,
	2048,
	2031,
	ENHANCED_PASTE_MODE,
	...XTERM_SCROLL_TO_BOTTOM_MODES,
];

function isXtermScrollToBottomMode(mode: number): boolean {
	return mode === 1010 || mode === 1011;
}

function isPrivateModeSet(status: string): boolean {
	return status === "1" || status === "3";
}

function isPrivateModeSupported(status: string): boolean {
	return status !== "0" && status !== "4";
}

export class ProcessTerminal implements Terminal {
	#wasRaw = false;
	#inputHandler?: (data: string) => void;
	#resizeHandler?: () => void;
	#stdoutResizeListener?: () => void;
	#kittyProtocolActive = false;
	#kittyEnableSeq: string | null = null;
	#modifyOtherKeysActive = false;
	#modifyOtherKeysTimeout?: Timer;
	#stdinBuffer?: StdinBuffer;
	#stdinDataHandler?: (data: string) => void;
	#dead = false;
	#consecutiveWriteFailures = 0;
	#headless = isTerminalHeadless();
	#writeLogPath = $env.VEYYON_TUI_WRITE_LOG || "";
	#stdoutErrorCleanup?: () => void;
	#stdoutErrorHandler = (err: Error) => {
		this.#markTerminalWriteFailed(err);
	};

	#windowsVTInputRestore?: () => void;
	#xtermScrollToBottomRestoreModes = new Set<number>();
	#appearanceCallbacks: Array<(appearance: TerminalAppearance) => void> = [];
	#appearance: TerminalAppearance | undefined;
	#backgroundColorCallbacks: Array<(hex: string) => void> = [];
	#backgroundColorHex: string | undefined;
	#backgroundOverridden = false;
	#backgroundOverrideHex: string | undefined;
	#osc11Pending = false;
	#osc11QueryQueued = false;
	#osc11ResponseBuffer = "";
	#osc99PendingId: string | undefined;
	#osc99ResponseBuffer = "";
	#osc99Capabilities = new Map<string, string>();
	#privateCsiResponseBuffer = "";
	#da1SentinelOwners: Da1SentinelOwner[] = [];
	#privateModeSupport = new Map<number, boolean>();
	#privateModeCallbacks: Array<(mode: number, supported: boolean) => void> = [];
	#inBandResizeActive = false;
	#enhancedPasteRequested = false;
	#enhancedPasteArmed = false;
	#inBandResizeBuffer = "";
	#reportedColumns?: number;
	#reportedRows?: number;
	#mode2031DebounceTimer?: Timer;
	#windowsTerminalAppearancePollTimer?: Timer;
	#progressTimer?: Timer;

	get kittyProtocolActive(): boolean {
		return this.#kittyProtocolActive;
	}

	get kittyEnableSequence(): string | null {
		return this.#kittyProtocolActive ? this.#kittyEnableSeq : null;
	}

	get keyboardEnhancementEnterSequence(): string | null {
		if (this.#kittyProtocolActive) return this.#kittyEnableSeq;
		return this.#modifyOtherKeysActive ? "\x1b[>4;2m" : null;
	}

	get keyboardEnhancementExitSequence(): string | null {
		return this.#kittyProtocolActive ? "\x1b[<u" : null;
	}

	get appearance(): TerminalAppearance | undefined {
		return this.#appearance;
	}

	get backgroundColor(): string | undefined {
		return this.#backgroundColorHex;
	}

	onBackgroundColorChange(callback: (hex: string) => void): void {
		this.#backgroundColorCallbacks.push(callback);
		if (this.#backgroundColorHex) {
			try {
				callback(this.#backgroundColorHex);
			} catch (error) {
				logger.error("background-color subscriber threw during replay", {
					error: errorMessage(error),
				});
			}
		}
	}

	setBackgroundColor(hex: string): void {
		const sequence = osc11SetBackgroundSequence(hex);
		if (sequence === null) {
			throw new Error(`setBackgroundColor requires a #RRGGBB color, got ${JSON.stringify(hex)}`);
		}
		this.#safeWrite(sequence);
		this.#backgroundOverridden = true;
		this.#backgroundOverrideHex = hex.toLowerCase();
		osc11BackgroundOverridden = true;
	}

	resetBackgroundColor(): void {
		if (!this.#backgroundOverridden) return;
		this.#safeWrite(OSC11_RESET_BACKGROUND_SEQUENCE);
		this.#backgroundOverridden = false;
		this.#backgroundOverrideHex = undefined;
		osc11BackgroundOverridden = false;
	}

	onAppearanceChange(callback: (appearance: TerminalAppearance) => void): void {
		this.#appearanceCallbacks.push(callback);
		if (this.#appearance) {
			try {
				callback(this.#appearance);
			} catch (error) {
				logger.error("appearance-change subscriber threw during replay", {
					error: errorMessage(error),
				});
			}
		}
	}

	onPrivateModeReport(callback: (mode: number, supported: boolean) => void): void {
		this.#privateModeCallbacks.push(callback);
	}

	start(onInput: (data: string) => void, onResize: () => void): void {
		this.#inputHandler = onInput;
		this.#resizeHandler = onResize;

		this.#headless = isTerminalHeadless();
		if (this.#headless) return;
		registerPostmortemTerminalRestore();

		activeTerminal = this;
		terminalEverStarted = true;

		suppressTerminalStderr();

		this.#wasRaw = process.stdin.isRaw || false;
		if (process.stdin.setRawMode) {
			process.stdin.setRawMode(true);
		}
		process.stdin.setEncoding("utf8");
		process.stdin.resume();

		this.#safeWrite("\x1b[?2004h");

		this.#safeWrite(FOCUS_REPORTING_ENABLE);
		setWindowFocusState("unknown");

		this.#stdoutResizeListener = () => {
			this.#reconcileInBandGeometryOnResize();
			this.#resizeHandler?.();
		};
		process.stdout.on("resize", this.#stdoutResizeListener);

		if (process.platform !== "win32") {
			process.kill(process.pid, "SIGWINCH");
		}

		this.#enableWindowsVTInput();
		this.#queryAndEnableKittyProtocol();
		setHangulCompatibilityJamoWidth(resolveHangulCompatibilityJamoWidthFromTerminalIdentity());

		this.#queryBackgroundColor();

		this.#queryOsc99Support();

		this.#safeWrite("\x1b[?2031h");

		for (const mode of STARTUP_PRIVATE_MODE_PROBES) {
			this.#queryPrivateMode(mode);
		}
	}

	#enableWindowsVTInput(): void {
		if (process.platform !== "win32") return;
		this.#restoreWindowsVTInput();
		try {
			const kernel32 = dlopen("kernel32.dll", {
				GetStdHandle: { args: [FFIType.i32], returns: FFIType.ptr },
				GetConsoleMode: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.bool },
				SetConsoleMode: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.bool },
			});
			const handle = kernel32.symbols.GetStdHandle(STD_INPUT_HANDLE);
			const mode = new Uint32Array(1);
			const modePtr = ptr(mode);
			if (!modePtr || !kernel32.symbols.GetConsoleMode(handle, modePtr)) {
				kernel32.close();
				return;
			}
			const originalMode = mode[0]!;
			const vtMode = originalMode | ENABLE_VIRTUAL_TERMINAL_INPUT;
			if (vtMode !== originalMode && !kernel32.symbols.SetConsoleMode(handle, vtMode)) {
				kernel32.close();
				return;
			}
			this.#windowsVTInputRestore = () => {
				try {
					kernel32.symbols.SetConsoleMode(handle, originalMode);
				} finally {
					kernel32.close();
				}
			};
		} catch {}
	}

	#restoreWindowsVTInput(): void {
		if (process.platform !== "win32") return;
		const restore = this.#windowsVTInputRestore;
		this.#windowsVTInputRestore = undefined;
		if (!restore) return;
		try {
			restore();
		} catch {}
	}

	#setupStdinBuffer(): void {
		this.#stdinBuffer = new StdinBuffer({ timeout: 50 });

		const kittyResponsePattern = /^\x1b\[\?(\d+)u$/;

		const appearanceDsrPattern = /^\x1b\[\?997;([12])n$/;

		const osc11ResponsePattern =
			/^\x1b\]11;rgba?:([0-9a-fA-F]{1,4})\/([0-9a-fA-F]{1,4})\/([0-9a-fA-F]{1,4})(?:\x07|\x1b\\)$/;

		const da1ResponsePattern = /^\x1b\[\?[\d;]*c$/;

		const privateCsiPartialPattern = /^\x1b\[\?[\d;]*[\x20-\x2f]*$/;

		const decrpmResponsePattern = /^\x1b\[\?(\d+);(\d+)\$y$/;

		const inBandResizePattern = /^\x1b\[48;(\d+)(?::[\d:]*)?;(\d+)(?::[\d:]*)?;(\d+)(?::[\d:]*)?;(\d+)(?::[\d:]*)?t$/;

		this.#stdinBuffer.on("data", (sequence: string) => {
			if (
				(sequence.length === 0 || sequence.charCodeAt(0) !== 0x1b) &&
				this.#privateCsiResponseBuffer.length === 0 &&
				this.#inBandResizeBuffer.length === 0 &&
				this.#osc11ResponseBuffer.length === 0 &&
				this.#osc99ResponseBuffer.length === 0
			) {
				if (this.#inputHandler) {
					this.#inputHandler(sequence);
				}
				return;
			}

			if (
				this.#privateCsiResponseBuffer ||
				(privateCsiPartialPattern.test(sequence) && this.#da1SentinelOwners.length > 0)
			) {
				if (this.#privateCsiResponseBuffer && sequence.startsWith("\x1b")) {
					this.#privateCsiResponseBuffer = "";
				} else {
					this.#privateCsiResponseBuffer += sequence;
					if (this.#privateCsiResponseBuffer.length > 256) {
						this.#privateCsiResponseBuffer = "";
						return;
					}
					const lastChar = this.#privateCsiResponseBuffer.at(-1)!;
					const lastCode = lastChar.charCodeAt(0);
					if (lastCode >= 0x40 && lastCode <= 0x7e) {
						sequence = this.#privateCsiResponseBuffer;
						this.#privateCsiResponseBuffer = "";
					} else if (!privateCsiPartialPattern.test(this.#privateCsiResponseBuffer)) {
						this.#privateCsiResponseBuffer = "";
						return;
					} else {
						return;
					}
				}
			}

			const inBandResizePartialPattern = /^\x1b\[4[\d;:]*$/;
			const isInBandResizePartial = this.#inBandResizeActive && inBandResizePartialPattern.test(sequence);
			if (this.#inBandResizeBuffer && sequence.startsWith("\x1b")) {
				this.#inBandResizeBuffer = isInBandResizePartial ? sequence : "";
				if (isInBandResizePartial) return;
			} else if (this.#inBandResizeBuffer || isInBandResizePartial) {
				this.#inBandResizeBuffer += sequence;
				if (this.#inBandResizeBuffer.length > 256) {
					this.#inBandResizeBuffer = "";
					return;
				}
				const lastCode = this.#inBandResizeBuffer.charCodeAt(this.#inBandResizeBuffer.length - 1);
				if (lastCode >= 0x40 && lastCode <= 0x7e) {
					sequence = this.#inBandResizeBuffer;
					this.#inBandResizeBuffer = "";
				} else if (!inBandResizePartialPattern.test(this.#inBandResizeBuffer)) {
					this.#inBandResizeBuffer = "";
					return;
				} else {
					return;
				}
			}

			const resizeMatch = sequence.match(inBandResizePattern);
			if (resizeMatch) {
				this.#handleInBandResizeReport(resizeMatch[1]!, resizeMatch[2]!, resizeMatch[3]!, resizeMatch[4]!);
				return;
			}

			const decrpmMatch = sequence.match(decrpmResponsePattern);
			if (decrpmMatch) {
				this.#handlePrivateModeReport(parseInt(decrpmMatch[1]!, 10), decrpmMatch[2]!);
				return;
			}

			if (da1ResponsePattern.test(sequence) && this.#da1SentinelOwners.length > 0) {
				const owner = this.#da1SentinelOwners.shift()!;
				switch (owner.kind) {
					case "osc11": {
						if (this.#osc11Pending) {
							this.#osc11Pending = false;
							this.#osc11ResponseBuffer = "";
						}
						if (
							this.#osc11QueryQueued &&
							!this.#osc11Pending &&
							!this.#da1SentinelOwners.some(o => o.kind === "osc11") &&
							!this.#dead
						) {
							this.#osc11QueryQueued = false;
							this.#startOsc11Query();
						}
						break;
					}
					case "privateMode": {
						this.#resolvePrivateMode(owner.mode, false);
						break;
					}
					case "keyboard": {
						if (this.#modifyOtherKeysTimeout) {
							clearTimeout(this.#modifyOtherKeysTimeout);
							this.#modifyOtherKeysTimeout = undefined;
						}
						this.#enableModifyOtherKeysFallback();
						break;
					}
					case "osc99Probe": {
						this.#resolveOsc99Support(owner.id, false);
						break;
					}
				}
				return;
			}

			const match = sequence.match(kittyResponsePattern);
			if (match) {
				if (this.#modifyOtherKeysTimeout) {
					clearTimeout(this.#modifyOtherKeysTimeout);
					this.#modifyOtherKeysTimeout = undefined;
				}
				if (this.#modifyOtherKeysActive) {
					this.#safeWrite("\x1b[>4;0m");
					this.#modifyOtherKeysActive = false;
				}
				const reportedFlags = parseInt(match[1]!, 10);
				this.#kittyProtocolActive = true;
				setKittyProtocolActive(true);
				if (reportedFlags >= 3) {
					this.#kittyEnableSeq = "\x1b[>7u";
					this.#safeWrite(this.#kittyEnableSeq);
				} else {
					this.#kittyEnableSeq = "\x1b[>1u";
					this.#safeWrite(this.#kittyEnableSeq);
				}
				return;
			}

			if (this.#osc11Pending && (this.#osc11ResponseBuffer || sequence.startsWith("\x1b]11;"))) {
				if (this.#osc11ResponseBuffer && sequence.startsWith("\x1b") && sequence !== "\x1b\\") {
					this.#osc11ResponseBuffer = "";
				} else {
					this.#osc11ResponseBuffer += sequence;
					const osc11Match = this.#osc11ResponseBuffer.match(osc11ResponsePattern);
					if (!osc11Match) return;
					const [, rHex, gHex, bHex] = osc11Match;
					this.#osc11Pending = false;
					this.#osc11ResponseBuffer = "";
					this.#handleOsc11Response(rHex!, gHex!, bHex!);
					return;
				}
			}

			if (this.#osc99PendingId && (this.#osc99ResponseBuffer || sequence.startsWith("\x1b]99;"))) {
				if (this.#osc99ResponseBuffer && sequence.startsWith("\x1b") && sequence !== "\x1b\\") {
					this.#osc99ResponseBuffer = "";
				} else {
					this.#osc99ResponseBuffer += sequence;
					const osc99Match = this.#osc99ResponseBuffer.match(/^\x1b\]99;([^;]*);([\s\S]*?)(?:\x07|\x1b\\)$/u);
					if (!osc99Match) return;
					const [, meta, payload] = osc99Match;
					this.#osc99ResponseBuffer = "";
					this.#handleOsc99CapabilityResponse(meta!, payload!);
					return;
				}
			}

			if (consumeWindowFocusEvent(sequence)) return;

			const appearanceMatch = sequence.match(appearanceDsrPattern);
			if (appearanceMatch) {
				if (this.#mode2031DebounceTimer) clearTimeout(this.#mode2031DebounceTimer);
				this.#mode2031DebounceTimer = setTimeout(() => {
					this.#mode2031DebounceTimer = undefined;
					this.#queryBackgroundColor();
				}, 100);
				return;
			}
			if (this.#inputHandler) {
				this.#inputHandler(sequence);
			}
		});

		this.#stdinBuffer.on("paste", (content: string) => {
			if (this.#inputHandler) {
				this.#inputHandler(`\x1b[200~${content}\x1b[201~`);
			}
		});

		this.#stdinDataHandler = (data: string) => {
			this.#stdinBuffer!.process(data);
		};
	}

	#queryBackgroundColor(): void {
		if (this.#dead) return;
		if (this.#osc11Pending || this.#da1SentinelOwners.some(o => o.kind === "osc11")) {
			this.#osc11QueryQueued = true;
			return;
		}
		this.#startOsc11Query();
	}

	#startOsc11Query(): void {
		this.#osc11Pending = true;
		this.#osc11ResponseBuffer = "";
		this.#da1SentinelOwners.push({ kind: "osc11" });
		this.#safeWrite("\x1b]11;?\x07"); // OSC 11 query (BEL terminated)
		this.#safeWrite("\x1b[c"); // DA1 sentinel
	}

	#shouldQueryOsc99Support(): boolean {
		if (TERMINAL.notifyProtocol !== NotifyProtocol.Osc99) return false;
		return !isBunTestRuntime() || $env.VEYYON_TUI_OSC99_PROBE === "1";
	}

	#queryOsc99Support(): void {
		setOsc99Supported(false);
		this.#osc99Capabilities.clear();
		this.#osc99PendingId = undefined;
		this.#osc99ResponseBuffer = "";
		if (this.#dead || !this.#shouldQueryOsc99Support()) return;

		const id = `veyyon-probe-${nextOsc99ProbeId++}`;
		this.#osc99PendingId = id;
		this.#da1SentinelOwners.push({ kind: "osc99Probe", id });
		const probe = `\x1b]99;i=${id}:p=?;\x1b\\`;
		const sequence = isInsideTmux() ? wrapTmuxPassthrough(probe) : probe;
		this.#safeWrite(`${sequence}\x1b[c`);
	}

	#handleOsc99CapabilityResponse(metaRaw: string, payload: string): boolean {
		const pendingId = this.#osc99PendingId;
		if (!pendingId) return false;
		const meta = parseOsc99KeyValues(metaRaw);
		if (meta.get("i") !== pendingId || meta.get("p") !== "?") return false;

		const capabilities = parseOsc99KeyValues(payload);
		this.#osc99Capabilities = capabilities;
		const payloadTypes = capabilities.get("p")?.split(",") ?? [];
		this.#resolveOsc99Support(pendingId, payloadTypes.includes("title"));
		return true;
	}

	#resolveOsc99Support(id: string, supported: boolean): void {
		if (this.#osc99PendingId !== id) return;
		this.#osc99PendingId = undefined;
		this.#osc99ResponseBuffer = "";
		if (!supported) this.#osc99Capabilities.clear();
		setOsc99Supported(supported);
	}

	#handleOsc11Response(rHex: string, gHex: string, bHex: string): void {
		const r = oscChannelTo8Bit(rHex);
		const g = oscChannelTo8Bit(gHex);
		const b = oscChannelTo8Bit(bHex);
		const hex = `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
		if (this.#backgroundOverridden && hex === this.#backgroundOverrideHex) return;
		if (hex !== this.#backgroundColorHex) {
			this.#backgroundColorHex = hex;
			for (const cb of this.#backgroundColorCallbacks) {
				try {
					cb(hex);
				} catch {}
			}
		}
		const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
		const mode: TerminalAppearance = luminance < 0.5 ? "dark" : "light";
		if (mode === this.#appearance) return;
		this.#appearance = mode;
		for (const cb of this.#appearanceCallbacks) {
			try {
				cb(mode);
			} catch {}
		}
	}

	#enableModifyOtherKeysFallback(): void {
		if (this.#kittyProtocolActive || this.#modifyOtherKeysActive) return;
		if (!shouldEnableModifyOtherKeysFallback()) return;
		this.#safeWrite("\x1b[>4;2m");
		this.#modifyOtherKeysActive = true;
	}

	#queryAndEnableKittyProtocol(): void {
		this.#setupStdinBuffer();
		process.stdin.on("data", this.#stdinDataHandler!);
		this.#da1SentinelOwners.push({ kind: "keyboard" });
		this.#safeWrite("\x1b[?u\x1b[c");
		this.#modifyOtherKeysTimeout = setTimeout(() => {
			this.#modifyOtherKeysTimeout = undefined;
			this.#enableModifyOtherKeysFallback();
		}, 150);
	}

	#queryPrivateMode(mode: number): void {
		if (this.#dead) return;
		if (this.#privateModeSupport.has(mode)) return;
		this.#da1SentinelOwners.push({ kind: "privateMode", mode });
		this.#safeWrite(`\x1b[?${mode}$p\x1b[c`);
	}

	#handlePrivateModeReport(mode: number, status: string): void {
		this.#resolvePrivateMode(mode, isPrivateModeSupported(status));
		if (isXtermScrollToBottomMode(mode) && isPrivateModeSet(status)) {
			this.#disableXtermScrollToBottomMode(mode);
		}
	}

	#resolvePrivateMode(mode: number, supported: boolean): void {
		if (this.#privateModeSupport.has(mode)) return;
		this.#privateModeSupport.set(mode, supported);
		for (const cb of this.#privateModeCallbacks) {
			try {
				cb(mode, supported);
			} catch (error) {
				logger.error("private-mode capability subscriber threw", {
					mode,
					supported,
					error: errorMessage(error),
				});
			}
		}
		if (mode === 2048 && supported) this.#enableInBandResize();
		if (mode === 2031) this.#syncWindowsTerminalAppearancePolling(supported);
		if (mode === ENHANCED_PASTE_MODE) this.#armEnhancedPaste();
	}

	requestEnhancedPaste(): void {
		this.#enhancedPasteRequested = true;
		this.#armEnhancedPaste();
	}

	#armEnhancedPaste(): void {
		if (this.#enhancedPasteArmed || !this.#enhancedPasteRequested || this.#dead) return;
		if (this.#privateModeSupport.get(ENHANCED_PASTE_MODE) !== true) return;
		this.#enhancedPasteArmed = true;
		enhancedPasteArmed = true;
		this.#safeWrite(`\x1b[?${ENHANCED_PASTE_MODE}h`);
	}

	#syncWindowsTerminalAppearancePolling(mode2031Supported: boolean): void {
		if (mode2031Supported || !shouldPollWindowsTerminalAppearance() || this.#dead) {
			this.#clearWindowsTerminalAppearancePoll();
			return;
		}
		if (this.#windowsTerminalAppearancePollTimer) return;
		this.#windowsTerminalAppearancePollTimer = setInterval(() => {
			this.#queryBackgroundColor();
		}, WINDOWS_TERMINAL_OSC11_POLL_MS);
	}

	#clearWindowsTerminalAppearancePoll(): void {
		if (!this.#windowsTerminalAppearancePollTimer) return;
		clearInterval(this.#windowsTerminalAppearancePollTimer);
		this.#windowsTerminalAppearancePollTimer = undefined;
	}
	#disableXtermScrollToBottomMode(mode: number): void {
		if (this.#xtermScrollToBottomRestoreModes.has(mode) || this.#dead) return;
		this.#xtermScrollToBottomRestoreModes.add(mode);
		this.#safeWrite(`\x1b[?${mode}l`);
	}

	#enableInBandResize(): void {
		if (this.#inBandResizeActive || this.#dead) return;
		this.#inBandResizeActive = true;
		this.#safeWrite("\x1b[?2048h");
	}

	#handleInBandResizeReport(rowsRaw: string, colsRaw: string, yPixelsRaw: string, xPixelsRaw: string): void {
		const previousRows = this.rows;
		const previousColumns = this.columns;
		const rows = parseInt(rowsRaw, 10);
		const cols = parseInt(colsRaw, 10);
		const yPixels = parseInt(yPixelsRaw, 10);
		const xPixels = parseInt(xPixelsRaw, 10);
		if (rows > 0) this.#reportedRows = rows;
		if (cols > 0) this.#reportedColumns = cols;
		if (cols > 0 && xPixels > 0 && rows > 0 && yPixels > 0) {
			setCellDimensions({
				widthPx: Math.max(1, Math.round(xPixels / cols)),
				heightPx: Math.max(1, Math.round(yPixels / rows)),
			});
		}
		if (rows > 0 && cols > 0 && (rows !== previousRows || cols !== previousColumns)) {
			this.#resizeHandler?.();
		}
	}

	#reconcileInBandGeometryOnResize(): void {
		if (!this.#inBandResizeActive) return;
		const osColumns = process.stdout.columns;
		const osRows = process.stdout.rows;
		if (this.#reportedColumns !== undefined && osColumns > 0 && this.#reportedColumns !== osColumns) {
			this.#reportedColumns = undefined;
		}
		if (this.#reportedRows !== undefined && osRows > 0 && this.#reportedRows !== osRows) {
			this.#reportedRows = undefined;
		}
	}

	async drainInput(maxMs = 1000, idleMs = 50): Promise<void> {
		if (this.#headless) return;
		if (this.#kittyProtocolActive) {
			this.#safeWrite("\x1b[<u");
			this.#kittyProtocolActive = false;
			setKittyProtocolActive(false);
		}
		if (this.#modifyOtherKeysTimeout) {
			clearTimeout(this.#modifyOtherKeysTimeout);
			this.#modifyOtherKeysTimeout = undefined;
		}
		if (this.#modifyOtherKeysActive) {
			this.#safeWrite("\x1b[>4;0m");
			this.#modifyOtherKeysActive = false;
		}

		const previousHandler = this.#inputHandler;
		this.#inputHandler = undefined;

		let lastDataTime = Date.now();
		const onData = () => {
			lastDataTime = Date.now();
		};

		process.stdin.on("data", onData);
		const endTime = Date.now() + maxMs;

		try {
			while (true) {
				const now = Date.now();
				const timeLeft = endTime - now;
				if (timeLeft <= 0) break;
				if (now - lastDataTime >= idleMs) break;
				await Bun.sleep(Math.min(idleMs, timeLeft));
			}
		} finally {
			process.stdin.removeListener("data", onData);
			this.#inputHandler = previousHandler;
		}
	}

	stop(): void {
		if (this.#headless) return;
		if (activeTerminal === this) {
			activeTerminal = null;
		}

		restoreTerminalStderr();

		if (this.#clearProgressTimer()) {
			this.#safeWrite(TERMINAL_PROGRESS_CLEAR_SEQUENCE);
		}

		this.#safeWrite("\x1b[?2026l\x1b[?7h");

		this.#safeWrite("\x1b[?2004l");
		if (this.#enhancedPasteArmed) this.#safeWrite("\x1b[?5522l");

		this.#safeWrite(FOCUS_REPORTING_DISABLE);
		setWindowFocusState("unknown");

		this.#safeWrite("\x1b[?1006l\x1b[?1003l\x1b[?1000l");

		this.#safeWrite("\x1b[?2031l");

		this.resetBackgroundColor();

		for (const mode of this.#xtermScrollToBottomRestoreModes) {
			this.#safeWrite(`\x1b[?${mode}h`);
		}
		this.#xtermScrollToBottomRestoreModes.clear();

		if (this.#inBandResizeActive) {
			this.#safeWrite("\x1b[?2048l");
			this.#inBandResizeActive = false;
		}
		if (this.#mode2031DebounceTimer) {
			clearTimeout(this.#mode2031DebounceTimer);
			this.#mode2031DebounceTimer = undefined;
		}
		this.#appearanceCallbacks = [];
		this.#osc11Pending = false;
		this.#clearWindowsTerminalAppearancePoll();
		this.#osc11QueryQueued = false;
		this.#osc11ResponseBuffer = "";
		this.#osc99PendingId = undefined;
		this.#osc99ResponseBuffer = "";
		this.#osc99Capabilities.clear();
		setOsc99Supported(false);
		this.#privateCsiResponseBuffer = "";
		this.#inBandResizeBuffer = "";
		this.#da1SentinelOwners.length = 0;
		this.#privateModeCallbacks = [];
		this.#privateModeSupport.clear();
		this.#xtermScrollToBottomRestoreModes.clear();
		this.#reportedColumns = undefined;
		this.#reportedRows = undefined;

		if (this.#kittyProtocolActive) {
			this.#safeWrite("\x1b[<u");
			this.#kittyProtocolActive = false;
			setKittyProtocolActive(false);
		}
		if (this.#modifyOtherKeysTimeout) {
			clearTimeout(this.#modifyOtherKeysTimeout);
			this.#modifyOtherKeysTimeout = undefined;
		}
		if (this.#modifyOtherKeysActive) {
			this.#safeWrite("\x1b[>4;0m");
			this.#modifyOtherKeysActive = false;
		}

		this.#restoreWindowsVTInput();
		if (this.#stdinBuffer) {
			this.#stdinBuffer.destroy();
			this.#stdinBuffer = undefined;
		}

		if (this.#stdinDataHandler) {
			process.stdin.removeListener("data", this.#stdinDataHandler);
			this.#stdinDataHandler = undefined;
		}
		this.#inputHandler = undefined;
		this.#appearance = undefined;
		if (this.#stdoutResizeListener) {
			process.stdout.removeListener("resize", this.#stdoutResizeListener);
			this.#stdoutResizeListener = undefined;
		}
		this.#resizeHandler = undefined;

		process.stdin.pause();

		if (process.stdin.setRawMode) {
			process.stdin.setRawMode(this.#wasRaw);
		}
		this.#stdoutErrorCleanup?.();
		this.#stdoutErrorCleanup = undefined;
	}

	#ensureStdoutErrorHandler(): void {
		this.#stdoutErrorCleanup ??= registerStdoutErrorHandler(this.#stdoutErrorHandler);
	}

	#markTerminalWriteFailed(err: unknown): void {
		if (this.#dead) return;
		this.#consecutiveWriteFailures++;
		const decision = decideTerminalWriteFailure(err, this.#consecutiveWriteFailures);
		if (decision === "retry") {
			logger.debug("terminal write failed transiently; retrying on next paint", {
				code: terminalWriteErrorCode(err),
				failures: this.#consecutiveWriteFailures,
			});
			return;
		}
		this.#dead = true;
		logger.warn(
			decision === "disable-fatal"
				? "terminal closed (fatal write error); disabling rendering"
				: "terminal rendering disabled after repeated write failures",
			{ code: terminalWriteErrorCode(err), failures: this.#consecutiveWriteFailures, err },
		);
	}

	write(data: string): void {
		this.#safeWrite(data);
		if (this.#writeLogPath) {
			try {
				fs.appendFileSync(this.#writeLogPath, data, { encoding: "utf8" });
			} catch {}
		}
	}

	#safeWrite(data: string): void {
		if (this.#headless) return;
		if (this.#dead) return;
		if (!process.stdout.isTTY) return;
		this.#ensureStdoutErrorHandler();
		if (process.platform === "win32") ensureWindowsConsoleUtf8();
		try {
			if (isConPTYHosted() && Buffer.byteLength(data, "utf8") > MAX_CONPTY_WRITE_CHUNK_BYTES) {
				for (const chunk of chunkForConPTY(data, MAX_CONPTY_WRITE_CHUNK_BYTES)) {
					if (this.#dead) break;
					process.stdout.write(chunk);
				}
			} else {
				process.stdout.write(data);
			}
			if (this.#consecutiveWriteFailures !== 0) this.#consecutiveWriteFailures = 0;
		} catch (err) {
			this.#markTerminalWriteFailed(err);
		}
	}

	get columns(): number {
		if (this.#inBandResizeActive && this.#reportedColumns) return this.#reportedColumns;
		return process.stdout.columns || Number(Bun.env.COLUMNS) || 80;
	}

	get rows(): number {
		if (this.#inBandResizeActive && this.#reportedRows) return this.#reportedRows;
		return process.stdout.rows || Number(Bun.env.LINES) || 24;
	}

	moveBy(lines: number): void {
		if (lines > 0) {
			this.#safeWrite(`\x1b[${lines}B`);
		} else if (lines < 0) {
			this.#safeWrite(`\x1b[${-lines}A`);
		}
	}

	hideCursor(): void {
		this.#safeWrite("\x1b[?25l");
	}

	showCursor(): void {
		this.#safeWrite("\x1b[?25h");
	}

	clearLine(): void {
		this.#safeWrite("\x1b[K");
	}

	clearFromCursor(): void {
		this.#safeWrite("\x1b[J");
	}

	clearScreen(): void {
		this.#safeWrite("\x1b[H\x1b[0J"); // Move to home (1,1) and clear from cursor to end
	}

	setTitle(title: string): void {
		this.#safeWrite(`\x1b]0;${title}\x07`);
	}

	setProgress(active: boolean): void {
		if (this.#headless) return;
		if (active) {
			this.#safeWrite(TERMINAL_PROGRESS_ACTIVE_SEQUENCE);
			if (!this.#progressTimer) {
				this.#progressTimer = setInterval(() => {
					this.#safeWrite(TERMINAL_PROGRESS_ACTIVE_SEQUENCE);
				}, TERMINAL_PROGRESS_KEEPALIVE_MS);
				this.#progressTimer.unref?.();
			}
		} else {
			this.#clearProgressTimer();
			this.#safeWrite(TERMINAL_PROGRESS_CLEAR_SEQUENCE);
		}
	}

	#clearProgressTimer(): boolean {
		if (!this.#progressTimer) return false;
		clearInterval(this.#progressTimer);
		this.#progressTimer = undefined;
		return true;
	}
}
