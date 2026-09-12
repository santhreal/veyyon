/**
 * Settings group types preserve optional keys, migration fields and open string values.
 * These assertions compile with the package. Runtime settings behavior is covered by the settings suites.
 */
import type {
	CompactionSettings,
	GroupSettings,
	GroupTypeMap,
	MemoriesSettings,
	RetrySettings,
	SkillsSettings,
	SttSettings,
	TtsrSettings,
} from "../../src/config/settings-schema";

type Assert<T extends true> = T;
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type OptionalKeys<T> = { [K in keyof T]-?: Record<never, never> extends Pick<T, K> ? K : never }[keyof T];
type RequiredKeys<T> = Exclude<keyof T, OptionalKeys<T>>;

type DerivedGroups = Exclude<
	keyof GroupTypeMap,
	"compaction" | "retry" | "memories" | "skills" | "ttsr" | "stt" | "modelRoles" | "modelTags" | "cycleOrder"
>;
type DerivedChecks = { [K in DerivedGroups]: Equal<GroupTypeMap[K], GroupSettings<K>> };
type _DerivedGroupsMatchSchema = Assert<Equal<DerivedChecks[DerivedGroups], true>>;

type _CompactionOptional = Assert<Equal<OptionalKeys<CompactionSettings>, "model">>;
type _CompactionThreshold = Assert<Equal<CompactionSettings["threshold"], string>>;
type _CompactionReserve = Assert<Equal<CompactionSettings["reserveTokens"], number | undefined>>;
type _CompactionLegacyFields = Assert<
	Equal<
		Pick<CompactionSettings, "thresholdPercent" | "thresholdTokens">,
		{ thresholdPercent: number; thresholdTokens: number }
	>
>;
type _CompactionExcluded = Assert<
	Equal<Extract<keyof CompactionSettings, "remote" | "modelFallbackStrategy" | "modelContextWindow">, never>
>;
type _RetryKeys = Assert<
	Equal<keyof RetrySettings, "enabled" | "maxRetries" | "baseDelayMs" | "maxDelayMs" | "modelFallback">
>;
type _MemoryExcluded = Assert<Equal<Extract<keyof MemoriesSettings, "phase1InputTokenLimit">, never>>;
type _TtsrOptional = Assert<Equal<OptionalKeys<TtsrSettings>, "builtinRules" | "disabledRules" | "experimentalRules">>;
type _TtsrRequired = Assert<
	Equal<RequiredKeys<TtsrSettings>, "enabled" | "contextMode" | "interruptMode" | "repeatMode" | "repeatGap">
>;
type _SkillsOptional = Assert<
	Equal<
		OptionalKeys<SkillsSettings>,
		"enabled" | "enableSkillCommands" | "ignoredSkills" | "includeSkills" | "disabledExtensions"
	>
>;
type _SkillsRequired = Assert<Equal<RequiredKeys<SkillsSettings>, never>>;
type _SttKeys = Assert<Equal<RequiredKeys<SttSettings>, "enabled" | "language" | "modelName" | "streaming">>;
type _SttModelName = Assert<Equal<SttSettings["modelName"], string>>;
type _SttStreaming = Assert<Equal<SttSettings["streaming"], boolean>>;
type _ModelRoles = Assert<Equal<GroupTypeMap["modelRoles"], Record<string, string>>>;
type _CycleOrder = Assert<Equal<GroupTypeMap["cycleOrder"], string[]>>;
