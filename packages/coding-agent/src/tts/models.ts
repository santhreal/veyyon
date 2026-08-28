import { errorMessage } from "@veyyon/utils/type-guards";
import type { TinyModelDtype } from "../tiny/dtype";

export interface TtsLocalVoiceSpec {
	id: string;
	label: string;
}

export interface TtsLocalModelSpec {
	key: string;
	repo: string;
	dtype: TinyModelDtype;
	sampleRate: number;
	label: string;
	description: string;
	voices: readonly TtsLocalVoiceSpec[];
}

export const KOKORO_VOICES: readonly TtsLocalVoiceSpec[] = [
	{ id: "af_heart", label: "Heart (American female)" },
	{ id: "af_bella", label: "Bella (American female)" },
	{ id: "af_nicole", label: "Nicole (American female)" },
	{ id: "af_aoede", label: "Aoede (American female)" },
	{ id: "af_kore", label: "Kore (American female)" },
	{ id: "af_sarah", label: "Sarah (American female)" },
	{ id: "am_michael", label: "Michael (American male)" },
	{ id: "am_fenrir", label: "Fenrir (American male)" },
	{ id: "am_puck", label: "Puck (American male)" },
	{ id: "bf_emma", label: "Emma (British female)" },
	{ id: "bm_george", label: "George (British male)" },
	{ id: "bm_fable", label: "Fable (British male)" },
] as const;

export const DEFAULT_TTS_VOICE = "af_heart";

export const DEFAULT_TTS_LOCAL_MODEL_KEY = "kokoro";

export const TTS_LOCAL_MODELS = [
	{
		key: "kokoro",
		repo: "onnx-community/Kokoro-82M-v1.0-ONNX",
		dtype: "q8",
		sampleRate: 24_000,
		label: "Kokoro-82M",
		description: "Kokoro-82M neural TTS — SoTA on-device quality, multi-voice, fully local",
		voices: KOKORO_VOICES,
	},
] as const satisfies readonly TtsLocalModelSpec[];

export type TtsLocalModelKey = (typeof TTS_LOCAL_MODELS)[number]["key"];

export const TTS_LOCAL_MODEL_VALUES = ["kokoro"] as const;

type MissingTtsModelValue = Exclude<TtsLocalModelKey, (typeof TTS_LOCAL_MODEL_VALUES)[number]>;
type ExtraTtsModelValue = Exclude<(typeof TTS_LOCAL_MODEL_VALUES)[number], TtsLocalModelKey>;
const TTS_LOCAL_MODEL_VALUES_MATCH_REGISTRY: MissingTtsModelValue extends never
	? ExtraTtsModelValue extends never
		? true
		: never
	: never = true;
void TTS_LOCAL_MODEL_VALUES_MATCH_REGISTRY;

export const TTS_LOCAL_MODEL_OPTIONS = [
	{
		value: "kokoro",
		label: "Kokoro-82M",
		description: "Kokoro-82M neural TTS — SoTA on-device quality, multi-voice, fully local",
	},
] as const satisfies ReadonlyArray<{ value: TtsLocalModelKey; label: string; description: string }>;

export const TTS_LOCAL_VOICE_OPTIONS = KOKORO_VOICES.map(voice => ({
	value: voice.id,
	label: voice.label,
})) as ReadonlyArray<{ value: string; label: string }>;

export const TTS_LOCAL_VOICE_VALUES = KOKORO_VOICES.map(voice => voice.id) as readonly string[];

export function getTtsLocalModelSpec(key: string): TtsLocalModelSpec | undefined {
	return TTS_LOCAL_MODELS.find(model => model.key === key);
}

export function isTtsLocalModelKey(value: string): value is TtsLocalModelKey {
	return getTtsLocalModelSpec(value) !== undefined;
}

export function resolveTtsRepo(modelKey: string | undefined): string {
	const spec = (modelKey && getTtsLocalModelSpec(modelKey)) || getTtsLocalModelSpec(DEFAULT_TTS_LOCAL_MODEL_KEY);
	if (!spec) throw new Error(`No local TTS model registered for key: ${modelKey ?? DEFAULT_TTS_LOCAL_MODEL_KEY}`);
	return spec.repo;
}

export function resolveTtsVoice(modelKey: string | undefined, voice: string | undefined): string {
	const spec = (modelKey && getTtsLocalModelSpec(modelKey)) || getTtsLocalModelSpec(DEFAULT_TTS_LOCAL_MODEL_KEY);
	const fallback = spec?.voices[0]?.id ?? DEFAULT_TTS_VOICE;
	if (!spec || !voice) return fallback;
	const match = spec.voices.find(v => v.id === voice);
	return match ? match.id : fallback;
}

export function isCorruptModelCacheError(error: unknown): boolean {
	const message = errorMessage(error);
	return /protobuf parsing failed|load model from .+ failed/i.test(message);
}
