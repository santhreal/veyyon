/**
 * WHY: saving one setting used to be able to delete an operator's entire config.
 *
 * The save path re-reads `config.yml` under a lock so an external edit survives,
 * then hands the result to the YAML writer. The writer treats that object as the
 * authority: any key present in the file and absent from the object is deleted.
 * The loader answered a failed read with `{}`, which is indistinguishable from an
 * empty config, so a read that failed for any reason other than the file being
 * absent turned the very next `set()` into "delete every key in this file".
 *
 * The window is small but it is exactly the window an update opens: the agent
 * directory is being rewritten underneath a running session, one read returns
 * EACCES or EIO, and the debounced save that follows lands on a file that reads
 * fine again. Unlike a parse failure, a read failure is never quarantined, so
 * there is no preserved copy to recover from afterwards.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "../../src/config/settings";

const CONFIG = `# the operator wrote this comment
theme:
  dark: dracula
tools:
  approvalMode: manual
`;

afterEach(() => {
	vi.restoreAllMocks();
	resetSettingsForTest();
});

async function agentDirWithConfig(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-config-save-"));
	await fs.writeFile(path.join(dir, "config.yml"), CONFIG, "utf8");
	return dir;
}

/**
 * Fail the next `.text()` on `target` exactly once, then behave normally. This
 * is the transient: the file is readable before and after, so nothing else in
 * the run is disturbed and the writer's own read still succeeds.
 */
function failOneReadOf(target: string): void {
	const real = Bun.file.bind(Bun);
	let armed = true;
	// `Bun.file` is overloaded (path, bytes, file descriptor), and one arrow cannot
	// express three call signatures, so the implementation is asserted back to it.
	const spied = (source: string | URL, options?: BlobPropertyBag) => {
		const handle = real(source, options);
		if (source !== target || !armed) return handle;
		armed = false;
		return new Proxy(handle, {
			get(file, prop, receiver) {
				if (prop !== "text") return Reflect.get(file, prop, receiver);
				return () => Promise.reject(Object.assign(new Error("EIO: i/o error"), { code: "EIO" }));
			},
		});
	};
	vi.spyOn(Bun, "file").mockImplementation(spied as unknown as typeof Bun.file);
}

describe("a config save whose re-read failed", () => {
	it("leaves every key the operator wrote on disk", async () => {
		const dir = await agentDirWithConfig();
		const configPath = path.join(dir, "config.yml");
		const settings = await Settings.init({ agentDir: dir });

		failOneReadOf(configPath);
		settings.set("display.smoothStreaming", false);
		await settings.flush();

		const onDisk = await fs.readFile(configPath, "utf8");
		expect(onDisk).toContain("dark: dracula");
		expect(onDisk).toContain("approvalMode: manual");
		expect(onDisk).toContain("# the operator wrote this comment");
	});

	/**
	 * The save has to FAIL, not quietly skip: the path stays queued so the retry
	 * writes it once the file reads again. A save that reported success while
	 * dropping the write is the same defect wearing a better log line.
	 */
	it("keeps the setting pending so the next save still writes it", async () => {
		const dir = await agentDirWithConfig();
		const configPath = path.join(dir, "config.yml");
		const settings = await Settings.init({ agentDir: dir });

		failOneReadOf(configPath);
		settings.set("display.smoothStreaming", false);
		await settings.flush();

		expect(await fs.readFile(configPath, "utf8")).not.toContain("smoothStreaming");

		await settings.flush();

		const recovered = await fs.readFile(configPath, "utf8");
		expect(recovered).toContain("smoothStreaming: false");
		expect(recovered).toContain("dark: dracula");
	});

	/**
	 * A clean read still writes normally. Without this the fix could "pass" by
	 * refusing every save.
	 */
	it("writes normally when the re-read succeeds", async () => {
		const dir = await agentDirWithConfig();
		const configPath = path.join(dir, "config.yml");
		const settings = await Settings.init({ agentDir: dir });

		settings.set("display.smoothStreaming", false);
		await settings.flush();

		const onDisk = await fs.readFile(configPath, "utf8");
		expect(onDisk).toContain("smoothStreaming: false");
		expect(onDisk).toContain("dark: dracula");
		expect(onDisk).toContain("# the operator wrote this comment");
	});
});
