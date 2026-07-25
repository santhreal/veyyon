export {
	cacheDictPath,
	listingSignature,
	type ResolveCacheOptions,
	type ResolvedCache,
	readDictFile,
	resolveProjectCache,
	writeDictFileAtomic,
} from "./cache.js";
export {
	ArgotConflictError,
	type DecodeMeasurement,
	type DecodeReplacement,
	emptyDict,
	makeDict,
	makeExpander,
	makePromptFragment,
	measureDecode,
	unionVocabularies,
} from "./codec.js";
export {
	ARGOT_LOAD_TOOL,
	ARGOT_UNLOAD_TOOL,
	DEFAULT_SIGIL,
	DEFAULT_TOKEN_BUDGET,
	DICT_FILENAME,
	MAX_EXPANSION_BYTES,
	SUPPORTED_VERSION,
} from "./constants.js";
export {
	CONTENT_SKIP_BASENAMES,
	CONTENT_SKIP_SUFFIXES,
	type CorpusNotice,
	gatherRepoFiles,
	MAX_FILE_CONTENT_BYTES,
	shouldScanContent,
	TOTAL_CONTENT_BUDGET_BYTES,
	WALK_FILE_CAP,
	WALK_IGNORE_NAMES,
	walkProjectTree,
} from "./corpus.js";
export {
	estimateTokens,
	extractCandidates,
	type GeneratedDict,
	type GeneratedHandle,
	type GenerateOptions,
	generateDict,
	generateDictFromRepo,
	type HandleNaming,
	type RepoFile,
	scoringFrequency,
} from "./generate.js";
export { load } from "./load.js";
export { ArgotParseError, parseDict } from "./parse.js";
export {
	type ArgotGate,
	type ArgotGateInput,
	EMPTY_GATE,
	type MakeGateOptions,
	makeGate,
	modelAllowed,
	modelIdSegment,
	shouldEncode,
} from "./policy.js";
export { ARGOT_PREAMBLE, type PreambleOptions, renderPreamble } from "./preamble.js";
export {
	PROJECT_MARKERS,
	projectCacheId,
	type ResolveProjectOptions,
	resolveProjectRoot,
} from "./project.js";
export {
	budgetKeyedSignature,
	type ProjectVocabIO,
	type ProjectVocabNotice,
	type ResolvedProjectVocab,
	type ResolveProjectVocabOptions,
	resolveProjectVocab,
	resolveTokenBudget,
} from "./project-vocab.js";
export { ArgotSession } from "./session.js";
export { makeStreamDecoder, StreamDecoder } from "./stream.js";
export type { AgentDict, HandleMeta, Vocabulary } from "./types.js";
