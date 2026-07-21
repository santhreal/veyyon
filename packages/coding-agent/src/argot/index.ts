// Vendored from the standalone `argot` SDK (santhsecurity/argot). See
// ./constants.ts for the sync note. veyyon is the first consumer of the Argot
// per-project shorthand standard; this is the in-tree copy until argot ships to
// npm, at which point this directory becomes a dependency on the package.

export {
	cacheDictPath,
	type RegenerateOptions,
	readDictFile,
	regenerateProjectCache,
	writeDictFileAtomic,
} from "./cache";
export { emptyDict, makeDict, makeExpander, makePromptFragment } from "./codec";
export { DEFAULT_SIGIL, DICT_FILENAME, MAX_EXPANSION_BYTES, SUPPORTED_VERSION } from "./constants";
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
} from "./generate";
export { ArgotParseError, parseDict } from "./parse";
export { type ArgotGate, type ArgotGateInput, EMPTY_GATE, shouldEncode } from "./policy";
export { ARGOT_PREAMBLE } from "./preamble";
export { PROJECT_MARKERS, projectCacheId, type ResolveProjectOptions, resolveProjectRoot } from "./project";
export { ArgotSession } from "./session";
export type { AgentDict, HandleMeta, Vocabulary } from "./types";
