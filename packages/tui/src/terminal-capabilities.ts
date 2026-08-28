import { encodeSixel } from "@veyyon/natives";
import { APP_DISPLAY_NAME } from "@veyyon/utils/app-identity";
import { $env, isBunTestRuntime, isTerminalHeadless } from "@veyyon/utils/env";
import { sendDesktopNotification, shouldDeliverDesktopNotification } from "./desktop-notify";
import {
	detectKittyUnicodePlaceholdersSupport,
	getKittyGraphics,
	KITTY_PLACEHOLDER,
	kittyPlaceholdersFit,
	renderKittyPlaceholderLines,
	setKittyGraphics,
} from "./kitty-graphics";
import { isInsideTmux, wrapTmuxPassthrough, wrapTmuxPassthroughIfNeeded } from "./tmux";
import { isWindowFocused } from "./window-focus";

export { isInsideTmux, wrapTmuxPassthrough } from "./tmux";

export enum ImageProtocol {
	Kitty = "\x1b_G",
	Iterm2 = "\x1b]1337;File=",
	Sixel = "\x1bPq",
}

export enum NotifyProtocol {
	Bell = "\x07",
	Osc99 = "\x1b]99;;",
	Osc9 = "\x1b]9;",
}

export type TerminalId =
	| "kitty"
	| "ghostty"
	| "wezterm"
	| "iterm2"
	| "vscode"
	| "alacritty"
	| "warp"
	| "base"
	| "trueColor";

function hasNeedleBefore(line: string, needle: string, limit: number): boolean {
	const index = line.indexOf(needle);
	return index !== -1 && index + needle.length <= limit;
}

function hasSixelDcsStart(line: string): boolean {
	const limit = Math.min(line.length, 128);
	let from = 0;
	for (;;) {
		const start = line.indexOf("\x1bP", from);
		if (start === -1 || start + 3 > limit) return false;
		let i = start + 2;
		while (i < limit) {
			const code = line.charCodeAt(i);
			if ((code >= 0x30 && code <= 0x39) || code === 0x3b) {
				i++;
				continue;
			}
			break;
		}
		if (i < limit && line.charCodeAt(i) === 0x71) return true;
		from = start + 2;
	}
}

export class TerminalInfo {
	constructor(
		public readonly id: TerminalId,
		public readonly imageProtocol: ImageProtocol | null,
		public readonly trueColor: boolean,
		public readonly hyperlinks: boolean,
		public readonly notifyProtocol: NotifyProtocol = NotifyProtocol.Bell,
		public readonly deccara: boolean = false,
		readonly supportsScreenToScrollback: boolean = false,
		public readonly textSizing: boolean = false,
	) {}

	clone(): RuntimeTerminal {
		return Object.assign(Object.create(TerminalInfo.prototype), this) as RuntimeTerminal;
	}

	isImageLine(line: string): boolean {
		if (!this.imageProtocol) return false;
		if (this.imageProtocol === ImageProtocol.Sixel) {
			return hasSixelDcsStart(line);
		}
		return hasNeedleBefore(line, this.imageProtocol, 64) || hasNeedleBefore(line, KITTY_PLACEHOLDER, 64);
	}

	formatNotification(message: string | TerminalNotification): string {
		if (this.notifyProtocol === NotifyProtocol.Bell) {
			return NotifyProtocol.Bell;
		}
		if (typeof message !== "string") {
			if (this.notifyProtocol === NotifyProtocol.Osc99 && osc99CapabilitiesConfirmed) {
				return formatOsc99Notification(message);
			}
			return `${this.notifyProtocol}${notificationToLine(message)}\x1b\\`;
		}
		return `${this.notifyProtocol}${message}\x1b\\`;
	}

	sendNotification(message: string | TerminalNotification): void {
		if (isNotificationSuppressed() || isTerminalHeadless()) return;
		if (isWindowFocused() && !(typeof message === "object" && message.deliverWhenFocused === true)) return;
		const formatted = this.formatNotification(message);
		if (this.notifyProtocol !== NotifyProtocol.Bell && isInsideTmux()) {
			process.stdout.write(`${wrapTmuxPassthrough(formatted)}\x07`);
			return;
		}
		if (this.notifyProtocol !== NotifyProtocol.Bell && isInsideZellij()) {
			process.stdout.write(`${formatted}\x07`);
			return;
		}
		process.stdout.write(formatted);
		if (this.notifyProtocol === NotifyProtocol.Bell && shouldDeliverDesktopNotification(this.id, true)) {
			sendDesktopNotification(message);
		}
	}
}

