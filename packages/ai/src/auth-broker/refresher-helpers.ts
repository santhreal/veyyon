import type { AuthStorage } from "../auth-storage";

export interface AuthBrokerRefresherOptions {
	storage: AuthStorage;
	refreshSkewMs?: number;
	refreshIntervalMs?: number;
	now?: () => number;
}

export interface AuthBrokerRefresherSchedule {
	enabled: boolean;
	intervalMs: number;
	skewMs: number;
	nextSweepAt: number;
}
