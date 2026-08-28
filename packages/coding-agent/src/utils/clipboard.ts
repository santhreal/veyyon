import type { ClipboardImage } from "@veyyon/natives";
import * as native from "@veyyon/natives";
import { logger, readPipeText } from "@veyyon/utils";

/** Run a subprocess and capture its stdout without blocking the event loop. `readTextFromClipboard`, `readMacFileUrlsFromClipboard`, and the Termux copy */
async function spawnCapture(cmd: string[], options: { input?: string; timeoutMs?: number } = {}): Promise<string> {
	const timeoutMs = options.timeoutMs ?? 2000;
	const proc = Bun.spawn(cmd, {
		stdout: "pipe",
		stderr: "ignore",
		stdin: options.input !== undefined ? Buffer.from(options.input) : "ignore",
	});
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		proc.kill();
	}, timeoutMs);
	try {
		const stdout = await readPipeText(proc.stdout);
		await proc.exited;
		if (timedOut) {
			throw new Error(`${cmd[0]} timed out after ${timeoutMs}ms`);
		}
		if (proc.exitCode !== 0) {
			throw new Error(`${cmd[0]} exited with code ${proc.exitCode}`);
		}
		return stdout;
	} finally {
		clearTimeout(timer);
	}
}

function hasDisplay(): boolean {
	return process.platform !== "linux" || Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

function isWsl(): boolean {
	return process.platform === "linux" && Boolean(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP);
}

// AppleScript that returns the POSIX paths of every file URL currently on the macOS pasteboard, one path per line. `pbpaste(1)` only surfaces plain text,
const MAC_FILE_URL_SCRIPT = [
	"on run",
	'\tset output to ""',
	"\ttry",
	"\t\tset theClip to the clipboard as «class furl»",
	"\t\tif class of theClip is list then",
	"\t\t\trepeat with anItem in theClip",
	"\t\t\t\ttry",
	"\t\t\t\t\tset output to output & POSIX path of anItem & linefeed",
	"\t\t\t\tend try",
	"\t\t\tend repeat",
	"\t\telse",
	"\t\t\ttry",
	"\t\t\t\tset output to POSIX path of theClip & linefeed",
	"\t\t\tend try",
	"\t\tend if",
	"\tend try",
	"\treturn output",
	"end run",
].join("\n");

/** Read file paths from the macOS pasteboard's `public.file-url` representation. Used to reach the Finder `Cmd+C` pasteboard (which exposes only file URLs, */
export async function readMacFileUrlsFromClipboard(): Promise<string[]> {
	if (process.platform !== "darwin") return [];
	try {
		const stdout = await spawnCapture(["osascript", "-"], { input: MAC_FILE_URL_SCRIPT });
		return stdout
			.split(/\r?\n/)
			.map(line => line.trim())
			.filter(line => line.length > 0);
	} catch (error) {
		logger.warn("clipboard: failed to read macOS file URLs", { error: String(error) });
		return [];
	}
}

/** Copy text to the system clipboard. Emits OSC 52 first when running in a real terminal (works over SSH/mosh), */
export async function copyToClipboard(text: string): Promise<void> {
	if (process.stdout.isTTY) {
		const onError = (err: unknown) => {
			process.stdout.off("error", onError);
			// Prevent unhandled 'error' from crashing the process when stdout is a closed pipe.
			if ((err as NodeJS.ErrnoException | null | undefined)?.code === "EPIPE") {
				return;
			}
		};
		try {
			const encoded = Buffer.from(text).toString("base64");
			const osc52 = `\x1b]52;c;${encoded}\x07`;
			process.stdout.on("error", onError);
			process.stdout.write(osc52, err => {
				process.stdout.off("error", onError);
				// If stdout is closed (e.g. piped to a process that exits early),
				// ignore EPIPE and proceed with native clipboard best-effort.
				if ((err as NodeJS.ErrnoException | null | undefined)?.code === "EPIPE") {
					return;
				}
			});
		} catch (err) {
			process.stdout.off("error", onError);
			if ((err as NodeJS.ErrnoException | null | undefined)?.code !== "EPIPE") {
				// Ignore all write failures (OSC 52 is best-effort).
			}
		}
	}

	// Also try native tools (best effort for local sessions)
	try {
		if (process.env.TERMUX_VERSION) {
			try {
				await spawnCapture(["termux-clipboard-set"], { input: text, timeoutMs: 5000 });
				return;
			} catch {
				// Fall through to native
			}
		}

		await native.copyToClipboard(text);
	} catch {
		// Ignore — clipboard copy is best-effort
	}
}

// PowerShell one-liner that emits the Windows clipboard image as base64-encoded PNG on stdout, or nothing when the clipboard does not hold image data. Used
const POWERSHELL_IMAGE_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$img = [System.Windows.Forms.Clipboard]::GetImage()
if ($img -ne $null) {
	$ms = New-Object System.IO.MemoryStream
	$img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
	[Console]::Out.Write([Convert]::ToBase64String($ms.ToArray()))
}
`;

const POWERSHELL_TIMEOUT_MS = 8000;

/** Read an image through the Windows host's PowerShell. Native Windows uses this as a fallback when arboard reports no image or */
async function readImageViaPowerShell(): Promise<ClipboardImage | null> {
	try {
		const proc = Bun.spawn(
			["powershell.exe", "-NoProfile", "-NonInteractive", "-Sta", "-Command", POWERSHELL_IMAGE_SCRIPT],
			{
				stdout: "pipe",
				stderr: "ignore",
				stdin: "ignore",
			},
		);
		const timer = setTimeout(() => proc.kill(), POWERSHELL_TIMEOUT_MS);
		let stdout = "";
		try {
			stdout = await readPipeText(proc.stdout);
			await proc.exited;
		} catch (err) {
			// powershell.exe can be a Windows process reached either natively or
			// over WSL interop; if it doesn't reap cleanly, report no image instead
			// of surfacing an opaque bridge failure to the prompt.
			logger.warn("clipboard: powershell read failed", { error: String(err) });
			return null;
		} finally {
			clearTimeout(timer);
		}
		if (proc.exitCode !== 0) return null;
		const b64 = stdout.trim();
		if (!b64) return null;
		const bytes = Buffer.from(b64, "base64");
		if (bytes.byteLength === 0) return null;
		return { data: bytes, mimeType: "image/png" };
	} catch {
		return null;
	}
}

// PowerShell one-liner that emits the clipboard text verbatim on stdout, or nothing when the clipboard holds no text. `[Console]::Out.Write` avoids the
const POWERSHELL_TEXT_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
[Console]::Out.Write([string](Get-Clipboard -Raw))
`;

/** Read clipboard text through Windows PowerShell — native win32 or the WSL host over interop. */
async function readTextViaPowerShell(): Promise<string | null> {
	try {
		const proc = Bun.spawn(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", POWERSHELL_TEXT_SCRIPT], {
			stdout: "pipe",
			stderr: "ignore",
			stdin: "ignore",
		});
		const timer = setTimeout(() => proc.kill(), POWERSHELL_TIMEOUT_MS);
		let stdout = "";
		try {
			stdout = await readPipeText(proc.stdout);
			await proc.exited;
		} catch (err) {
			logger.warn("clipboard: powershell text read failed", { error: String(err) });
			return null;
		} finally {
			clearTimeout(timer);
		}
		if (proc.exitCode !== 0) return null;
		return stdout.replaceAll("\r\n", "\n");
	} catch {
		// Spawning PowerShell at all failed: not on PATH, blocked by policy, or no Windows host under this
		// process. Null means "this reader cannot get the clipboard", which is what the caller needs to try
		// the next reader; the reader that DOES run reports its own failures a few lines above.
		return null;
	}
}