export function isInsideTerminalMultiplexer(env: NodeJS.ProcessEnv = Bun.env): boolean {
	if (env.TMUX || env.STY || env.ZELLIJ) return true;
	if (env.CMUX_WORKSPACE_ID || env.CMUX_SURFACE_ID) return true;
	const term = env.TERM?.toLowerCase() ?? "";
	return term.startsWith("tmux") || term.startsWith("screen");
}

export function isInsideZellij(env: NodeJS.ProcessEnv = Bun.env): boolean {
	return Boolean(env.ZELLIJ);
}

export function isNotificationSuppressed(): boolean {
	const value = $env.VEYYON_NOTIFICATIONS;
	if (!value) return false;
	return value === "off" || value === "0" || value === "false";
}

function getForcedImageProtocol(): ImageProtocol | null | undefined {
	const raw = $env.VEYYON_FORCE_IMAGE_PROTOCOL?.trim().toLowerCase();
	if (!raw) return undefined;
	if (raw === "kitty") return ImageProtocol.Kitty;
	if (raw === "iterm2" || raw === "iterm") return ImageProtocol.Iterm2;
	if (raw === "sixel") return ImageProtocol.Sixel;
	if (raw === "off" || raw === "none" || raw === "0" || raw === "false") return null;
	return null;
}

function parseMajorMinorVersion(versionRaw?: string): { major: number; minor: number } | null {
	if (!versionRaw) return null;
	const match = /^(\d+)\.(\d+)/u.exec(versionRaw.trim());
	if (!match) return null;
	const major = Number.parseInt(match[1] ?? "", 10);
	const minor = Number.parseInt(match[2] ?? "", 10);
	if (!Number.isFinite(major) || !Number.isFinite(minor)) return null;
	return { major, minor };
}

export function isWindowsTerminalPreviewSixelSupported(
	env: NodeJS.ProcessEnv = Bun.env,
	platform: NodeJS.Platform = process.platform,
): boolean {
	if (platform !== "win32") return false;
	if (!env.WT_SESSION) return false;
	if (env.TERM_PROGRAM && env.TERM_PROGRAM.toLowerCase() !== "windows_terminal") {
		return false;
	}
	const version = parseMajorMinorVersion(env.TERM_PROGRAM_VERSION);
	if (!version) return false;
	return version.major > 1 || (version.major === 1 && version.minor >= 22);
}

export function synchronizedOutputUserOverride(env: NodeJS.ProcessEnv = Bun.env): boolean | null {
	if (env.VEYYON_NO_SYNC_OUTPUT || env.VEYYON_TUI_SYNC_OUTPUT === "0") return false;
	if (env.VEYYON_FORCE_SYNC_OUTPUT === "1" || env.VEYYON_TUI_SYNC_OUTPUT === "1") return true;
	return null;
}

function advertisesSynchronizedOutput(termFeatures: string | undefined): boolean {
	return termFeatures?.includes("Sy") ?? false;
}

export function shouldEnableSynchronizedOutputByDefault(
	env: NodeJS.ProcessEnv = Bun.env,
	terminalId: TerminalId = TERMINAL_ID,
): boolean {
	const override = synchronizedOutputUserOverride(env);
	if (override !== null) return override;

	if (advertisesSynchronizedOutput(env.TERM_FEATURES)) return true;
	if (env.WT_SESSION) return true;

	if (isInsideTerminalMultiplexer(env)) {
		return false;
	}

	switch (terminalId) {
		case "kitty":
		case "ghostty":
		case "wezterm":
		case "iterm2":
		case "alacritty":
		case "vscode":
			return true;
		default:
			return false;
	}
}

export function detectRectangularSgrSupport(terminalId: TerminalId, env: NodeJS.ProcessEnv = Bun.env): boolean {
	if (terminalId !== "kitty") return false;
	const kill = env.VEYYON_NO_DECCARA;
	if (kill && kill !== "0" && kill.toLowerCase() !== "false") return false;
	if (isInsideTerminalMultiplexer(env)) {
		return false;
	}
	return true;
}
export function hyperlinksUserOverride(env: NodeJS.ProcessEnv = Bun.env): boolean | null {
	if (env.VEYYON_NO_HYPERLINKS === "1") return false;
	if (env.VEYYON_FORCE_HYPERLINKS === "1") return true;
	return null;
}

function parseTmuxVersionFromEnv(env: NodeJS.ProcessEnv): { major: number; minor: number } | null {
	if (env.TERM_PROGRAM?.toLowerCase() !== "tmux") return null;
	return parseMajorMinorVersion(env.TERM_PROGRAM_VERSION);
}

