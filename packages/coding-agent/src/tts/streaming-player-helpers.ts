import { $which } from "@veyyon/utils";
import { getToolPath } from "../utils/tools-manager";
import type { PlayerCommand } from "./player";

export const DEFAULT_SAMPLE_RATE = 24_000;
export const LEAD_SECONDS = 0.6;
export const DUCK_GAIN = 0.25;

export interface StreamingPlayerLookup {
	which?: (bin: string) => string | null;
	ffmpeg?: () => string | null;
}

export function streamingPlayerCommandsFor(
	platform: NodeJS.Platform,
	sampleRate: number,
	lookup: StreamingPlayerLookup = {},
): PlayerCommand[] {
	const which = lookup.which ?? $which;
	const ffmpeg = lookup.ffmpeg ?? ((): string | null => getToolPath("ffmpeg"));
	const rate = String(sampleRate > 0 ? sampleRate : DEFAULT_SAMPLE_RATE);
	const input = ["-loglevel", "error", "-nostdin", "-f", "f32le", "-ar", rate, "-ac", "1", "-i", "pipe:0"];

	if (platform === "darwin") {
		const commands: PlayerCommand[] = [];
		const ffmpegBin = ffmpeg();
		if (ffmpegBin) commands.push({ cmd: ffmpegBin, args: input.concat(["-f", "audiotoolbox", "default"]) });
		const play = which("play");
		if (play) {
			commands.push({
				cmd: play,
				args: ["-q", "-t", "raw", "-e", "floating-point", "-b", "32", "-r", rate, "-c", "1", "-"],
			});
		}
		return commands;
	}
	if (platform === "win32") {
		return [];
	}

	const commands: PlayerCommand[] = [];
	const ffmpegBin = ffmpeg();
	if (ffmpegBin) {
		commands.push({ cmd: ffmpegBin, args: input.concat(["-f", "pulse", "default"]) });
		commands.push({ cmd: ffmpegBin, args: input.concat(["-f", "alsa", "default"]) });
	}
	const paplay = which("paplay");
	if (paplay) commands.push({ cmd: paplay, args: ["--raw", `--rate=${rate}`, "--format=float32le", "--channels=1"] });
	const aplay = which("aplay");
	if (aplay) commands.push({ cmd: aplay, args: ["-q", "-f", "FLOAT_LE", "-r", rate, "-c", "1", "-"] });
	return commands;
}