/** Read an image from the system clipboard. Returns null on Termux (no image clipboard support) or when no display */
export async function readImageFromClipboard(): Promise<ClipboardImage | null> {
	if (process.env.TERMUX_VERSION) {
		return null;
	}

	if (isWsl()) {
		const image = await readImageViaPowerShell();
		if (image) return image;
		// Fall through: arboard may still succeed on a future WSLg release —
		// but only when we actually have a display server. Headless WSL has
		// no display, so arboard would reject anyway.
	}

	if (process.platform === "win32") {
		try {
			const image = await native.readImageFromClipboard();
			if (image) return image;
		} catch (err) {
			logger.warn("clipboard: native Windows image read failed", { error: String(err) });
		}
		return await readImageViaPowerShell();
	}

	if (!hasDisplay()) {
		return null;
	}

	return (await native.readImageFromClipboard()) ?? null;
}

/**
 * Read plain text from the system clipboard.
 */
export async function readTextFromClipboard(): Promise<string> {
	try {
		const p = process.platform;
		if (p === "darwin") {
			return await spawnCapture(["pbpaste"]);
		}
		if (p === "win32") {
			return (await readTextViaPowerShell()) ?? "";
		}
		if (process.env.TERMUX_VERSION) {
			return await spawnCapture(["termux-clipboard-get"]);
		}
		if (isWsl()) {
			const text = await readTextViaPowerShell();
			if (text !== null) return text;
			// Bridge failed — fall through to the wl-paste/xclip paths below.
		}
		const hasWaylandDisplay = Boolean(process.env.WAYLAND_DISPLAY);
		const hasX11Display = Boolean(process.env.DISPLAY);
		if (hasWaylandDisplay) {
			try {
				return await spawnCapture(["wl-paste", "--type", "text/plain", "--no-newline"]);
			} catch {
				if (hasX11Display) {
					return await spawnCapture(["xclip", "-selection", "clipboard", "-o"]);
				}
			}
		} else if (hasX11Display) {
			return await spawnCapture(["xclip", "-selection", "clipboard", "-o"]);
		}
	} catch (error) {
		logger.warn("clipboard: failed to read clipboard text", { error: String(error) });
	}
	return "";
}
