/**
 * WHY: `veyyon setup speech` on a TTY offers a model picker for the speech-to-text model and the
 * local text-to-speech model before it installs either. The two pickers were two copies of one
 * sequence — offer, persist a known key, leave an unknown one alone, report a cancel — and now
 * share `pickSpeechModel`. This suite drives `runSetupCommand({ component: "speech" })` with the
 * picker and the cache probes stubbed at their module boundaries and pins, through the settings
 * store, what each answer from the picker leaves behind:
 *
 * - a known key is written and flushed;
 * - an unknown key (a picker row the registry no longer has) leaves the setting as it was;
 * - a cancelled picker leaves the setting as it was and the flow continues to the next component.
 *
 * Not caught: the download step itself, which is stubbed as already cached here, and the non-TTY
 * path, which never opens a picker.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { runSetupCommand } from "../../src/cli/setup-cli";
import * as picker from "../../src/cli/setup-model-picker";
import { resetSettingsForTest, Settings, settings } from "../../src/config/settings";
import * as sttDownloader from "../../src/speech/stt/downloader";
import * as ttsDownloader from "../../src/speech/tts/downloader";
import { initTheme } from "../../src/theme/theme";

const stdoutIsTty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");

function restoreProperty(target: object, key: string, descriptor: PropertyDescriptor | undefined): void {
	if (descriptor) Object.defineProperty(target, key, descriptor);
	else delete (target as Record<string, unknown>)[key];
}

describe("a setup speech pick persists only a known model", () => {
	let flushes: number;

	beforeAll(async () => {
		await initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		flushes = 0;
		spyOn(Settings.instance, "flush").mockImplementation(async () => {
			flushes += 1;
		});
		Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
		spyOn(process.stdout, "write").mockReturnValue(true);
		spyOn(console, "log").mockImplementation(() => {});
		spyOn(sttDownloader, "isSttModelCached").mockResolvedValue(true);
		spyOn(ttsDownloader, "isTtsModelCached").mockResolvedValue(true);
	});

	afterEach(() => {
		restoreProperty(process.stdout, "isTTY", stdoutIsTty);
		resetSettingsForTest();
	});

	it("writes and flushes a known key for each component, in order", async () => {
		const titles: string[] = [];
		spyOn(picker, "selectSetupModel").mockImplementation(async title => {
			titles.push(title);
			return title.startsWith("Speech-to-Text") ? "turbo" : "kokoro";
		});

		await runSetupCommand({ component: "speech", flags: {} });

		expect(titles).toEqual(["Speech-to-Text model", "Text-to-Speech model"]);
		expect(settings.get("stt.modelName")).toBe("turbo");
		expect(settings.get("tts.localModel")).toBe("kokoro");
		expect(flushes).toBe(2);
	});

	it("leaves the setting alone for an unknown key and for a cancelled picker, and still continues", async () => {
		const before = settings.get("stt.modelName");
		const titles: string[] = [];
		spyOn(picker, "selectSetupModel").mockImplementation(async title => {
			titles.push(title);
			return title.startsWith("Speech-to-Text") ? "no-such-model" : null;
		});

		await runSetupCommand({ component: "speech", flags: {} });

		expect(titles).toHaveLength(2);
		expect(settings.get("stt.modelName")).toBe(before);
		expect(settings.get("tts.localModel")).toBe("kokoro");
		expect(flushes).toBe(0);
	});
});