export function shouldEnableHyperlinksByDefault(
	env: NodeJS.ProcessEnv = Bun.env,
	terminalId: TerminalId = TERMINAL_ID,
): boolean {
	const override = hyperlinksUserOverride(env);
	if (override !== null) return override;

	if (!getTerminalInfo(terminalId).hyperlinks) return false;

	if (env.STY) return false;

	if (env.TMUX) {
		const version = parseTmuxVersionFromEnv(env);
		if (!version) return false;
		return version.major > 3 || (version.major === 3 && version.minor >= 4);
	}

	const term = env.TERM?.toLowerCase() ?? "";
	if (term.startsWith("screen")) return false;
	if (term.startsWith("tmux")) return false;

	return true;
}

function getFallbackImageProtocol(terminalId: TerminalId): ImageProtocol | null {
	if (!process.stdout.isTTY) return null;
	if (terminalId === "vscode" || terminalId === "alacritty") return null;
	const term = Bun.env.TERM?.toLowerCase() ?? "";
	if (term.includes("screen") || term.includes("tmux") || term.includes("ghostty")) {
		return ImageProtocol.Kitty;
	}
	return null;
}
export function resolveWarpImageProtocol(
	platform: NodeJS.Platform = process.platform,
	env: NodeJS.ProcessEnv = Bun.env,
): ImageProtocol | null {
	const windowsHost =
		platform === "win32" || (platform === "linux" && Boolean(env.WSL_DISTRO_NAME || env.WSL_INTEROP));
	return windowsHost ? null : ImageProtocol.Kitty;
}

function getWarpTerminalInfo(platform: NodeJS.Platform, env: NodeJS.ProcessEnv = Bun.env): TerminalInfo {
	return new TerminalInfo("warp", resolveWarpImageProtocol(platform, env), true, false, NotifyProtocol.Osc9);
}
const KNOWN_TERMINALS = Object.freeze({
	base: new TerminalInfo("base", null, false, false, NotifyProtocol.Bell),
	trueColor: new TerminalInfo("trueColor", null, true, false, NotifyProtocol.Bell),
	kitty: new TerminalInfo("kitty", ImageProtocol.Kitty, true, true, NotifyProtocol.Osc99, true, true, true),
	ghostty: new TerminalInfo("ghostty", ImageProtocol.Kitty, true, true, NotifyProtocol.Osc9),
	wezterm: new TerminalInfo("wezterm", ImageProtocol.Kitty, true, true, NotifyProtocol.Osc9),
	iterm2: new TerminalInfo("iterm2", ImageProtocol.Iterm2, true, true, NotifyProtocol.Osc9),
	vscode: new TerminalInfo("vscode", null, true, true, NotifyProtocol.Bell),
	alacritty: new TerminalInfo("alacritty", null, true, true, NotifyProtocol.Bell),
	warp: new TerminalInfo("warp", ImageProtocol.Kitty, true, false, NotifyProtocol.Osc9),
});

export type AnsiPolicy = "full" | "noColor" | "plain";

export function detectAnsiPolicy(env: NodeJS.ProcessEnv = Bun.env): AnsiPolicy {
	const { FORCE_COLOR, NO_COLOR, TERM } = env;
	if (FORCE_COLOR !== undefined && FORCE_COLOR !== "" && FORCE_COLOR !== "0") return "full";
	if (TERM?.toLowerCase() === "dumb") return "plain";
	if (NO_COLOR !== undefined && NO_COLOR !== "") return "noColor";
	return "full";
}

export function detectStreamAnsiPolicy(
	env: NodeJS.ProcessEnv = Bun.env,
	isTty: boolean = process.stdout.isTTY === true,
): AnsiPolicy {
	const policy = detectAnsiPolicy(env);
	const { FORCE_COLOR } = env;
	if (FORCE_COLOR !== undefined && FORCE_COLOR !== "" && FORCE_COLOR !== "0") return policy;
	if (policy === "full" && !isTty) return "plain";
	return policy;
}

var ansiPolicy: AnsiPolicy = detectAnsiPolicy();

export function getAnsiPolicy(): AnsiPolicy {
	return ansiPolicy;
}

export function setAnsiPolicy(policy: AnsiPolicy): void {
	ansiPolicy = policy;
}

export function colorEnabled(): boolean {
	return ansiPolicy === "full";
}

export function attributesEnabled(): boolean {
	return ansiPolicy !== "plain";
}

