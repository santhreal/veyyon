import { $which } from "@veyyon/utils";
import { theme } from "../../modes/theme/theme";
import { discoverAuthStorage } from "../../session/auth-broker-config";
import type { DoctorCheck } from "./types";

export async function runDoctorChecks(): Promise<DoctorCheck[]> {
	const checks: DoctorCheck[] = [];

	const binaries = [{ name: "git", description: "Version control" }];

	for (const bin of binaries) {
		const path = $which(bin.name);
		checks.push({
			name: bin.name,
			status: path ? "ok" : "error",
			message: path ? `Found at ${path}` : `${bin.description} not found on PATH`,
		});
	}

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

function count(n: number, noun: string): string {
	return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

export function formatDoctorResults(checks: DoctorCheck[]): string {
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
	if (errors > 0) {
		lines.push(`${count(errors, "check")} failed. ${count(ok, "check")} passed.`);
	} else if (warnings > 0) {
		lines.push(`Everything works. ${count(warnings, "warning")} worth reading.`);
	} else {
		lines.push(`Everything works. ${count(ok, "check")} passed.`);
	}

	return lines.join("\n");
}
