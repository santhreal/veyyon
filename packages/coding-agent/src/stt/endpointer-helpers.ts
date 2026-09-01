export interface EndpointerConfig {
	sampleRate: number;
	frameMs: number;
	endSilenceMs: number;
	minSpeechMs: number;
	maxSegmentMs: number;
	preRollMs: number;
	partialIntervalMs: number;
	energyRatio: number;
	floorAttack: number;
	minThreshold: number;
}

export const DEFAULT_ENDPOINTER_CONFIG: EndpointerConfig = {
	sampleRate: 16_000,
	frameMs: 30,
	endSilenceMs: 600,
	minSpeechMs: 200,
	maxSegmentMs: 12_000,
	preRollMs: 240,
	partialIntervalMs: 450,
	energyRatio: 2.5,
	floorAttack: 0.05,
	minThreshold: 0.008,
};

export type EndpointerEvent = { kind: "partial"; audio: Float32Array } | { kind: "segment"; audio: Float32Array };
