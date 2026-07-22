import { describe, expect, it } from "bun:test";
import { type StreamingPlayerLookup, streamingPlayerCommandsFor } from "@veyyon/coding-agent/tts/streaming-player";

/**
 * streamingPlayerCommandsFor builds the ordered list of raw-PCM player commands the
 * streaming TTS player tries per platform. It has an injectable which()/ffmpeg() seam,
 * so it is fully deterministic, yet it was untested. The contract matters: every command
 * must read 32-bit float LE mono PCM from stdin at the right rate, the fallback order is
 * fixed (ffmpeg first, then the OS raw players), an EMPTY list is the signal to fall back
 * to per-file playback (so a missing backend must not silently produce a broken command),
 * and Windows has no streaming backend at all. A regression in the argv would play noise
 * (wrong sample format/rate) or silently drop audio.
 */

const INPUT = ["-loglevel", "error", "-nostdin", "-f", "f32le", "-ar", "24000", "-ac", "1", "-i", "pipe:0"];
const allTools: StreamingPlayerLookup = { which: bin => `/usr/bin/${bin}`, ffmpeg: () => "/usr/bin/ffmpeg" };
const noTools: StreamingPlayerLookup = { which: () => null, ffmpeg: () => null };
const ffmpegOnly = (bin: string): StreamingPlayerLookup => ({ which: () => null, ffmpeg: () => bin });

describe("streamingPlayerCommandsFor linux", () => {
	it("orders ffmpeg (pulse, then alsa) before paplay and aplay", () => {
		expect(streamingPlayerCommandsFor("linux", 24_000, allTools)).toEqual([
			{ cmd: "/usr/bin/ffmpeg", args: [...INPUT, "-f", "pulse", "default"] },
			{ cmd: "/usr/bin/ffmpeg", args: [...INPUT, "-f", "alsa", "default"] },
			{ cmd: "/usr/bin/paplay", args: ["--raw", "--rate=24000", "--format=float32le", "--channels=1"] },
			{ cmd: "/usr/bin/aplay", args: ["-q", "-f", "FLOAT_LE", "-r", "24000", "-c", "1", "-"] },
		]);
	});

	it("returns an empty list (file-playback fallback signal) when no backend is present", () => {
		expect(streamingPlayerCommandsFor("linux", 24_000, noTools)).toEqual([]);
	});

	it("emits only the ffmpeg commands when only ffmpeg is present", () => {
		expect(streamingPlayerCommandsFor("linux", 16_000, ffmpegOnly("/ff"))).toEqual([
			{
				cmd: "/ff",
				args: [
					"-loglevel",
					"error",
					"-nostdin",
					"-f",
					"f32le",
					"-ar",
					"16000",
					"-ac",
					"1",
					"-i",
					"pipe:0",
					"-f",
					"pulse",
					"default",
				],
			},
			{
				cmd: "/ff",
				args: [
					"-loglevel",
					"error",
					"-nostdin",
					"-f",
					"f32le",
					"-ar",
					"16000",
					"-ac",
					"1",
					"-i",
					"pipe:0",
					"-f",
					"alsa",
					"default",
				],
			},
		]);
	});
});

describe("streamingPlayerCommandsFor darwin", () => {
	it("orders ffmpeg (audiotoolbox) before sox play", () => {
		expect(streamingPlayerCommandsFor("darwin", 24_000, allTools)).toEqual([
			{ cmd: "/usr/bin/ffmpeg", args: [...INPUT, "-f", "audiotoolbox", "default"] },
			{
				cmd: "/usr/bin/play",
				args: ["-q", "-t", "raw", "-e", "floating-point", "-b", "32", "-r", "24000", "-c", "1", "-"],
			},
		]);
	});
});

describe("streamingPlayerCommandsFor win32", () => {
	it("has no streaming backend even when every tool is present", () => {
		expect(streamingPlayerCommandsFor("win32", 24_000, allTools)).toEqual([]);
	});
});

describe("streamingPlayerCommandsFor sample rate", () => {
	it("falls back to the 24 kHz default for a non-positive rate", () => {
		const rateOf = (cmds: ReturnType<typeof streamingPlayerCommandsFor>): string =>
			cmds[0]!.args[cmds[0]!.args.indexOf("-ar") + 1]!;
		expect(rateOf(streamingPlayerCommandsFor("linux", 0, ffmpegOnly("/ff")))).toBe("24000");
		expect(rateOf(streamingPlayerCommandsFor("linux", -5, ffmpegOnly("/ff")))).toBe("24000");
		expect(rateOf(streamingPlayerCommandsFor("linux", 48_000, ffmpegOnly("/ff")))).toBe("48000");
	});
});
