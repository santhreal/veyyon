import { $which } from "@veyyon/utils";
import { theme } from "../../modes/theme/theme";
import { discoverAuthStorage } from "../../sdk";
import type { DoctorCheck } from "./types";

export async function runDoctorChecks(): Promise<DoctorCheck[]> {
	const checks: DoctorCheck[] = [];

	// 1. Check core CLI binaries on PATH
	const binaries = [
		{ name: "vey", description: "Veyyon CLI alias" },
		{ name: "veyyon", description: "Veyyon binary" },
		{ name: "git", description: "Version control" },
	];

	for (const bin of binaries) {
		const path = $which(bin.name);
		checks.push({
			name: bin.name,
			status: path ? "ok" : bin.name === "git" ? "error" : "warning",
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

export function formatDoctorResults(checks: DoctorCheck[]): string {
	// Note: This function returns plain text without theming as it may be called outside TUI context.
	// For TUI usage, the plugin CLI handler applies theme colors.
	const lines: string[] = ["System Health Check", "=".repeat(40), ""];

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

	lines.push("");
	lines.push(`Summary: ${checks.length - errors - warnings} ok, ${warnings} warnings, ${errors} errors`);

	return lines.join("\n");
}