export function detectTerminalId(env: NodeJS.ProcessEnv = Bun.env): TerminalId {
	function caseEq(a: string, b: string): boolean {
		return a.toLowerCase() === b.toLowerCase(); // For compiler to pattern match
	}

	const {
		KITTY_WINDOW_ID,
		GHOSTTY_RESOURCES_DIR,
		WEZTERM_PANE,
		ITERM_SESSION_ID,
		VSCODE_PID,
		ALACRITTY_WINDOW_ID,
		TERM_PROGRAM,
		TERM,
		COLORTERM,
	} = env;

	if (KITTY_WINDOW_ID) return "kitty";
	if (GHOSTTY_RESOURCES_DIR) return "ghostty";
	if (WEZTERM_PANE) return "wezterm";
	if (ITERM_SESSION_ID) return "iterm2";
	if (VSCODE_PID) return "vscode";
	if (ALACRITTY_WINDOW_ID) return "alacritty";

	if (TERM_PROGRAM) {
		if (caseEq(TERM_PROGRAM, "kitty")) return "kitty";
		if (caseEq(TERM_PROGRAM, "ghostty")) return "ghostty";
		if (caseEq(TERM_PROGRAM, "wezterm")) return "wezterm";
		if (caseEq(TERM_PROGRAM, "iterm.app")) return "iterm2";
		if (caseEq(TERM_PROGRAM, "vscode")) return "vscode";
		if (caseEq(TERM_PROGRAM, "alacritty")) return "alacritty";
		if (caseEq(TERM_PROGRAM, "warpterminal")) return "warp";
	}

	if (TERM?.toLowerCase().includes("ghostty")) return "ghostty";

	if (COLORTERM) {
		if (caseEq(COLORTERM, "truecolor") || caseEq(COLORTERM, "24bit")) return "trueColor";
	}
	return "base";
}

export const TERMINAL_ID: TerminalId = detectTerminalId(Bun.env);

export interface RuntimeTerminal extends TerminalInfo {
	imageProtocol: ImageProtocol | null;
	hyperlinks: boolean;
	deccara: boolean;
	supportsScreenToScrollback: boolean;
	textSizing: boolean;
}

export const TERMINAL: RuntimeTerminal = (() => {
	const resolved = getTerminalInfo(TERMINAL_ID).clone();

	const forcedImageProtocol = getForcedImageProtocol();
	if (forcedImageProtocol !== undefined) {
		resolved.imageProtocol = forcedImageProtocol;
	} else if (resolved.id === "warp") {
		resolved.imageProtocol = resolveWarpImageProtocol();
	} else if (!resolved.imageProtocol) {
		const fallbackImageProtocol = getFallbackImageProtocol(resolved.id);
		if (fallbackImageProtocol) resolved.imageProtocol = fallbackImageProtocol;
	}
	resolved.hyperlinks = shouldEnableHyperlinksByDefault(Bun.env, resolved.id);
	resolved.deccara = detectRectangularSgrSupport(resolved.id, Bun.env) && !isBunTestRuntime();
	return resolved;
})();

setKittyGraphics({ unicodePlaceholders: detectKittyUnicodePlaceholdersSupport(TERMINAL.id, Bun.env) });

export function setTerminalImageProtocol(imageProtocol: ImageProtocol | null): void {
	TERMINAL.imageProtocol = imageProtocol;
}

export function setTerminalDeccara(enabled: boolean): void {
	TERMINAL.deccara = enabled;
}

export function setTerminalScreenToScrollback(enabled: boolean): void {
	TERMINAL.supportsScreenToScrollback = enabled;
}

export function setTerminalTextSizing(enabled: boolean): void {
	TERMINAL.textSizing = enabled;
}

export function getTerminalInfo(
	terminalId: TerminalId,
	platform: NodeJS.Platform = process.platform,
	env: NodeJS.ProcessEnv = Bun.env,
): TerminalInfo {
	return terminalId === "warp" ? getWarpTerminalInfo(platform, env) : KNOWN_TERMINALS[terminalId];
}

export interface CellDimensions {
	widthPx: number;
	heightPx: number;
}

export interface ImageDimensions {
	widthPx: number;
	heightPx: number;
}

export interface ImageRenderOptions {
	maxWidthCells?: number;
	maxHeightCells?: number;
	preserveAspectRatio?: boolean;
	imageId?: number;
	placementId?: number;
	includeTransmit?: boolean;
}

let cellDimensions: CellDimensions = { widthPx: 9, heightPx: 18 };

