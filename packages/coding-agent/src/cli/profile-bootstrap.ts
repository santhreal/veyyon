import { isSubcommand } from "../cli-commands";
import {
	EXTENSION_SHADOWABLE_STRING_FLAGS,
	isUnknownLongValueCandidate,
	OPTIONAL_FLAGS,
	OPTIONAL_VALUE_FLAGS,
	PROFILE_BOOTSTRAP_BOUNDARY_ARG,
	STRING_VALUE_FLAGS,
} from "./flag-tables";
import { CliUsageError } from "./usage-error";

function isProfileBootstrapSubcommand(arg: string): boolean {
	return arg === "launch" || arg === "acp";
}

function needsBoundaryAfterGlobalStrip(stripped: readonly string[]): boolean {
	const previous = stripped[stripped.length - 1];
	return (
		previous !== undefined &&
		(OPTIONAL_VALUE_FLAGS.has(previous) ||
			EXTENSION_SHADOWABLE_STRING_FLAGS.has(previous) ||
			isUnknownLongValueCandidate(previous))
	);
}

export interface ProfileBootstrapResult {
	argv: string[];
	profile?: string;
	aliasName?: string;
}

export function extractProfileFlags(argv: readonly string[]): ProfileBootstrapResult {
	const stripped: string[] = [];
	let profile: string | undefined;
	let aliasName: string | undefined;
	let passThrough = false;
	let sawSubcommand = false;
	let canDispatchSubcommand = true;
	let insertBoundaryBeforeNextValue = false;
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];

		if (passThrough || sawSubcommand) {
			stripped.push(arg);
			continue;
		}

		if (insertBoundaryBeforeNextValue) {
			if (!arg.startsWith("-")) {
				stripped.push(PROFILE_BOOTSTRAP_BOUNDARY_ARG);
			}
			insertBoundaryBeforeNextValue = false;
		}

		if (arg === "--") {
			passThrough = true;
			stripped.push(arg);
			continue;
		}

		if (arg === "--profile") {
			const value = argv[index + 1];
			if (!value || value.startsWith("-")) {
				throw new CliUsageError("--profile requires a profile name");
			}
			profile = value;
			insertBoundaryBeforeNextValue = needsBoundaryAfterGlobalStrip(stripped);
			index += 1;
			continue;
		}
		if (arg.startsWith("--profile=")) {
			const value = arg.slice("--profile=".length);
			if (!value) {
				throw new CliUsageError("--profile requires a profile name");
			}
			profile = value;
			insertBoundaryBeforeNextValue = needsBoundaryAfterGlobalStrip(stripped);
			continue;
		}
		if (arg === "--alias") {
			const value = argv[index + 1];
			if (!value || value.startsWith("-")) {
				throw new CliUsageError("--alias requires a command name");
			}
			aliasName = value;
			insertBoundaryBeforeNextValue = needsBoundaryAfterGlobalStrip(stripped);
			index += 1;
			continue;
		}
		if (arg.startsWith("--alias=")) {
			const value = arg.slice("--alias=".length);
			if (!value) {
				throw new CliUsageError("--alias requires a command name");
			}
			aliasName = value;
			insertBoundaryBeforeNextValue = needsBoundaryAfterGlobalStrip(stripped);
			continue;
		}

		if (EXTENSION_SHADOWABLE_STRING_FLAGS.has(arg)) {
			canDispatchSubcommand = false;
			stripped.push(arg);
			const next = argv[index + 1];
			if (next !== undefined && !next.startsWith("-")) {
				stripped.push(next);
				index += 1;
			}
			continue;
		}

		if (STRING_VALUE_FLAGS.has(arg)) {
			canDispatchSubcommand = false;
			stripped.push(arg);
			if (index + 1 < argv.length) {
				stripped.push(argv[index + 1]);
				index += 1;
			}
			continue;
		}

		if (OPTIONAL_VALUE_FLAGS.has(arg)) {
			canDispatchSubcommand = false;
			stripped.push(arg);
			const config = OPTIONAL_FLAGS[arg];
			const next = argv[index + 1];
			if (next !== undefined && !next.startsWith("-") && !(config.rejectEmpty === true && next.length === 0)) {
				stripped.push(next);
				index += 1;
			}
			continue;
		}

		if (isUnknownLongValueCandidate(arg)) {
			canDispatchSubcommand = false;
			stripped.push(arg);
			const next = argv[index + 1];
			if (next !== undefined && !next.startsWith("-")) {
				stripped.push(next);
				index += 1;
			}
			continue;
		}

		if (canDispatchSubcommand && isSubcommand(arg) && !isProfileBootstrapSubcommand(arg)) {
			sawSubcommand = true;
		}
		canDispatchSubcommand = false;
		stripped.push(arg);
	}

	return { argv: stripped, profile, aliasName };
}
