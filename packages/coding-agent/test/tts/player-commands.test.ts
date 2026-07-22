import { describe, expect, it } from "bun:test";
import { type PlayerLookup, playerCommandsFor } from "@veyyon/coding-agent/tts/player";

/**
 * playerCommandsFor builds the ordered list of audio-playback commands to try for a file on a given
 * platform. It is designed to be pure and injectable (a `which`/`ffmpeg` lookup seam) so the selection
 * logic is testable without spawning anything, yet it had no test. The contracts pinned here are the
 * platform branches and the POSIX fallback ordering the TTS player depends on:
 *   - darwin always returns exactly `afplay` (present on every mac);
 *   - win32 returns exactly one PowerShell SoundPlayer command with the file path embedded in the script;
 *   - Linux/POSIX builds an ordered chain — paplay, then aplay, then ffmpeg(pulse), then ffmpeg(alsa) —
 *     including ONLY the tools the lookup reports as present, and returns an empty list when none exist;
 *   - the file path is threaded into every command's argument list unchanged.
 * A regression in the ordering or the "only include what exists" filter would make playback silently
 * try a missing binary first (or emit a command for a tool that is not installed).
 */
describe("playerCommandsFor", () => {
	const noTools: PlayerLookup = { which: () => null, ffmpeg: () => null };

	it("uses afplay on darwin", () => {
		expect(playerCommandsFor("darwin", "/clip.wav", noTools)).toEqual([{ cmd: "afplay", args: ["/clip.wav"] }]);
	});

	it("uses a single PowerShell SoundPlayer command on win32 with the path embedded", () => {
		expect(playerCommandsFor("win32", "/clip.wav", noTools)).toEqual([
			{
				cmd: "powershell",
				args: ["-NoProfile", "-Command", "(New-Object Media.SoundPlayer '/clip.wav').PlaySync()"],
			},
		]);
	});

	it("builds the full POSIX chain in order when every tool is present", () => {
		const which = (bin: string): string | null =>
			bin === "paplay" ? "/usr/bin/paplay" : bin === "aplay" ? "/usr/bin/aplay" : null;
		expect(playerCommandsFor("linux", "/clip.wav", { which, ffmpeg: () => "/usr/bin/ffmpeg" })).toEqual([
			{ cmd: "/usr/bin/paplay", args: ["/clip.wav"] },
			{ cmd: "/usr/bin/aplay", args: ["/clip.wav"] },
			{
				cmd: "/usr/bin/ffmpeg",
				args: ["-loglevel", "error", "-nostdin", "-i", "/clip.wav", "-f", "pulse", "default"],
			},
			{
				cmd: "/usr/bin/ffmpeg",
				args: ["-loglevel", "error", "-nostdin", "-i", "/clip.wav", "-f", "alsa", "default"],
			},
		]);
	});

	it("returns an empty list on POSIX when no playback tool is available", () => {
		expect(playerCommandsFor("linux", "/clip.wav", noTools)).toEqual([]);
	});

	it("includes only the tools the lookup reports as present (ffmpeg-only)", () => {
		expect(playerCommandsFor("linux", "/clip.wav", { which: () => null, ffmpeg: () => "/ff" })).toEqual([
			{ cmd: "/ff", args: ["-loglevel", "error", "-nostdin", "-i", "/clip.wav", "-f", "pulse", "default"] },
			{ cmd: "/ff", args: ["-loglevel", "error", "-nostdin", "-i", "/clip.wav", "-f", "alsa", "default"] },
		]);
	});
});
