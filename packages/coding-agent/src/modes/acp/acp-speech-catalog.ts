import { DEFAULT_STT_MODEL_KEY, STT_MODEL_OPTIONS } from "../../stt/models";
import {
	DEFAULT_TTS_LOCAL_MODEL_KEY,
	DEFAULT_TTS_VOICE,
	TTS_LOCAL_MODELS,
	TTS_LOCAL_VOICE_OPTIONS,
} from "../../tts/models";

/** ACP extension method name that serves {@link buildAcpSpeechModelsCatalog}. */
export const SPEECH_MODELS_LIST_METHOD = "speech.models.list";

type AcpSpeechOption = {
	value: string;
	label: string;
	description?: string;
};

type AcpSpeechVoiceOption = {
	value: string;
	label: string;
};

type AcpSpeechTtsModelOption = AcpSpeechOption & {
	voices: AcpSpeechVoiceOption[];
};

/** Catalog of STT/TTS models + voices with the settings keys that select them. */
export function buildAcpSpeechModelsCatalog(): Record<string, unknown> {
	const voices = TTS_LOCAL_VOICE_OPTIONS.map(({ value, label }) => ({ value, label }));
	return {
		settings: {
			speechToTextModel: "stt.modelName",
			textToSpeechModel: "tts.localModel",
			textToSpeechVoice: "tts.localVoice",
			speechVoice: "speech.voice",
		},
		defaults: {
			speechToTextModel: DEFAULT_STT_MODEL_KEY,
			textToSpeechModel: DEFAULT_TTS_LOCAL_MODEL_KEY,
			voice: DEFAULT_TTS_VOICE,
		},
		speechToText: {
			setting: "stt.modelName",
			defaultValue: DEFAULT_STT_MODEL_KEY,
			models: STT_MODEL_OPTIONS.map(({ value, label, description }) => ({ value, label, description })),
		},
		textToSpeech: {
			modelSetting: "tts.localModel",
			voiceSetting: "tts.localVoice",
			speechVoiceSetting: "speech.voice",
			defaultModel: DEFAULT_TTS_LOCAL_MODEL_KEY,
			defaultVoice: DEFAULT_TTS_VOICE,
			models: TTS_LOCAL_MODELS.map(
				({ key, label, description, voices: modelVoices }): AcpSpeechTtsModelOption => ({
					value: key,
					label,
					description,
					voices: modelVoices.map(({ id, label: voiceLabel }) => ({ value: id, label: voiceLabel })),
				}),
			),
			voices,
		},
	};
}
