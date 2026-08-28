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
