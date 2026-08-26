/**
 * Typed errors and exit code mapping for the DeepSWE runner and arm-staging pipeline.
 *
 * Library functions throw these errors instead of terminating the host process with
 * process.exit(), so caller environments (CLI, test suites, dashboard server) can catch,
 * inspect, format, and map failures to appropriate exit codes.
 */

export class DeepSweRunnerError extends Error {
	readonly exitCode: number;

	constructor(message: string, exitCode = 1) {
		super(message);
		this.name = this.constructor.name;
		this.exitCode = exitCode;
	}
}

export class MissingArmConfigError extends DeepSweRunnerError {}
export class InvalidArmYamlError extends DeepSweRunnerError {}
export class InvalidArmConfigShapeError extends DeepSweRunnerError {}
export class MistypedArmSettingsError extends DeepSweRunnerError {}
export class UnknownArmSettingsError extends DeepSweRunnerError {}
export class EncodeArmModelMismatchError extends DeepSweRunnerError {}
export class ArmAttachmentError extends DeepSweRunnerError {}
export class PromptOverrideIdError extends DeepSweRunnerError {}
export class ZeroIvCollisionError extends DeepSweRunnerError {}

export class ComparisonRejectionError extends DeepSweRunnerError {}
export class MergeArgsError extends DeepSweRunnerError {}
export class MergeMissingResultsError extends DeepSweRunnerError {}
export class MergeRefusedError extends DeepSweRunnerError {}
export class MissingTasksRootError extends DeepSweRunnerError {}
export class EmptyArmsError extends DeepSweRunnerError {}
export class UnknownArmError extends DeepSweRunnerError {}
export class MissingModelError extends DeepSweRunnerError {}
export class InvalidTrialTimeoutError extends DeepSweRunnerError {}
export class NoTasksSelectedError extends DeepSweRunnerError {}
export class InvalidBinaryPinError extends DeepSweRunnerError {}
export class InvalidTaskBudgetError extends DeepSweRunnerError {}
export class PierMissingError extends DeepSweRunnerError {}
export class PierIncompatibleError extends DeepSweRunnerError {}
export class SystemPreflightError extends DeepSweRunnerError {}
export class CanaryTrippedError extends DeepSweRunnerError {}
export class MissingBackendBindingError extends DeepSweRunnerError {}
export class MissingRequiredFileError extends DeepSweRunnerError {}
export class BinaryBuildFailedError extends DeepSweRunnerError {}
export class MissingCredentialStoreError extends DeepSweRunnerError {}

export const DEEPSWE_RUNNER_ERRORS = [
	MissingArmConfigError,
	InvalidArmYamlError,
	InvalidArmConfigShapeError,
	MistypedArmSettingsError,
	UnknownArmSettingsError,
	EncodeArmModelMismatchError,
	ArmAttachmentError,
	PromptOverrideIdError,
	ZeroIvCollisionError,
	ComparisonRejectionError,
	MergeArgsError,
	MergeMissingResultsError,
	MergeRefusedError,
	MissingTasksRootError,
	EmptyArmsError,
	UnknownArmError,
	MissingModelError,
	InvalidTrialTimeoutError,
	NoTasksSelectedError,
	InvalidBinaryPinError,
	InvalidTaskBudgetError,
	PierMissingError,
	PierIncompatibleError,
	SystemPreflightError,
	CanaryTrippedError,
	MissingBackendBindingError,
	MissingRequiredFileError,
	BinaryBuildFailedError,
	MissingCredentialStoreError,
] as const;

export type DeepSweRunnerErrorClass = (typeof DEEPSWE_RUNNER_ERRORS)[number];

export function resolveExitCode(error: unknown): number {
	if (error instanceof DeepSweRunnerError) {
		return error.exitCode;
	}
	return 1;
}
