export * from "./advise-tool";
export * from "./config";
export * from "./emission-guard";
export * from "./runtime";
export * from "./transcript-recorder";
export * from "./watchdog";

/** Advisor/watchdog is part of the product surface (kept; not trimmed). */
export function isAdvisorProductEnabled(): boolean {
	return true;
}
