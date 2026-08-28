import { serializeConversation } from "@veyyon/agent-core";
import { type Context, complete, type Message } from "@veyyon/ai";
import type { HookAPI, SessionEntry } from "@veyyon/coding-agent";
import { ComposerLoader, convertToLlm } from "@veyyon/coding-agent";
import { mapJsonStrings } from "@veyyon/coding-agent/secrets/obfuscator";

const SYSTEM_PROMPT = `You are a context transfer assistant. Given a conversation history and the user's goal for a new thread, generate a focused prompt that:

1. Summarizes relevant context from the conversation (decisions made, approaches taken, key findings)
2. Lists any relevant files that were discussed or modified
3. Clearly states the next task based on the user's goal
4. Is self-contained - the new thread should be able to proceed without the old conversation

Format your response as a prompt the user can send to start the new thread. Be concise but include all necessary context. Do not include any preamble like "Here's the prompt" - just output the prompt itself.

Example output format:
## Context
We've been working on X. Key decisions:
- Decision 1
- Decision 2

Files involved:
- path/to/file1.ts
- path/to/file2.ts

## Task
[Clear description of what to do next based on user's goal]`;

export default function (pi: HookAPI) {
	pi.registerCommand("handoff", {
		description: "Transfer context to a new focused session",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("handoff requires interactive mode", "error");
				return;
			}

			if (!ctx.model) {
				ctx.ui.notify("No model selected", "error");
				return;
			}

			const goal = args.trim();
			if (!goal) {
				ctx.ui.notify("Usage: /handoff <goal for new thread>", "error");
				return;
			}

			const branch = ctx.sessionManager.getBranch();
			const messages = branch
				.filter((entry): entry is SessionEntry & { type: "message" } => entry.type === "message")
				.map(entry => entry.message);

			if (messages.length === 0) {
				ctx.ui.notify("No conversation to hand off", "error");
				return;
			}

			const currentSessionFile = ctx.sessionManager.getSessionFile();

			const result = await ctx.ui.custom<string | null>((tui, theme, done) => {
				const loader = new ComposerLoader(tui, theme, `Generating handoff prompt...`);
				loader.onAbort = () => done(null);

				const doGenerate = async () => {
					const apiKey = await ctx.modelRegistry.getApiKey(ctx.model!);
					if (!apiKey) return null;
					const sanitizeLive = (text: string): string => ctx.obfuscateProviderText(text);
					const providerContext: Context = { messages: [] };
					const buildAttemptContext = (): void => {
						const providerMessages = mapJsonStrings(convertToLlm(messages), sanitizeLive) as Message[];
						const conversationText = serializeConversation(providerMessages);
						const userMessage: Message = {
							role: "user",
							content: [
								{
									type: "text",
									text: sanitizeLive(
										`## Conversation History\n\n${conversationText}\n\n## User's Goal for New Thread\n\n${sanitizeLive(goal)}`,
									),
								},
							],
							timestamp: Date.now(),
						};
						providerContext.systemPrompt = [sanitizeLive(SYSTEM_PROMPT)];
						providerContext.messages = [userMessage];
					};
					buildAttemptContext();
					const response = await complete(ctx.model!, providerContext, {
						apiKey,
						signal: loader.signal,
						onPayload: payload => mapJsonStrings(payload, sanitizeLive),
					});

					if (response.stopReason === "aborted") {
						return null;
					}

					return response.content
						.filter((c): c is { type: "text"; text: string } => c.type === "text")
						.map(c => c.text)
						.join("\n");
				};

				doGenerate()
					.then(done)
					.catch(() => {
						done(null);
					});

				return loader;
			});

			if (result === null) {
				ctx.ui.notify("Cancelled", "info");
				return;
			}

			const editedPrompt = await ctx.ui.editor("Edit handoff prompt (ctrl+enter to submit, esc to cancel)", result);

			if (editedPrompt === undefined) {
				ctx.ui.notify("Cancelled", "info");
				return;
			}

			const newSessionResult = await ctx.newSession({
				parentSession: currentSessionFile,
			});

			if (newSessionResult.cancelled) {
				ctx.ui.notify("New session cancelled", "info");
				return;
			}

			ctx.ui.setEditorText(editedPrompt);
			ctx.ui.notify("Handoff ready. Submit when ready.", "info");
		},
	});
}
