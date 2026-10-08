/**
 * The extension UI an RPC client draws. Dialogs, notifications and widgets are sent as
 * `extension_ui_request` frames; a dialog settles when the matching `extension_ui_response`
 * frame arrives on stdin.
 */
import { $env, Snowflake } from "@veyyon/utils";
import {
	type ExtensionUIContext,
	type ExtensionUIDialogOptions,
	type ExtensionUISelectItem,
	type ExtensionWidgetContent,
	type ExtensionWidgetOptions,
	getExtensionUISelectOptionLabel,
} from "../../extensibility/extensions";
import { type Theme, theme } from "../../theme/theme";
import type { RpcExtensionUIRequest, RpcExtensionUIResponse } from "./rpc-types";

export type PendingExtensionRequest = {
	resolve: (response: RpcExtensionUIResponse) => void;
	reject: (error: Error) => void;
};

/** Pending extension UI request map that can fail closed when the RPC client disconnects. */
export class RpcPendingExtensionRequests extends Map<string, PendingExtensionRequest> {
	#closedError: Error | undefined;

	override set(id: string, request: PendingExtensionRequest): this {
		if (this.#closedError) {
			request.reject(this.#closedError);
			return this;
		}
		return super.set(id, request);
	}

	/** Reject every active and future extension UI request. */
	rejectAll(message: string): void {
		if (!this.#closedError) this.#closedError = new Error(message);
		const requests = Array.from(this.values());
		this.clear();
		for (const request of requests) {
			request.reject(this.#closedError);
		}
	}
}

type RpcUIOutput = (frame: RpcExtensionUIRequest) => void;

function parseValueDialogResponse(
	response: RpcExtensionUIResponse,
	dialogOptions: ExtensionUIDialogOptions | undefined,
): string | undefined {
	if ("cancelled" in response && response.cancelled) {
		if (response.timedOut) dialogOptions?.onTimeout?.();
		return undefined;
	}
	if ("value" in response) return response.value;
	return undefined;
}

/** Whether `setTitle` is sent to the client, which `VEYYON_RPC_EMIT_TITLE` turns on. */
export function shouldEmitRpcTitles(): boolean {
	const raw = $env.VEYYON_RPC_EMIT_TITLE;
	if (!raw) return false;
	const normalized = raw.trim().toLowerCase();
	return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

export function requestRpcEditor(
	pendingRequests: Map<string, PendingExtensionRequest>,
	output: RpcUIOutput,
	title: string,
	prefill?: string,
	dialogOptions?: ExtensionUIDialogOptions,
	editorOptions?: { promptStyle?: boolean },
): Promise<string | undefined> {
	if (dialogOptions?.signal?.aborted) return Promise.resolve(undefined);

	const id = Snowflake.next() as string;
	const { promise, resolve, reject } = Promise.withResolvers<string | undefined>();
	let settled = false;

	const cleanup = () => {
		dialogOptions?.signal?.removeEventListener("abort", onAbort);
		pendingRequests.delete(id);
	};
	const finish = (value: string | undefined) => {
		if (settled) return;
		settled = true;
		cleanup();
		resolve(value);
	};
	const fail = (error: Error) => {
		if (settled) return;
		settled = true;
		cleanup();
		reject(error);
	};
	const onAbort = () => {
		output({
			type: "extension_ui_request",
			id: Snowflake.next() as string,
			method: "cancel",
			targetId: id,
		} as RpcExtensionUIRequest);
		finish(undefined);
	};

	dialogOptions?.signal?.addEventListener("abort", onAbort, { once: true });
	pendingRequests.set(id, {
		resolve: response => {
			if ("cancelled" in response && response.cancelled) {
				finish(undefined);
			} else if ("value" in response) {
				finish(response.value);
			} else {
				finish(undefined);
			}
		},
		reject: fail,
	});
	output({
		type: "extension_ui_request",
		id,
		method: "editor",
		title,
		prefill,
		promptStyle: editorOptions?.promptStyle,
	} as RpcExtensionUIRequest);
	return promise;
}

/**
 * Extension UI over the RPC protocol. One instance serves every session the client drives: each
 * dialog is an `extension_ui_request` frame, and the `extension_ui_response` frame carrying its id
 * resolves it through the pending request map.
 */
export class RpcExtensionUIContext implements ExtensionUIContext {
	readonly #pendingRequests: Map<string, PendingExtensionRequest>;
	readonly #output: RpcUIOutput;
	readonly #emitTitles: boolean;

	constructor(
		pendingRequests: Map<string, PendingExtensionRequest>,
		output: RpcUIOutput,
		options: { readonly emitTitles: boolean },
	) {
		this.#pendingRequests = pendingRequests;
		this.#output = output;
		this.#emitTitles = options.emitTitles;
	}

	/** Helper for dialog methods with signal/timeout support */
	#createDialogPromise<T>(
		opts: ExtensionUIDialogOptions | undefined,
		defaultValue: T,
		request: Record<string, unknown>,
		parseResponse: (response: RpcExtensionUIResponse) => T,
	): Promise<T> {
		if (opts?.signal?.aborted) return Promise.resolve(defaultValue);

		const id = Snowflake.next() as string;
		const { promise, resolve, reject } = Promise.withResolvers<T>();
		let timeoutId: NodeJS.Timeout | undefined;

		const cleanup = () => {
			if (timeoutId) clearTimeout(timeoutId);
			opts?.signal?.removeEventListener("abort", onAbort);
			this.#pendingRequests.delete(id);
		};

		const onAbort = () => {
			cleanup();
			resolve(defaultValue);
		};
		opts?.signal?.addEventListener("abort", onAbort, { once: true });

		if (opts?.timeout !== undefined) {
			timeoutId = setTimeout(() => {
				opts.onTimeout?.();
				cleanup();
				resolve(defaultValue);
			}, opts.timeout);
		}

		this.#pendingRequests.set(id, {
			resolve: (response: RpcExtensionUIResponse) => {
				cleanup();
				resolve(parseResponse(response));
			},
			reject,
		});
		this.#output({ type: "extension_ui_request", id, ...request } as RpcExtensionUIRequest);
		return promise;
	}

	select(
		title: string,
		options: ExtensionUISelectItem[],
		dialogOptions?: ExtensionUIDialogOptions,
	): Promise<string | undefined> {
		return this.#createDialogPromise(
			dialogOptions,
			undefined,
			{
				method: "select",
				title,
				options: options.map(getExtensionUISelectOptionLabel),
				timeout: dialogOptions?.timeout,
			},
			response => parseValueDialogResponse(response, dialogOptions),
		);
	}

