import type { ClipboardImage } from "@veyyon/natives";
import * as native from "@veyyon/natives";
import { logger, readPipeText } from "@veyyon/utils";

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

export async function copyToClipboard(text: string): Promise<void> {
	if (process.stdout.isTTY) {
		const onError = (err: unknown) => {
			process.stdout.off("error", onError);
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
				if ((err as NodeJS.ErrnoException | null | undefined)?.code === "EPIPE") {
					return;
				}
			});
		} catch (err) {
			process.stdout.off("error", onError);
			if ((err as NodeJS.ErrnoException | null | undefined)?.code !== "EPIPE") {
			}
		}
	}

	try {
		if (process.env.TERMUX_VERSION) {
			try {
				await spawnCapture(["termux-clipboard-set"], { input: text, timeoutMs: 5000 });
				return;
			} catch {}
		}

		await native.copyToClipboard(text);
	} catch {}
}

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

const POWERSHELL_TEXT_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
[Console]::Out.Write([string](Get-Clipboard -Raw))
`;

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
		return null;
	}
}

export async function readImageFromClipboard(): Promise<ClipboardImage | null> {
	if (process.env.TERMUX_VERSION) {
		return null;
	}

	if (isWsl()) {
		const image = await readImageViaPowerShell();
		if (image) return image;
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
