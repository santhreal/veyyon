export const UTF8_ENCODER = new TextEncoder();

export interface CompressionStatsInit {
	readonly originalSize?: number;
	readonly compressedSize?: number;
	readonly ratio?: number;
	readonly method?: string;
	readonly patternsFound?: number;
	readonly memoriesCompressed?: number;
}