	confirm(title: string, message: string, dialogOptions?: ExtensionUIDialogOptions): Promise<boolean> {
		return this.#createDialogPromise(
			dialogOptions,
			false,
			{ method: "confirm", title, message, timeout: dialogOptions?.timeout },
			response => {
				if ("cancelled" in response && response.cancelled) {
					if (response.timedOut) dialogOptions?.onTimeout?.();
					return false;
				}
				if ("confirmed" in response) return response.confirmed;
				return false;
			},
		);
	}

	input(title: string, placeholder?: string, dialogOptions?: ExtensionUIDialogOptions): Promise<string | undefined> {
		return this.#createDialogPromise(
			dialogOptions,
			undefined,
			{
				method: "input",
				title,
				placeholder,
				timeout: dialogOptions?.timeout,
				...(dialogOptions?.secret === true ? { secret: true } : {}),
			},
			response => parseValueDialogResponse(response, dialogOptions),
		);
	}

	onTerminalInput(): () => void {
		// Raw terminal input not supported in RPC mode
		return () => {};
	}

	notify(message: string, type?: "info" | "warning" | "error"): void {
		// Fire and forget - no response needed
		this.#output({
			type: "extension_ui_request",
			id: Snowflake.next() as string,
			method: "notify",
			message,
			notifyType: type,
		} as RpcExtensionUIRequest);
	}

	setStatus(key: string, text: string | undefined): void {
		// Fire and forget - no response needed
		this.#output({
			type: "extension_ui_request",
			id: Snowflake.next() as string,
			method: "setStatus",
			statusKey: key,
			statusText: text,
		} as RpcExtensionUIRequest);
	}

	setWorkingMessage(_message?: string): void {
		// Not supported in RPC mode
	}

	setWidget(key: string, content: ExtensionWidgetContent, options?: ExtensionWidgetOptions): void {
		this.#output({
			type: "extension_ui_request",
			id: Snowflake.next() as string,
			method: "setWidget",
			widgetKey: key,
			widgetLines: content,
			widgetPlacement: options?.placement,
		} as RpcExtensionUIRequest);
	}

	setTitle(title: string): void {
		// Title updates are low-value noise for most RPC hosts; opt in via VEYYON_RPC_EMIT_TITLE=1.
		if (!this.#emitTitles) return;
		this.#output({
			type: "extension_ui_request",
			id: Snowflake.next() as string,
			method: "setTitle",
			title,
		} as RpcExtensionUIRequest);
	}

	async custom(): Promise<never> {
		// Custom UI not supported in RPC mode
		return undefined as never;
	}

	pasteToEditor(text: string): void {
		// Paste handling not supported in RPC mode - falls back to setEditorText
		this.setEditorText(text);
	}

	setEditorText(text: string): void {
		// Fire and forget - host can implement editor control
		this.#output({
			type: "extension_ui_request",
			id: Snowflake.next() as string,
			method: "set_editor_text",
			text,
		} as RpcExtensionUIRequest);
	}

	getEditorText(): string {
		// Synchronous method can't wait for RPC response
		// Host should track editor state locally if needed
		return "";
	}

	async editor(
		title: string,
		prefill?: string,
		dialogOptions?: ExtensionUIDialogOptions,
		editorOptions?: { promptStyle?: boolean },
	): Promise<string | undefined> {
		return requestRpcEditor(this.#pendingRequests, this.#output, title, prefill, dialogOptions, editorOptions);
	}

	addAutocompleteProvider(): void {
		// Autocomplete provider composition is not supported in RPC mode
	}

	get theme(): Theme {
		return theme;
	}

	getAllThemes(): Promise<{ name: string; path: string | undefined }[]> {
		return Promise.resolve([]);
	}

	getTheme(_name: string): Promise<Theme | undefined> {
		return Promise.resolve(undefined);
	}

	setTheme(_theme: string | Theme): Promise<{ success: boolean; error?: string }> {
		// Theme switching not supported in RPC mode
		return Promise.resolve({ success: false, error: "Theme switching not supported in RPC mode" });
	}

	getToolsExpanded() {
		// Tool expansion not supported in RPC mode - no TUI
		return false;
	}

	setToolsExpanded(_expanded: boolean) {
		// Tool expansion not supported in RPC mode - no TUI
	}
}
