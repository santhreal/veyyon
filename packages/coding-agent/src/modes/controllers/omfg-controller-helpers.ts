import type { OmfgPanelComponent } from "../components/omfg-panel";
import type { InteractiveModeContext } from "../types";
import type { ParsedGeneratedRule } from "./omfg-rule";

/** The slice of the interactive context this controller uses: 10 members of the 215 `InteractiveModeContext` requires. Naming the slice keeps the dependency */
export type OmfgControllerContext = Pick<
	InteractiveModeContext,
	| "omfgContainer"
	| "session"
	| "sessionManager"
	| "settings"
	| "showError"
	| "showHookConfirm"
	| "showHookInput"
	| "showHookSelector"
	| "showStatus"
	| "ui"
>;

export interface OmfgRequest {
	component: OmfgPanelComponent;
	abortController: AbortController;
	complaint: string;
}

export interface OmfgCandidate extends ParsedGeneratedRule {
	validated: boolean;
}

export interface GenerateCandidateOptions {
	initialFeedback?: string;
	previousRule?: string;
}

export type SaveCandidateResult = { kind: "saved" | "aborted" | "rejected" } | { kind: "amend"; feedback: string };

export const MAX_ATTEMPTS = 3;
export const PROFILE_OPTION = "This profile — every project";
export const AMEND_OPTION = "Amend with feedback…";
