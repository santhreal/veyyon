/**
 * Contract tests for formatMediaDuration, the single owner that renders a track
 * or video length. Every media scraper (Spotify, MusicBrainz, Vimeo, YouTube,
 * GitHub Actions runs) feeds its duration through this one function, so its
 * exact string is what a user reads. The interesting behavior lives at the hour
 * boundary (MM:SS switches to H:MM:SS), in the asymmetric padding (minutes are
 * bare below an hour but zero-padded at or above one, seconds always padded),
 * and in the flooring of fractional seconds.
 */
import { describe, expect, it } from "bun:test";
import { formatMediaDuration } from "@veyyon/coding-agent/web/scrapers/types";

describe("formatMediaDuration", () => {
	it("renders sub-hour lengths as M:SS with a bare minute and a padded second", () => {
		expect(formatMediaDuration(0)).toBe("0:00");
		expect(formatMediaDuration(5)).toBe("0:05");
		expect(formatMediaDuration(59)).toBe("0:59");
		expect(formatMediaDuration(90)).toBe("1:30");
		expect(formatMediaDuration(600)).toBe("10:00");
		// The minute field is not padded to two digits below an hour.
		expect(formatMediaDuration(599)).toBe("9:59");
	});

	it("switches to H:MM:SS exactly at one hour, padding minutes and seconds", () => {
		// 3599s is the last MM:SS value; 3600s is the first H:MM:SS value.
		expect(formatMediaDuration(3599)).toBe("59:59");
		expect(formatMediaDuration(3600)).toBe("1:00:00");
		expect(formatMediaDuration(3661)).toBe("1:01:01");
		expect(formatMediaDuration(7384)).toBe("2:03:04");
		// The hour field itself is bare (not padded), minute and second are padded.
		expect(formatMediaDuration(36000)).toBe("10:00:00");
	});

	it("floors fractional seconds instead of rounding", () => {
		expect(formatMediaDuration(125.7)).toBe("2:05");
		expect(formatMediaDuration(0.9)).toBe("0:00");
		expect(formatMediaDuration(3600.99)).toBe("1:00:00");
	});
});
