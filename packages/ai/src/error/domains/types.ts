import type { Api } from "../../types";
import type { Flag } from "../flag";

export interface Signal {
	readonly text: string;
	readonly status: number | undefined;
	readonly api: Api | undefined;
	readonly http2: boolean | undefined;
	readonly code: string | undefined;
}

export interface ClassificationRule {
	readonly flags: number;
	readonly name: string;
	readonly why: string;
	readonly structural?: (signal: Signal) => boolean;
	readonly text?: (text: string) => boolean;
}

export interface ClassRule {
	readonly name: string;
	readonly why: string;
	readonly matches: (link: unknown) => boolean;
	readonly flags: (link: unknown) => number;
}

export type DegradedCapability = "strict-tools" | "fast-mode" | "server-side-items";

export type Recovery =
	| { readonly action: "retry" }
	| { readonly action: "rotate-credential" }
	| { readonly action: "reauth" }
	| { readonly action: "compact" }
	| { readonly action: "switch-model" }
	| { readonly action: "degrade"; readonly capability: DegradedCapability }
	| { readonly action: "surface" }
	| { readonly action: "abort" };

export type RecoveryStage = "transport" | "credential" | "turn";

export type StageRecovery = Readonly<Record<RecoveryStage, Recovery>>;

export interface ErrorDomain {
	readonly id: string;
	readonly why: string;
	readonly recovers: readonly Flag[];
	readonly recovery?: StageRecovery;
	readonly classes?: readonly ClassRule[];
	readonly rules?: readonly ClassificationRule[];
	readonly replaySafe?: true;
	readonly vetoesRetry?: true;
}
