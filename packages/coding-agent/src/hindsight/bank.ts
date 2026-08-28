import * as path from "node:path";
import { logger } from "@veyyon/utils";
import * as git from "../utils/git";
import type { HindsightApi } from "./client";
import type { HindsightConfig } from "./config";

const DEFAULT_BANK_NAME = "veyyon";
export const PROJECT_TAG_PREFIX = "project:";
const UNKNOWN_PROJECT = "unknown";
const MISSION_SET_CAP = 10_000;

export type RecallTagsMatch = "any" | "all" | "any_strict" | "all_strict";

export interface BankScope {
	bankId: string;
	retainTags?: string[];
	recallTags?: string[];
	recallTagsMatch?: RecallTagsMatch;
}

function baseBankId(config: HindsightConfig): string {
	const base = config.bankId?.trim() || DEFAULT_BANK_NAME;
	const prefix = config.bankIdPrefix?.trim() || "";
	return prefix ? `${prefix}-${base}` : base;
}

function projectLabel(directory: string): string {
	if (!directory) return UNKNOWN_PROJECT;
	const primary = git.repo.primaryRootSync(directory);
	return path.basename(primary ?? directory) || UNKNOWN_PROJECT;
}

export function computeBankScope(config: HindsightConfig, directory: string): BankScope {
	const base = baseBankId(config);
	switch (config.scoping) {
		case "global":
			return { bankId: base };
		case "per-project":
			return { bankId: `${base}-${projectLabel(directory)}` };
		case "per-project-tagged": {
			const tag = `${PROJECT_TAG_PREFIX}${projectLabel(directory)}`;
			return {
				bankId: base,
				retainTags: [tag],
				recallTags: [tag],
				recallTagsMatch: "any",
			};
		}
	}
}

export function deriveBankId(config: HindsightConfig, directory: string): string {
	return computeBankScope(config, directory).bankId;
}

export async function ensureBankExists(
	client: HindsightApi,
	bankId: string,
	config: HindsightConfig,
	banksSet: Set<string>,
): Promise<void> {
	if (banksSet.has(bankId)) return;

	const mission = config.bankMission?.trim();
	const retainMission = config.retainMission?.trim();

	try {
		await client.createBank(bankId, {
			reflectMission: mission || undefined,
			retainMission: retainMission || undefined,
		});
		banksSet.add(bankId);
		if (banksSet.size > MISSION_SET_CAP) {
			const keys = [...banksSet].sort();
			for (const key of keys.slice(0, keys.length >> 1)) {
				banksSet.delete(key);
			}
		}
		if (config.debug) {
			logger.debug("Hindsight: ensured bank", { bankId, mission: Boolean(mission) });
		}
	} catch (err) {
		logger.debug("Hindsight: ensureBankExists failed", { bankId, error: String(err) });
	}
}
