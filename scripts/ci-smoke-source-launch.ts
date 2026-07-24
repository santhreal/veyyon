/**
 * Source-install launch smoke: run the REAL source launcher
 * (packages/coding-agent/scripts/veyyon) under a PTY, the way a source-install
 * user launches veyyon.
 *
 * Why this exists: `ci:test:smoke`'s other legs run `bun src/cli.ts` directly,
 * which never exercises the launcher script, PTY-only boot paths, or the
 * missing-gitignored-artifact state of a fresh checkout. Exactly that gap
 * shipped a launch-dead source install (2026-07-24: tool-views.generated.js is
 * resolved at module parse time; every fresh clone or bare `git pull` crashed
 * at boot with a raw ResolveMessage). The launcher now self-heals the artifact;
 * this smoke proves it on the runner's fresh checkout — the artifact is
 * REMOVED first so the heal path itself is what runs, not a leftover file.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");
const launcher = path.join(repoRoot, "packages", "coding-agent", "scripts", "veyyon");
const artifact = path.join(repoRoot, "packages", "coding-agent", "src", "export", "html", "tool-views.generated.js");

if (process.platform === "win32") {
	console.log("source-launch smoke: skipped on Windows (POSIX launcher + `script` PTY wrapper)");
	process.exit(0);
}

// Force the self-heal path: a leftover artifact would make this smoke pass
// without proving anything about a fresh checkout.
await fs.rm(artifact, { force: true });

// `script -qec` allocates a PTY, so the launch takes the same interactive boot
// path a user's terminal does (a plain pipe exercises the non-TTY fallthrough,
// a different and already-covered path).
const proc = Bun.spawn(["script", "-qec", `${launcher} --version`, "/dev/null"], {
	cwd: repoRoot,
	stdout: "pipe",
	stderr: "pipe",
});
const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
const exitCode = await proc.exited;

const versionPattern = /veyyon\/\d+\.\d+\.\d+/;
if (exitCode !== 0 || !versionPattern.test(stdout)) {
	console.error(`source-launch smoke FAILED (exit ${exitCode})`);
	console.error(`stdout:\n${stdout}`);
	console.error(`stderr:\n${stderr}`);
	process.exit(1);
}
try {
	await fs.access(artifact);
} catch {
	console.error("source-launch smoke FAILED: launcher booted but did not regenerate tool-views.generated.js");
	process.exit(1);
}
console.log(
	`source-launch smoke OK: ${versionPattern.exec(stdout)?.[0]} booted from the launcher under a PTY, artifact regenerated`,
);
