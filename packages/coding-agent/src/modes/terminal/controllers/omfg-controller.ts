import { errorMessage } from "@veyyon/utils";
import {
	type ForgeCandidate,
	forgedRuleExists,
	forgedRuleTarget,
	forgeRule,
	saveForgedRule,
} from "../../../rules/forge";
import { shortenPath } from "../../../tools/core/render-utils";
import { OmfgPanelComponent } from "../components/dialogs/omfg-panel";
import type { InteractiveModeContext } from "../types";

/**
 * The slice of the interactive context this controller uses: 10 members of the
 * 215 `InteractiveModeContext` requires. Naming the slice keeps the dependency
 * legible and lets a test build one without the `as unknown as
 * InteractiveModeContext` cast the full interface forces (see
 * `CollabHostContext`).
 */
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

interface OmfgRequest {
	component: OmfgPanelComponent;
	abortController: AbortController;
	complaint: string;
}

interface GenerateCandidateOptions {
	initialFeedback?: string;
	previousRule?: string;
}

type SaveCandidateResult = { kind: "saved" | "aborted" | "rejected" } | { kind: "amend"; feedback: string };

const PROFILE_OPTION = "This profile — every project";
const AMEND_OPTION = "Amend with feedback…";

export class OmfgController {
	#activeRequest: OmfgRequest | undefined;

	constructor(private readonly ctx: OmfgControllerContext) {}

	hasActiveRequest(): boolean {
		return this.#activeRequest !== undefined;
	}

	handleEscape(): boolean {
		if (!this.#activeRequest) return false;
		this.#closeActiveRequest({ abort: this.#activeRequest.abortController.signal.aborted === false });
		return true;
	}

	dispose(): void {
		this.#closeActiveRequest({ abort: true });
	}

	async start(complaint: string): Promise<void> {
		const trimmedComplaint = complaint.trim();
		if (!trimmedComplaint) {
			this.ctx.showStatus("Usage: /omfg <complaint>");
			return;
		}

		const model = this.ctx.session.model;
		if (!model) {
			this.ctx.showError("No active model available for /omfg.");
			return;
		}

		this.#closeActiveRequest({ abort: true });

		const request: OmfgRequest = {
			component: new OmfgPanelComponent({ complaint: trimmedComplaint, tui: this.ctx.ui }),
			abortController: new AbortController(),
			complaint: trimmedComplaint,
		};
		this.ctx.omfgContainer.clear();
		this.ctx.omfgContainer.addChild(request.component);
		this.ctx.ui.requestRender();
		this.#activeRequest = request;
		void this.#runRequest(request);
	}

	async #runRequest(request: OmfgRequest): Promise<void> {
		try {
			let candidate = await this.#generateCandidate(request);
			for (;;) {
				if (!this.#isActiveRequest(request)) return;
				if (!candidate) {
					request.component.markError("The model did not return a valid TTSR rule.");
					return;
				}

				if (!candidate.validated) {
					request.component.setStatus("confirming", "Couldn't confirm a conversation match.");
					const shouldSave = await this.ctx.showHookConfirm(
						"Validation",
						"Couldn't confirm this rule matches the conversation. Save anyway?",
					);
					if (!this.#isActiveRequest(request)) return;
					if (!shouldSave) {
						request.component.markRejected();
						return;
					}
				}

				const saveResult = await this.#saveCandidate(request, candidate);
				if (!this.#isActiveRequest(request)) return;
				if (saveResult.kind !== "amend") {
					return;
				}

				candidate = await this.#generateCandidate(request, {
					initialFeedback: `User requested this amendment before saving:\n${saveResult.feedback}`,
					previousRule: candidate.fileContent,
				});
			}
		} catch (error) {
			if (!this.#isActiveRequest(request)) {
				return;
			}
			if (request.abortController.signal.aborted) {
				request.component.markAborted();
				return;
			}
			request.component.markError(errorMessage(error));
		}
	}

	async #generateCandidate(
		request: OmfgRequest,
		options: GenerateCandidateOptions = {},
	): Promise<ForgeCandidate | undefined> {
		if (this.#shouldStop(request)) return undefined;
		return await forgeRule(this.ctx.session, request.complaint, {
			feedback: options.initialFeedback,
			previousRule: options.previousRule,
			signal: request.abortController.signal,
			progress: {
				stage: (stage, _attempt, detail) => {
					if (this.#isActiveRequest(request)) request.component.setStatus(stage, detail);
				},
				draft: delta => {
					if (this.#isActiveRequest(request)) request.component.appendDraft(delta);
				},
				rule: fileContent => {
					if (this.#isActiveRequest(request)) request.component.setRule(fileContent);
				},
			},
		});
	}

	async #saveCandidate(request: OmfgRequest, candidate: ForgeCandidate): Promise<SaveCandidateResult> {
		if (this.#shouldStop(request)) return { kind: "aborted" };
		request.component.setStatus("saving", "Choose where to save or amend the TTSR rule…");
		const location = await this.ctx.showHookSelector("Save TTSR rule where?", [PROFILE_OPTION, AMEND_OPTION]);
		if (!this.#isActiveRequest(request)) return { kind: "aborted" };
		if (!location) {
			request.component.markAborted();
			this.#closeActiveRequest({ abort: false });
			return { kind: "aborted" };
		}

		if (location === AMEND_OPTION) {
			request.component.setStatus("confirming", "Describe how to amend the rule…");
			const amendment = await this.ctx.showHookInput(
				"Amend TTSR rule",
				"e.g. Make it specific to Ruby string eval in tool:write(*.rb)",
			);
			if (!this.#isActiveRequest(request)) return { kind: "aborted" };
			const feedback = amendment?.trim();
			if (!feedback) {
				request.component.markAborted();
				this.#closeActiveRequest({ abort: false });
				return { kind: "aborted" };
			}
			return { kind: "amend", feedback };
		}

		const target = forgedRuleTarget(this.ctx.settings.getAgentDir(), candidate.rule.name);
		if (await forgedRuleExists(target.filePath)) {
			const shouldOverwrite = await this.ctx.showHookConfirm(
				"Overwrite TTSR rule?",
				`${shortenPath(target.filePath)} already exists. Overwrite it?`,
			);
			if (!this.#isActiveRequest(request)) return { kind: "aborted" };
			if (!shouldOverwrite) {
				request.component.markRejected();
				return { kind: "rejected" };
			}
		}

		request.component.setStatus("saving", `Saving ${candidate.rule.name}…`);
		const filePath = await saveForgedRule(this.ctx.session, this.ctx.settings.getAgentDir(), candidate);
		if (!this.#isActiveRequest(request)) return { kind: "aborted" };
		request.component.markSaved(shortenPath(filePath));
		return { kind: "saved" };
	}

	#closeActiveRequest(options: { abort: boolean }): void {
		const request = this.#activeRequest;
		if (!request) return;
		this.#activeRequest = undefined;
		if (options.abort) {
			request.abortController.abort();
		}
		request.component.close();
		this.ctx.omfgContainer.clear();
		this.ctx.ui.requestRender();
	}

	#isActiveRequest(request: OmfgRequest): boolean {
		return this.#activeRequest === request;
	}

	#shouldStop(request: OmfgRequest): boolean {
		return !this.#isActiveRequest(request) || request.abortController.signal.aborted;
	}
}
