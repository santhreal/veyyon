/**
 * Client-side type definitions.
 *
 * Shared shapes (aggregations, time-series, dashboard payloads) live in
 * `../shared-types` and are re-exported here. The types declared inline below
 * are deliberately client-only because:
 *   - `Usage` is redeclared locally so the client bundle avoids importing
 *     `@veyyon/ai` (the server-side AI types package).
 *   - `MessageStats.stopReason` is widened from the server's `StopReason`
 *     enum to `string`, again to keep the client free of pi-ai types.
 *   - `TimeRange`, `OverviewStats`, `ModelDashboardStats`,
 *     `CostDashboardStats` are UI-only view shapes the server never produces.
 */

import type {
	AgentTypeStats,
	AggregatedStats,
	CostTimeSeriesPoint,
	ModelPerformancePoint,
	ModelStats,
	ModelTimeSeriesPoint,
	TimeSeriesPoint,
} from "../shared-types";

export * from "../shared-types";

/**
 * Token accounting, owned by `@veyyon/catalog` because that is where the writer declares it.
 *
 * This module used to declare its own `Usage` with the same five required counters, the same
 * `cost` object, and nothing else. That was not a harmless copy: sessions are written against the
 * catalog type, so the fields it omitted (`orchestration`, `reasoningTokens`, `cttl`, `server`)
 * were present in the data and invisible to every stats reader, and a `Usage` read here could not
 * be handed to catalog-typed code without the compiler picking one of the two by whichever import
 * the editor offered.
 *
 * Imported as well as re-exported: a bare `export type { Usage } from ...` publishes the name
 * without binding it locally, so `MessageStats.usage` below had no type at all and the package
 * stopped type-checking.
 */
import type { Usage } from "@veyyon/catalog";

export type { Usage };

export interface MessageStats {
	id?: number;
	sessionFile: string;
	entryId: string;
	folder: string;
	model: string;
	provider: string;
	api: string;
	timestamp: number;
	duration: number | null;
	ttft: number | null;
	stopReason: string;
	errorMessage: string | null;
	usage: Usage;
}

export interface RequestDetails extends MessageStats {
	messages: unknown[];
	output: unknown;
}

export type TimeRange = "1h" | "24h" | "7d" | "30d" | "90d" | "all";

export interface OverviewStats {
	overall: AggregatedStats;
	byAgentType: AgentTypeStats[];
	timeSeries: TimeSeriesPoint[];
}

export interface ModelDashboardStats {
	byModel: ModelStats[];
	modelSeries: ModelTimeSeriesPoint[];
	modelPerformanceSeries: ModelPerformancePoint[];
}

export interface CostDashboardStats {
	costSeries: CostTimeSeriesPoint[];
}