export function getCellDimensions(): CellDimensions {
	return cellDimensions;
}

export function setCellDimensions(dims: CellDimensions): void {
	cellDimensions = dims;
}

function chunkKittyApc(leadParams: string, base64Data: string): string {
	const CHUNK_SIZE = 4096;
	if (base64Data.length <= CHUNK_SIZE) {
		return wrapTmuxPassthroughIfNeeded(`\x1b_G${leadParams};${base64Data}\x1b\\`);
	}

	const chunks: string[] = [];
	let offset = 0;
	let isFirst = true;

	while (offset < base64Data.length) {
		const chunk = base64Data.slice(offset, offset + CHUNK_SIZE);
		const isLast = offset + CHUNK_SIZE >= base64Data.length;

		if (isFirst) {
			chunks.push(wrapTmuxPassthroughIfNeeded(`\x1b_G${leadParams},m=1;${chunk}\x1b\\`));
			isFirst = false;
		} else if (isLast) {
			chunks.push(wrapTmuxPassthroughIfNeeded(`\x1b_Gq=2,m=0;${chunk}\x1b\\`));
		} else {
			chunks.push(wrapTmuxPassthroughIfNeeded(`\x1b_Gq=2,m=1;${chunk}\x1b\\`));
		}

		offset += CHUNK_SIZE;
	}

	return chunks.join("");
}

export function encodeKitty(
	base64Data: string,
	options: {
		columns?: number;
		rows?: number;
		imageId?: number;
	} = {},
): string {
	const params: string[] = ["a=T", "f=100", "q=2", "C=1"];
	if (options.columns) params.push(`c=${options.columns}`);
	if (options.rows) params.push(`r=${options.rows}`);
	if (options.imageId) params.push(`i=${options.imageId}`);
	return chunkKittyApc(params.join(","), base64Data);
}

export function encodeKittyTransmit(base64Data: string, imageId: number): string {
	return chunkKittyApc(`a=t,f=100,q=2,i=${imageId}`, base64Data);
}

export function encodeKittyPlacement(options: {
	imageId: number;
	placementId?: number;
	columns?: number;
	rows?: number;
}): string {
	const params: string[] = ["a=p", "q=2", "C=1", `i=${options.imageId}`];
	if (options.placementId) params.push(`p=${options.placementId}`);
	if (options.columns) params.push(`c=${options.columns}`);
	if (options.rows) params.push(`r=${options.rows}`);
	return wrapTmuxPassthroughIfNeeded(`\x1b_G${params.join(",")}\x1b\\`);
}

export function encodeKittyDeleteImage(imageId: number): string {
	return wrapTmuxPassthroughIfNeeded(`\x1b_Ga=d,d=I,i=${imageId},q=2\x1b\\`);
}

export function encodeITerm2(
	base64Data: string,
	options: {
		width?: number | string;
		height?: number | string;
		name?: string;
		preserveAspectRatio?: boolean;
		inline?: boolean;
	} = {},
): string {
	const params: string[] = [`inline=${options.inline !== false ? 1 : 0}`];

	if (options.width !== undefined) params.push(`width=${options.width}`);
	if (options.height !== undefined) params.push(`height=${options.height}`);
	if (options.name) {
		const nameBase64 = Buffer.from(options.name).toBase64();
		params.push(`name=${nameBase64}`);
	}
	if (options.preserveAspectRatio === false) {
		params.push("preserveAspectRatio=0");
	}

	return `\x1b]1337;File=${params.join(";")}:${base64Data}\x07`;
}

const MAX_IMAGE_FIT_CELLS = 4096;

const MAX_SIXEL_PIXELS = 16_777_216;

