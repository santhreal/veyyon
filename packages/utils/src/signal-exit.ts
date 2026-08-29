import * as os from "node:os";

export const SIGNAL_EXIT_BASE = 128;

const SIGNAL_NUMBERS = os.constants.signals as unknown as Record<string, number | undefined>;

export function signalNumber(name: string): number | undefined {
	const upper = name.trim().toUpperCase();
	if (upper.length === 0) return undefined;
	const prefixed = upper.startsWith("SIG") ? upper : `SIG${upper}`;
	return SIGNAL_NUMBERS[prefixed];
}

function signalExitCode(name: string): number | undefined {
	const number = signalNumber(name);
	return number === undefined ? undefined : SIGNAL_EXIT_BASE + number;
}

export function signalName(number: number): string | undefined {
	for (const [name, value] of Object.entries(SIGNAL_NUMBERS)) {
		if (value === number) return name;
	}
	return undefined;
}
