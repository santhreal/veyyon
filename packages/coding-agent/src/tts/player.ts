import { $which, errorMessage, readPipeText } from "@veyyon/utils";
import { adoptIntoPrimarySessionCpuBudget } from "../session/cpu-limit";
import { getToolPath } from "../utils/tools-manager";

export interface PlayerCommand {
	cmd: string;
	args: string[];
}

/** Injection seam for {@link playerCommandsFor} — defaults to real PATH/tools lookups. */
export interface PlayerLookup {
	which?: (bin: string) => string | null;
	ffmpeg?: () => string | null;
}

/** Build the ordered list of playback commands to try for `filePath` on the given platform. Pure + injectable so the selection logic is testable without */
export function playerCommandsFor(
	platform: NodeJS.Platform,
	filePath: string,
	lookup: PlayerLookup = {},
): PlayerCommand[] {
	const which = lookup.which ?? $which;
	const ffmpeg = lookup.ffmpeg ?? ((): string | null => getToolPath("ffmpeg"));

	if (platform === "darwin") {
		return [{ cmd: "afplay", args: [filePath] }];
	}
	if (platform === "win32") {
		return [
			{
				cmd: "powershell",
				args: ["-NoProfile", "-Command", `(New-Object Media.SoundPlayer '${filePath}').PlaySync()`],
			},
		];
	}

	// Linux and other POSIX desktops share the PulseAudio/ALSA fallback chain.
	const commands: PlayerCommand[] = [];
	const paplay = which("paplay");
	if (paplay) commands.push({ cmd: paplay, args: [filePath] });
	const aplay = which("aplay");
	if (aplay) commands.push({ cmd: aplay, args: [filePath] });
	const ffmpegBin = ffmpeg();
	if (ffmpegBin) {
		commands.push({
			cmd: ffmpegBin,
			args: ["-loglevel", "error", "-nostdin", "-i", filePath, "-f", "pulse", "default"],
		});
		commands.push({
			cmd: ffmpegBin,
			args: ["-loglevel", "error", "-nostdin", "-i", filePath, "-f", "alsa", "default"],
		});
	}
	return commands;
}

export interface PlayAudioOptions {
	signal?: AbortSignal;
}

function playbackAbortError(signal: AbortSignal): Error {
	const reason = signal.reason;
	return reason instanceof Error ? reason : new DOMException("Audio playback aborted", "AbortError");
}

/** Play `filePath` through the speakers, trying each candidate command in order and returning on the first clean exit. Throws an actionable Error if no */
export async function playAudioFile(filePath: string, options: PlayAudioOptions = {}): Promise<void> {
	const { signal } = options;
	if (signal?.aborted) throw playbackAbortError(signal);
	const commands = playerCommandsFor(process.platform, filePath);
	if (commands.length === 0) {
		throw new Error(
			"No audio player available. Install PulseAudio (paplay) or ALSA (aplay), " +
				"or run `veyyon setup speech` to download a bundled ffmpeg.",
		);
	}

	const failures: string[] = [];
	for (const command of commands) {
		if (signal?.aborted) throw playbackAbortError(signal);
		try {
			const proc = Bun.spawn([command.cmd, ...command.args], { stdout: "ignore", stderr: "pipe" });
			adoptIntoPrimarySessionCpuBudget(proc.pid);
			let killTimer: NodeJS.Timeout | undefined;
			const abort = (): void => {
				proc.kill("SIGTERM");
				killTimer = setTimeout(() => proc.kill("SIGKILL"), 500);
				killTimer.unref?.();
			};
			signal?.addEventListener("abort", abort, { once: true });
			try {
				const code = await proc.exited;
				if (signal?.aborted) throw playbackAbortError(signal);
				if (code === 0) return;
				let stderr = "";
				if (proc.stderr && typeof proc.stderr !== "number") {
					stderr = await readPipeText(proc.stderr);
				}
				failures.push(`${command.cmd} exited ${code}${stderr.trim() ? `: ${stderr.trim()}` : ""}`);
			} finally {
				signal?.removeEventListener("abort", abort);
				if (killTimer) clearTimeout(killTimer);
			}
		} catch (err) {
			if (signal?.aborted) throw playbackAbortError(signal);
			failures.push(`${command.cmd}: ${errorMessage(err)}`);
		}
	}

	throw new Error(`Audio playback failed:\n${failures.join("\n")}`);
}

/** Best-effort temp-file cleanup used by callers after playback. */