export function calculateImageFit(
	imageDimensions: ImageDimensions,
	options: ImageRenderOptions,
	cellDims: CellDimensions,
): { columns: number; rows: number } {
	const widthPx = Number.isFinite(imageDimensions.widthPx) ? Math.max(1, imageDimensions.widthPx) : 1;
	const heightPx = Number.isFinite(imageDimensions.heightPx) ? Math.max(1, imageDimensions.heightPx) : 1;
	const maxColumns = options.maxWidthCells !== undefined ? Math.max(1, Math.floor(options.maxWidthCells)) : undefined;
	const maxRows = options.maxHeightCells !== undefined ? Math.max(1, Math.floor(options.maxHeightCells)) : undefined;

	let columns: number;
	let rows: number;
	if (maxColumns === undefined && maxRows === undefined) {
		columns = Math.max(1, Math.ceil(widthPx / cellDims.widthPx));
		rows = Math.max(1, Math.ceil(heightPx / cellDims.heightPx));
	} else {
		const maxWidthPx = maxColumns !== undefined ? maxColumns * cellDims.widthPx : Number.POSITIVE_INFINITY;
		const maxHeightPx = maxRows !== undefined ? maxRows * cellDims.heightPx : Number.POSITIVE_INFINITY;
		const scale = Math.min(maxWidthPx / widthPx, maxHeightPx / heightPx);
		columns = Math.max(1, Math.floor((widthPx * scale) / cellDims.widthPx));
		rows = Math.max(1, Math.ceil((heightPx * scale) / cellDims.heightPx));
		if (maxColumns !== undefined) columns = Math.min(columns, maxColumns);
		if (maxRows !== undefined) rows = Math.min(rows, maxRows);
	}

	return {
		columns: Math.min(columns, MAX_IMAGE_FIT_CELLS),
		rows: Math.min(rows, MAX_IMAGE_FIT_CELLS),
	};
}

export function getPngDimensions(base64Data: string): ImageDimensions | null {
	try {
		const buffer = Buffer.from(base64Data, "base64");

		if (buffer.length < 24) {
			return null;
		}

		if (buffer[0] !== 0x89 || buffer[1] !== 0x50 || buffer[2] !== 0x4e || buffer[3] !== 0x47) {
			return null;
		}

		const width = buffer.readUInt32BE(16);
		const height = buffer.readUInt32BE(20);

		return { widthPx: width, heightPx: height };
	} catch {
		return null;
	}
}

export function getJpegDimensions(base64Data: string): ImageDimensions | null {
	try {
		const buffer = Buffer.from(base64Data, "base64");

		if (buffer.length < 2) {
			return null;
		}

		if (buffer[0] !== 0xff || buffer[1] !== 0xd8) {
			return null;
		}

		let offset = 2;
		while (offset < buffer.length - 9) {
			if (buffer[offset] !== 0xff) {
				offset++;
				continue;
			}

			const marker = buffer[offset + 1];

			if (marker >= 0xc0 && marker <= 0xc2) {
				const height = buffer.readUInt16BE(offset + 5);
				const width = buffer.readUInt16BE(offset + 7);
				return { widthPx: width, heightPx: height };
			}

			if (offset + 3 >= buffer.length) {
				return null;
			}
			const length = buffer.readUInt16BE(offset + 2);
			if (length < 2) {
				return null;
			}
			offset += 2 + length;
		}

		return null;
	} catch {
		return null;
	}
}

export function getGifDimensions(base64Data: string): ImageDimensions | null {
	try {
		const buffer = Buffer.from(base64Data, "base64");

		if (buffer.length < 10) {
			return null;
		}

		const sig = buffer.slice(0, 6).toString("ascii");
		if (sig !== "GIF87a" && sig !== "GIF89a") {
			return null;
		}

		const width = buffer.readUInt16LE(6);
		const height = buffer.readUInt16LE(8);

		return { widthPx: width, heightPx: height };
	} catch {
		return null;
	}
}

export function getWebpDimensions(base64Data: string): ImageDimensions | null {
	try {
		const buffer = Buffer.from(base64Data, "base64");

		if (buffer.length < 30) {
			return null;
		}

		const riff = buffer.slice(0, 4).toString("ascii");
		const webp = buffer.slice(8, 12).toString("ascii");
		if (riff !== "RIFF" || webp !== "WEBP") {
			return null;
		}

		const chunk = buffer.slice(12, 16).toString("ascii");
		if (chunk === "VP8 ") {
			if (buffer.length < 30) return null;
			const width = buffer.readUInt16LE(26) & 0x3fff;
			const height = buffer.readUInt16LE(28) & 0x3fff;
			return { widthPx: width, heightPx: height };
		} else if (chunk === "VP8L") {
			if (buffer.length < 25) return null;
			const bits = buffer.readUInt32LE(21);
			const width = (bits & 0x3fff) + 1;
			const height = ((bits >> 14) & 0x3fff) + 1;
			return { widthPx: width, heightPx: height };
		} else if (chunk === "VP8X") {
			if (buffer.length < 30) return null;
			const width = (buffer[24] | (buffer[25] << 8) | (buffer[26] << 16)) + 1;
			const height = (buffer[27] | (buffer[28] << 8) | (buffer[29] << 16)) + 1;
			return { widthPx: width, heightPx: height };
		}

		return null;
	} catch {
		return null;
	}
}

