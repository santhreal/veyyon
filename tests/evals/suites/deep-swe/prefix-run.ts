/**
 * Multi-session prefix mass aggregation across a DeepSWE run and conversation collapse detection.
 *
 * Traverses a run's `jobs/` directory, folds per-session transcripts into run-level
 * prefix mass and observations, and guards against collapsed treatment arms.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import type { TokenMix } from "./cost-model";
import { CAP_SWEEP, type CapSweepPoint, simulateToolResultCap } from "./lever-simulation";
import { type PrefixObservation, prefixObservations } from "./prefix-calibration";
import {
	accumulatePrefixMass,
	emptyPrefixMass,
	type PrefixMass,
	sessionPrefixSteps,
	type TranscriptRecord,
	totalPrefixMass,
} from "./prefix-mass";

/**
 * Conversation mass per session (prefix mass excluding the fixed system prompt),
 * divided by the session count.
 */
export function conversationMassPerSession(mass: PrefixMass, sessions: number): number {
	if (sessions <= 0) return 0;
	return (totalPrefixMass(mass) - mass.system) / sessions;
}

/** Below this share of the baseline's conversation mass, a treatment arm did not really run. */
export const COLLAPSED_CONVERSATION_SHARE = 0.1;

/**
 * Whether a treatment arm's sessions are too empty to compare compositions with.
 *
 * Refuses an arm whose trials died at startup to avoid misrepresenting startup failures
 * as 100% savings.
 */
export function conversationCollapsed(
	baselineMass: PrefixMass,
	baselineSessions: number,
	treatedMass: PrefixMass,
	treatedSessions: number,
): boolean {
	const reference = conversationMassPerSession(baselineMass, baselineSessions);
	if (reference <= 0) return false;
	return conversationMassPerSession(treatedMass, treatedSessions) < reference * COLLAPSED_CONVERSATION_SHARE;
}

/**
 * Fold every session under a run's `jobs/` directory into one prefix mass, and
 * accumulate usage and observations across sessions.
 */
export function measureRunPrefix(
	jobsRoot: string,
	armPrefix = "baseline__",
): {
	mass: PrefixMass;
	sessions: number;
	usage: TokenMix;
	caps: Map<number, CapSweepPoint>;
	observations: PrefixObservation[];
	perSession: TranscriptRecord[][];
} {
	let mass = emptyPrefixMass();
	let sessions = 0;
	const observations: PrefixObservation[] = [];
	const perSession: TranscriptRecord[][] = [];
	const capRemoved = new Map<number, CapSweepPoint>(
		CAP_SWEEP.map(cap => [cap, { removed: 0, spilled: 0, results: 0 }]),
	);
	const usage = { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };
	for (const jobName of fs.readdirSync(jobsRoot)) {
		if (!jobName.startsWith(armPrefix)) continue;
		const jobDir = path.join(jobsRoot, jobName);
		if (!fs.statSync(jobDir).isDirectory()) continue;
		for (const trialName of fs.readdirSync(jobDir)) {
			const sessionsDir = path.join(jobDir, trialName, "agent", "sessions");
			if (!fs.existsSync(sessionsDir)) continue;
			for (const file of fs.readdirSync(sessionsDir)) {
				if (!file.endsWith(".jsonl")) continue;
				sessions++;
				const records: TranscriptRecord[] = [];
				for (const line of fs.readFileSync(path.join(sessionsDir, file), "utf8").split("\n")) {
					if (line === "") continue;
					try {
						records.push(JSON.parse(line) as TranscriptRecord);
					} catch {
						// A truncated tail from a killed process. Skipping one line is safe;
						// failing the run would discard the entire measurement.
					}
				}
				mass = accumulatePrefixMass(sessionPrefixSteps(records), mass);
				observations.push(...prefixObservations(records));
				perSession.push(records);
				for (const cap of CAP_SWEEP) {
					const point = capRemoved.get(cap);
					const sim = simulateToolResultCap(records, cap);
					if (point) {
						point.removed += sim.removed;
						point.spilled += sim.spilled;
						point.results += sim.results;
					}
				}
				for (const record of records) {
					const u = record.message?.usage as Record<string, number> | undefined;
					if (!u) continue;
					usage.inputTokens += u.input ?? 0;
					usage.cacheReadTokens += u.cacheRead ?? 0;
					usage.cacheWriteTokens += u.cacheWrite ?? 0;
					usage.outputTokens += u.output ?? 0;
				}
			}
		}
	}
	return { mass, sessions, usage, caps: capRemoved, observations, perSession };
}
