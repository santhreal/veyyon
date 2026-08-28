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

export interface ModelStats extends AggregatedStats {
	model: string;
	provider: string;
}

export interface FolderStats extends AggregatedStats {
	folder: string;
}

export interface TimeSeriesPoint {
	timestamp: number;
	requests: number;
	errors: number;
	tokens: number;
	cost: number;
}

export interface ModelTimeSeriesPoint {
	timestamp: number;
	model: string;
	provider: string;
	requests: number;
}

export interface ModelPerformancePoint {
	timestamp: number;
	model: string;
	provider: string;
	requests: number;
	avgTtft: number | null;
	avgTokensPerSecond: number | null;
}

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

export type AgentType = "main" | "subagent" | "advisor";

export interface AgentTypeStats {
	agentType: AgentType;
	totalRequests: number;
	totalInputTokens: number;
	totalOutputTokens: number;
	totalCacheReadTokens: number;
	totalCacheWriteTokens: number;
	totalCost: number;
}

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

export interface ToolModelStats extends ToolUsageStats {
	model: string;
	provider: string;
}

export interface ToolTimeSeriesPoint {
	timestamp: number;
	tool: string;
	calls: number;
	errors: number;
}

export interface ToolDashboardStats {
	byTool: ToolUsageStats[];
	byToolModel: ToolModelStats[];
	series: ToolTimeSeriesPoint[];
}