export function getImageDimensions(base64Data: string, mimeType: string): ImageDimensions | null {
	if (mimeType === "image/png") {
		return getPngDimensions(base64Data);
	}
	if (mimeType === "image/jpeg") {
		return getJpegDimensions(base64Data);
	}
	if (mimeType === "image/gif") {
		return getGifDimensions(base64Data);
	}
	if (mimeType === "image/webp") {
		return getWebpDimensions(base64Data);
	}
	return null;
}

export function renderImage(
	base64Data: string,
	imageDimensions: ImageDimensions,
	options: ImageRenderOptions = {},
): { sequence?: string; lines?: string[]; rows: number; transmit?: string } | null {
	if (!TERMINAL.imageProtocol) {
		return null;
	}

	const cellDims = getCellDimensions();
	const fit = calculateImageFit(imageDimensions, options, cellDims);

	if (TERMINAL.imageProtocol === ImageProtocol.Kitty) {
		if (options.imageId != null) {
			const placementId = options.placementId ?? options.imageId;
			const graphics = getKittyGraphics();
			let transmit: string | undefined;
			if (options.includeTransmit) {
				transmit = encodeKittyTransmit(base64Data, options.imageId);
			}
			if (graphics.unicodePlaceholders && kittyPlaceholdersFit(fit.columns, fit.rows)) {
				const lines = renderKittyPlaceholderLines({
					imageId: options.imageId,
					placementId,
					columns: fit.columns,
					rows: fit.rows,
				});
				return { lines, rows: fit.rows, transmit };
			}
			const sequence = encodeKittyPlacement({
				imageId: options.imageId,
				placementId,
				columns: fit.columns,
				rows: fit.rows,
			});
			return { sequence, rows: fit.rows, transmit };
		}
		const sequence = encodeKitty(base64Data, {
			columns: fit.columns,
			rows: fit.rows,
		});
		return { sequence, rows: fit.rows };
	}

	if (TERMINAL.imageProtocol === ImageProtocol.Sixel) {
		try {
			const targetWidthPx = Math.max(1, fit.columns * cellDims.widthPx);
			const targetHeightPx = Math.max(1, fit.rows * cellDims.heightPx);
			const targetPixels = targetWidthPx * targetHeightPx;
			const sourcePixels = Math.max(1, imageDimensions.widthPx) * Math.max(1, imageDimensions.heightPx);
			if (targetPixels > MAX_SIXEL_PIXELS || sourcePixels > MAX_SIXEL_PIXELS) {
				return null;
			}
			const decoded = new Uint8Array(Buffer.from(base64Data, "base64"));
			const sequence = encodeSixel(decoded, targetWidthPx, targetHeightPx);
			return { sequence, rows: fit.rows };
		} catch {
			return null;
		}
	}
	if (TERMINAL.imageProtocol === ImageProtocol.Iterm2) {
		const sequence = encodeITerm2(base64Data, {
			width: fit.columns,
			height: "auto",
			preserveAspectRatio: options.preserveAspectRatio ?? true,
		});
		return { sequence, rows: fit.rows };
	}

	return null;
}

export type ImageFallbackReason = "no-protocol" | "images-off" | "over-budget" | "unsupported-format";

export interface ImageFallbackText {
	readonly mimeType: string;
	readonly dimensions?: ImageDimensions;
	readonly filename?: string;
	readonly reason?: ImageFallbackReason;
}

const IMAGE_FALLBACK_CAUSE: Record<ImageFallbackReason, string> = {
	"no-protocol": "no image protocol",
	"images-off": "images off",
	"over-budget": "over the image budget",
	"unsupported-format": "unsupported format",
};

export function imageFallback(text: ImageFallbackText): string {
	const parts: string[] = [];
	if (text.filename) parts.push(text.filename);
	parts.push(text.mimeType);
	if (text.dimensions) parts.push(`${text.dimensions.widthPx}x${text.dimensions.heightPx}`);
	const cause = IMAGE_FALLBACK_CAUSE[text.reason ?? "no-protocol"];
	return `[image not shown, ${cause}] ${parts.join(" · ")}`;
}

export interface TerminalNotification {
	title?: string;
	body?: string;
	id?: string;
	type?: string | string[];
	urgency?: "low" | "normal" | "critical";
	iconName?: string;
	sound?: "silent" | "system" | "info" | "warning" | "error" | "question";
	actions?: "focus" | "report" | "focus-report" | "none";
	expiresMs?: number;
	deliverWhenFocused?: boolean;
}

let osc99CapabilitiesConfirmed = false;

