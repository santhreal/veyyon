/**
 * WHY: validating a persisted Linux AVX2 verdict collected per-CPU statistics
 * and read cache metadata before the first native text operation. Linux has a
 * direct feature probe, so native loading must use current flags and leave old
 * verdict files unchanged. The real loader runs in an isolated child process;
 * its selected variant is the value inherited by subsequent workers.
 * This covers absent, agreeing, conflicting, and malformed disk state. CPU
 * feature classification and non-Linux persistence have separate suites; this
 * suite does not emulate another CPU or execute unsupported instructions.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { classifyAvx2Support, hostCpuIdentity, writeHostVariantVerdict } from "../native/loader-state.js";

const fixture = fileURLToPath(new URL("./fixtures/linux-live-native-flags.ts", import.meta.url));
const states = ["absent", "supported", "unsupported", "malformed"] as const;

describe.skipIf(process.platform !== "linux" || process.arch !== "x64")(
	"Linux native selection uses current CPU flags",
	() => {
		test.each([...states])(
			"loads the current native variant with %s persisted state",
			state => {
				const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-live-flags-"));
				try {
					const nativeRoot = path.join(root, ".veyyon", "natives");
					const cacheFile = path.join(nativeRoot, "host-variant.json");
					fs.mkdirSync(nativeRoot, { recursive: true });
					if (state === "malformed") fs.writeFileSync(cacheFile, "not a variant verdict\n");
					else if (state !== "absent") {
						const cpuIdentity = hostCpuIdentity();
						expect(cpuIdentity).not.toBeNull();
						writeHostVariantVerdict(nativeRoot, state, {
							platform: "linux",
							arch: "x64",
							cpuIdentity: cpuIdentity!,
						});
					}
					const before = state === "absent" ? null : fs.readFileSync(cacheFile, "utf8");
					const current = classifyAvx2Support({
						platform: "linux",
						arch: "x64",
						readCpuInfo: () => fs.readFileSync("/proc/cpuinfo", "utf8"),
						runCommand: () => {
							throw new Error("Linux feature selection must not spawn a probe");
						},
					});
					expect(current).not.toBe("unknown");
					const env: NodeJS.ProcessEnv = { ...process.env, HOME: root, XDG_DATA_HOME: path.join(root, "data") };
					delete env.__PI_NATIVE_VARIANT_CACHE;
					delete env.VEYYON_NATIVE_VARIANT;
					delete env.VEYYON_TRIAL_ADDON_PATH;
					const child = spawnSync(process.execPath, [fixture], {
						env,
						encoding: "utf8",
						timeout: 10_000,
						maxBuffer: 1024 * 1024,
					});
					expect(child.error).toBeUndefined();
					expect(child.signal).toBeNull();
					expect(child.status, child.stderr).toBe(0);
					expect(JSON.parse(child.stdout)).toEqual({
						variant: current === "supported" ? "modern" : "baseline",
						lines: ["alpha beta", "gamma"],
					});
					if (before === null) expect(fs.existsSync(cacheFile)).toBe(false);
					else expect(fs.readFileSync(cacheFile, "utf8")).toBe(before);
				} finally {
					fs.rmSync(root, { recursive: true, force: true });
				}
			},
			15_000,
		);
	},
);
