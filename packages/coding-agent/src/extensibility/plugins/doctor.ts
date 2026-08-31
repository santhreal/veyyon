import { $which } from "@veyyon/utils";
import { theme } from "../../modes/theme/theme";
// `session/auth-broker-config`, which OWNS this, not the `sdk` barrel that re-exports it: the barrel is
// the whole application and this file wants one function.
import { discoverAuthStorage } from "../../session/auth-broker-config";
import type { DoctorCheck } from "./types";

export async function runDoctorChecks(): Promise<DoctorCheck[]> {
	const checks: DoctorCheck[] = [];

	// 1. Tools veyyon shells out to. `vey` and `veyyon` used to be checked here as
	// well, by looking their names up on PATH and reporting "Found at <path>".
	// `runInstallHealthChecks` now answers that question properly — it RUNS the
	// binary — and running both printed the same two names twice with the weaker
	// answer second. One owner: the install checks own veyyon's own commands, this
	// owns the third-party tools.
	const binaries = [{ name: "git", description: "Version control" }];

	for (const bin of binaries) {
		const path = $which(bin.name);
		checks.push({
			name: bin.name,
			status: path ? "ok" : "error",
			message: path ? `Found at ${path}` : `${bin.description} not found on PATH`,
		});
	}

	// 2. Check provider authentication (OAuth storage + Env API keys)
	try {
		const authStorage = await discoverAuthStorage();
		const providers = [
			{ id: "google-antigravity", name: "Google Antigravity OAuth", envKey: "GEMINI_API_KEY" },
			{ id: "openai-codex", name: "OpenAI Codex OAuth", envKey: "OPENAI_API_KEY" },
			{ id: "anthropic", name: "Anthropic API", envKey: "ANTHROPIC_API_KEY" },
			{ id: "kimi-code", name: "Kimi Code OAuth", envKey: "KIMI_API_KEY" },
		];

		for (const provider of providers) {
			const hasOAuth = authStorage ? await authStorage.getOAuthAccess(provider.id) : null;
			const hasEnvKey = !!Bun.env[provider.envKey];
			const isAuth = !!hasOAuth || hasEnvKey;
			checks.push({
				name: provider.name,
				status: isAuth ? "ok" : "warning",
				message: isAuth
					? hasOAuth
						? "Authenticated via OAuth"
						: `Configured via $${provider.envKey}`
					: `Not signed in (run 'vey setup' or set $${provider.envKey})`,
			});
		}
	} catch {
		checks.push({
			name: "Auth Storage",
			status: "warning",
			message: "Could not read auth storage database",
		});
	}

	return checks;
}

/** `1 warning`, `2 warnings`. The summary line read "1 warnings" for a year. */
function count(n: number, noun: string): string {
	return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

export function formatDoctorResults(checks: DoctorCheck[]): string {
	// Note: This function returns plain text without theming as it may be called outside TUI context.
	// For TUI usage, the plugin CLI handler applies theme colors.
	const lines: string[] = ["System health", ""];

	for (const check of checks) {
		const icon =
			check.status === "ok"
				? theme.status.enabled
				: check.status === "warning"
					? theme.status.warning
					: theme.status.error;
		lines.push(`${icon} ${check.name}: ${check.message}`);
	}

	const errors = checks.filter(c => c.status === "error").length;
	const warnings = checks.filter(c => c.status === "warning").length;
	const ok = checks.length - errors - warnings;

	lines.push("");
	// The verdict, not a tally. "13 ok, 1 warnings, 0 errors" made the reader do
	// the arithmetic to find out whether anything was actually wrong, and the
	// counts that are zero are the ones nobody needs to read.
	if (errors > 0) {
		lines.push(`${count(errors, "check")} failed. ${count(ok, "check")} passed.`);
	} else if (warnings > 0) {
		lines.push(`Everything works. ${count(warnings, "warning")} worth reading.`);
	} else {
		lines.push(`Everything works. ${count(ok, "check")} passed.`);
	}

	return lines.join("\n");
}
