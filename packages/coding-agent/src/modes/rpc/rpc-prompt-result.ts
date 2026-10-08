/**
 * Whether an RPC `prompt` reached the agent.
 *
 * `prompt` answers before the turn runs. When the text resolves to local work only (a slash
 * command that consumed it), the server sends `{ type: "prompt_result", agentInvoked: false }`
 * once the prompt settles, unless an extension scheduled agent work while it ran.
 */
export function reportLocalOnlyPromptResult(input: {
	id: string | undefined;
	prompt: Promise<boolean>;
	output: (obj: object) => void;
	onError: (error: Error) => void;
	hasExtensionAgentMessageTask?: () => boolean;
	waitForExtensionAgentMessageTasks?: () => Promise<void>;
}): void {
	void input.prompt
		.then(async agentInvoked => {
			if (agentInvoked) return;
			await input.waitForExtensionAgentMessageTasks?.();
			if (!input.hasExtensionAgentMessageTask?.()) {
				input.output({ type: "prompt_result", id: input.id, agentInvoked: false });
			}
		})
		.catch(error => {
			input.onError(error instanceof Error ? error : new Error(String(error)));
		});
}

type RpcExtensionUserMessageScope = {
	hasAgentMessageTask: boolean;
	pendingAgentMessageTasks: Set<Promise<void>>;
};

/**
 * Tracks extension-originated messages while an RPC prompt is executing.
 * A slash command can resolve the outer prompt as local-only while also
 * scheduling agent work through pi.sendUserMessage() or pi.sendMessage()
 * with triggerTurn; that prompt must not report agentInvoked:false to the host.
 */
export class RpcExtensionUserMessageTracker {
	#activePromptScopes = new Set<RpcExtensionUserMessageScope>();

	markAgentMessageTask(): void {
		for (const scope of this.#activePromptScopes) {
			scope.hasAgentMessageTask = true;
		}
	}

	trackAgentMessageTask(task: Promise<unknown>): void {
		for (const scope of this.#activePromptScopes) {
			trackAgentMessageTaskForScope(scope, task);
		}
	}

	watchPrompt<T>(startPrompt: () => Promise<T>): {
		prompt: Promise<T>;
		hasAgentMessageTask: () => boolean;
		waitForAgentMessageTasks: () => Promise<void>;
	} {
		const scope: RpcExtensionUserMessageScope = {
			hasAgentMessageTask: false,
			pendingAgentMessageTasks: new Set(),
		};
		this.#activePromptScopes.add(scope);
		let prompt: Promise<T>;
		try {
			prompt = startPrompt();
		} catch (error) {
			this.#activePromptScopes.delete(scope);
			throw error;
		}
		return {
			prompt: prompt.finally(() => {
				this.#activePromptScopes.delete(scope);
			}),
			hasAgentMessageTask: () => scope.hasAgentMessageTask,
			waitForAgentMessageTasks: () => waitForAgentMessageTasks(scope),
		};
	}
}

function trackAgentMessageTaskForScope(scope: RpcExtensionUserMessageScope, task: Promise<unknown>): void {
	const scopedTask = task.then(
		() => {
			scope.hasAgentMessageTask = true;
		},
		() => {},
	);
	scope.pendingAgentMessageTasks.add(scopedTask);
	void scopedTask.finally(() => {
		scope.pendingAgentMessageTasks.delete(scopedTask);
	});
}

async function waitForAgentMessageTasks(scope: RpcExtensionUserMessageScope): Promise<void> {
	while (scope.pendingAgentMessageTasks.size > 0) {
		await Promise.allSettled(Array.from(scope.pendingAgentMessageTasks));
	}
}

export function watchAndReportLocalOnlyPromptResult(input: {
	id: string | undefined;
	startPrompt: () => Promise<boolean>;
	output: (obj: object) => void;
	onError: (error: Error) => void;
	extensionUserMessageTracker: RpcExtensionUserMessageTracker;
}): void {
	const trackedPrompt = input.extensionUserMessageTracker.watchPrompt(input.startPrompt);
	reportLocalOnlyPromptResult({
		id: input.id,
		prompt: trackedPrompt.prompt,
		output: input.output,
		onError: input.onError,
		hasExtensionAgentMessageTask: trackedPrompt.hasAgentMessageTask,
		waitForExtensionAgentMessageTasks: trackedPrompt.waitForAgentMessageTasks,
	});
}