export function setOsc99Supported(supported: boolean): void {
	osc99CapabilitiesConfirmed = supported;
}

export function isOsc99Supported(): boolean {
	return osc99CapabilitiesConfirmed;
}

function notificationToLine(n: TerminalNotification): string {
	if (n.title && n.body) return `${n.title}: ${n.body}`;
	return n.title ?? n.body ?? "";
}

const OSC99_UNSAFE = /[\x00-\x1f\x7f\x80-\x9f]/u;
const OSC99_MAX_PAYLOAD_BYTES = 2048;
let nextOsc99NotificationId = 1;

function base64Utf8(value: string): string {
	return Buffer.from(value, "utf8").toString("base64");
}

function sanitizeOsc99Id(id: string | undefined): string {
	if (!id) return "";
	const safe = id.replace(/[^a-zA-Z0-9_+\-.]/gu, "");
	return safe === "0" ? "" : safe;
}

function osc99Id(id: string | undefined): string {
	return sanitizeOsc99Id(id) || `veyyon-${nextOsc99NotificationId++}`;
}

function utf8CodePointBytes(char: string): number {
	const codePoint = char.codePointAt(0) ?? 0;
	if (codePoint <= 0x7f) return 1;
	if (codePoint <= 0x7ff) return 2;
	if (codePoint <= 0xffff) return 3;
	return 4;
}

function chunkUtf8(payload: string): string[] {
	if (payload === "") return [""];
	const chunks: string[] = [];
	let start = 0;
	let index = 0;
	let bytes = 0;
	for (const char of payload) {
		const charBytes = utf8CodePointBytes(char);
		if (bytes > 0 && bytes + charBytes > OSC99_MAX_PAYLOAD_BYTES) {
			chunks.push(payload.slice(start, index));
			start = index;
			bytes = 0;
		}
		bytes += charBytes;
		index += char.length;
	}
	chunks.push(payload.slice(start));
	return chunks;
}

function osc99Chunk(meta: string[], payload: string): string {
	if (OSC99_UNSAFE.test(payload)) {
		return `\x1b]99;${meta.concat(["e=1"]).join(":")};${base64Utf8(payload)}\x1b\\`;
	}
	return `\x1b]99;${meta.join(":")};${payload}\x1b\\`;
}

function osc99Payload(meta: string[], payload: string, holdUntilLaterPayload: boolean): string {
	const chunks = chunkUtf8(payload);
	let out = "";
	for (let i = 0; i < chunks.length; i++) {
		const chunkMeta = meta.slice();
		if (holdUntilLaterPayload || i < chunks.length - 1) chunkMeta.push("d=0");
		out += osc99Chunk(chunkMeta, chunks[i]!);
	}
	return out;
}

function osc99Urgency(urgency: TerminalNotification["urgency"]): string | undefined {
	switch (urgency) {
		case "low":
			return "0";
		case "normal":
			return "1";
		case "critical":
			return "2";
		default:
			return undefined;
	}
}

function osc99Actions(actions: TerminalNotification["actions"]): string | undefined {
	switch (actions) {
		case "focus":
			return "focus";
		case "report":
			return "report";
		case "focus-report":
			return "focus,report";
		case "none":
			return "-focus";
		default:
			return undefined;
	}
}

function formatOsc99Notification(n: TerminalNotification): string {
	const id = osc99Id(n.id);
	const meta: string[] = [`i=${id}`, `f=${base64Utf8(APP_DISPLAY_NAME)}`];
	const actions = osc99Actions(n.actions);
	if (actions) meta.push(`a=${actions}`);
	const urgency = osc99Urgency(n.urgency);
	if (urgency) meta.push(`u=${urgency}`);
	const types = n.type === undefined ? [] : Array.isArray(n.type) ? n.type : [n.type];
	for (const t of types) meta.push(`t=${base64Utf8(t)}`);
	if (n.iconName) meta.push(`n=${base64Utf8(n.iconName)}`);
	if (n.sound) meta.push(`s=${base64Utf8(n.sound)}`);
	if (n.expiresMs !== undefined && Number.isFinite(n.expiresMs)) {
		meta.push(`w=${Math.max(-1, Math.trunc(n.expiresMs))}`);
	}

	const title = n.title ?? n.body ?? "";
	const body = n.title ? n.body : undefined;

	if (body !== undefined && body !== "") {
		return osc99Payload(meta, title, true) + osc99Payload([`i=${id}`, "p=body"], body, false);
	}
	return osc99Payload(meta, title, false);
}
