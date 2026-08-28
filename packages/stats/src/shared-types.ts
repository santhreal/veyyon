/** Shared type definitions consumed by both server-side stats and client bundle. */

/** Aggregated stats for a model or folder. */
export interface AggregatedStats {
	totalRequests: number;
	successfulRequests: number;
	failedRequests: number;
	errorRate: number;
	totalInputTokens: number;
	totalOutputTokens: number;
	totalCacheReadTokens: number;
	totalCacheWriteTokens: number;
	cacheRate: number;
	totalCost: number;
	totalPremiumRequests: number;
	avgDuration: number | null;
	avgTtft: number | null;
	avgTokensPerSecond: number | null;
	firstTimestamp: number;
	lastTimestamp: number;
}

/** Stats grouped by model. */
export interface ModelStats extends AggregatedStats {
	model: string;
	provider: string;
}

/** Stats grouped by folder. */
export interface FolderStats extends AggregatedStats {
	folder: string;
}

/** Time series data point. */
export interface TimeSeriesPoint {
	timestamp: number;
	requests: number;
	errors: number;
	tokens: number;
	cost: number;
}

/** Model usage time series data point (daily buckets). */
export interface ModelTimeSeriesPoint {
	timestamp: number;
	model: string;
	provider: string;
	requests: number;
}

/** Model performance time series data point (daily buckets). */
export interface ModelPerformancePoint {
	timestamp: number;
	model: string;
	provider: string;
	requests: number;
	avgTtft: number | null;
	avgTokensPerSecond: number | null;
}

/** Cost time series data point (daily buckets). */
export interface CostTimeSeriesPoint {
	timestamp: number;
	model: string;
	provider: string;
	cost: number;
	costInput: number;
	costOutput: number;
	costCacheRead: number;
	costCacheWrite: number;
	requests: number;
}

/** Overall dashboard stats. */
export interface DashboardStats {
	overall: AggregatedStats;
	byModel: ModelStats[];
	byFolder: FolderStats[];
	byAgentType: AgentTypeStats[];
	timeSeries: TimeSeriesPoint[];
	modelSeries: ModelTimeSeriesPoint[];
	modelPerformanceSeries: ModelPerformancePoint[];
	costSeries: CostTimeSeriesPoint[];
}

/** Source agent type. */
export type AgentType = "main" | "subagent" | "advisor";

/** Token usage aggregated by AgentType. */
export interface AgentTypeStats {
	agentType: AgentType;
	totalRequests: number;
	totalInputTokens: number;
	totalOutputTokens: number;
	totalCacheReadTokens: number;
	totalCacheWriteTokens: number;
	totalCost: number;
}

/** Behavior time-series point. */
export interface BehaviorTimeSeriesPoint {
	timestamp: number;
	model: string;
	provider: string;
	messages: number;
	yelling: number;
	profanity: number;
	anguish: number;
	negation: number;
	repetition: number;
	blame: number;
	chars: number;
}

export interface BehaviorOverallStats {
	totalMessages: number;
	totalYelling: number;
	totalProfanity: number;
	totalAnguish: number;
	totalNegation: number;
	totalRepetition: number;
	totalBlame: number;
	totalChars: number;
	firstTimestamp: number;
	lastTimestamp: number;
}

/** Per-model behavioral aggregate over active range. */
export interface BehaviorModelStats {
	model: string;
	provider: string;
	totalMessages: number;
	totalYelling: number;
	totalProfanity: number;
	totalAnguish: number;
	totalNegation: number;
	totalRepetition: number;
	totalBlame: number;
	totalChars: number;
	lastTimestamp: number;
}

export interface BehaviorDashboardStats {
	overall: BehaviorOverallStats;
	byModel: BehaviorModelStats[];
	behaviorSeries: BehaviorTimeSeriesPoint[];
}

/** Aggregated usage for a single tool over active range. */
export interface ToolUsageStats {
	tool: string;
	calls: number;
	errors: number;
	argsChars: number;
	resultChars: number;
	totalTokensShare: number;
	outputTokensShare: number;
	costShare: number;
	lastUsed: number;
}

/** Per-(tool, model) breakdown with the same attribution as {@link ToolUsageStats}. */
export interface ToolModelStats extends ToolUsageStats {
	model: string;
	provider: string;
}

/** Tool-call time-series point (one bucket per tool). */
export interface ToolTimeSeriesPoint {
	timestamp: number;
	tool: string;
	calls: number;
	errors: number;
}

/** Complete tools dashboard payload. */
export interface ToolDashboardStats {
	byTool: ToolUsageStats[];
	byToolModel: ToolModelStats[];
	series: ToolTimeSeriesPoint[];
}
