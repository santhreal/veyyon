export {
	buildExpansionRecord,
	decodeLog,
	encodeRecord,
	MAX_RECORD_BYTES,
	placeholdersIn,
	ROTATE_AT_BYTES,
	ROTATED_SUFFIX,
	SECRET_AUDIT_FILENAME,
	SecretAuditLog,
	type SecretExpansionRecord,
	secretAuditPath,
} from "./audit";

export {
	deobfuscateSessionContext,
	deobfuscateToolArguments,
	obfuscateMessages,
	obfuscateProviderContext,
	type SecretEntry,
	SecretObfuscator,
} from "./obfuscator";
export {
	canObfuscatePlainValue,
	describeSecretRejection,
	MIN_AUTODETECTED_ENV_VALUE_LENGTH,
	MIN_OBFUSCATABLE_LENGTH,
	type SecretRejection,
	type SecretRejectionReason,
	secretCharacterLength,
} from "./policy";

export { collectEnvSecrets, loadSecrets } from "./secrets-loader";
