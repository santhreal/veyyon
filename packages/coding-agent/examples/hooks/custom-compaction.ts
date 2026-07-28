/**
 * Custom Compaction Hook
 *
 * Replaces the default compaction behavior with a full summary of the entire context.
 * Instead of keeping the last 20k tokens of conversation turns, this hook:
 * 1. Summarizes ALL messages (messagesToSummarize + turnPrefixMessages)
 * 2. Discards all old turns completely, keeping only the summary
 *
 * This example also demonstrates using a different model (Gemini Flash) for summarization,
 * which can be cheaper/faster than the main conversation model.
 *
 * Usage:
 *   veyyon --hook examples/hooks/custom-compaction.ts
 */

import { serializeConversation } from "@veyyon/agent-core";
import { type Context, complete, type Message } from "@veyyon/ai";
import { getBundledModel } from "@veyyon/catalog";
import type { HookAPI } from "@veyyon/coding-agent";
import { convertToLlm } from "@veyyon/coding-agent";
import { mapJsonStrings } from "@veyyon/coding-agent/secrets/obfuscator";

export default function (pi: HookAPI) {
	pi.on("session_before_compact", async (event, ctx) => {
		ctx.ui.notify("Custom compaction hook triggered", "info");

		const { preparation, branchEntries: _, signal } = event;
		const { messagesToSummarize, turnPrefixMessages, tokensBefore, firstKeptEntryId, previousSummary } = preparation;

		// Use Gemini Flash for summarization (cheaper/faster than most conversation models)
		const model = getBundledModel("google", "gemini-2.5-flash");
		if (!model) {
			ctx.ui.notify(`Could not find Gemini Flash model, using default compaction`, "warning");
			return;
		}

		// Resolve credentials before projecting raw history. Credential failures stay generic:
		// provider/auth diagnostics may echo sensitive source bytes.
		let apiKey: string | undefined;
		try {
			apiKey = await ctx.modelRegistry.getApiKey(model);
		} catch {
			ctx.ui.notify("Could not resolve compaction credentials, using default compaction", "warning");
			return;
		}
		if (!apiKey) {
			ctx.ui.notify(`No API key for ${model.provider}, using default compaction`, "warning");
			return;
		}

		// Combine all messages for full summary
		const allMessages = [...messagesToSummarize, ...turnPrefixMessages];

		ctx.ui.notify(
			`Custom compaction: summarizing ${allMessages.length} messages (${tokensBefore.toLocaleString()} tokens) with ${
				model.id
			}...`,
			"info",
		);

		// Keep the raw messages until a physical attempt. The builder first sanitizes every
		// complete structured string, then performs the lossy conversation serialization.
		const providerContext: Context = { messages: [] };
		const sanitizeLive = (text: string): string => ctx.obfuscateProviderText(text);
		const buildAttemptContext = (): void => {
			const providerMessages = mapJsonStrings(convertToLlm(allMessages), sanitizeLive) as Message[];
			const conversationText = serializeConversation(providerMessages);
			const previousContext = previousSummary
				? `\n\nPrevious session summary for context:\n${sanitizeLive(previousSummary)}`
				: "";
			providerContext.messages = [
				{
					role: "user",
					content: [
						{
							type: "text",
							text: sanitizeLive(`You are a conversation summarizer. Create a comprehensive summary of this conversation that captures:${previousContext}

1. The main goals and objectives discussed
2. Key decisions made and their rationale
3. Important code changes, file modifications, or technical details
4. Current state of any ongoing work
5. Any blockers, issues, or open questions
6. Next steps that were planned or suggested

Be thorough but concise. The summary will replace the ENTIRE conversation history, so include all information needed to continue the work effectively.

Format the summary as structured markdown with clear sections.

<conversation>
${conversationText}
</conversation>`),
						},
					],
					timestamp: Date.now(),
				},
			];
		};
		buildAttemptContext();

		try {
			const response = await complete(model, providerContext, {
				apiKey,
				maxTokens: 8192,
				signal,
				onPayload: payload => mapJsonStrings(payload, sanitizeLive),
			});

			const summary = response.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map(c => c.text)
				.join("\n");

			if (!summary.trim()) {
				if (!signal.aborted) ctx.ui.notify("Compaction summary was empty, using default compaction", "warning");
				return;
			}

			// Return compaction content - SessionManager adds id/parentId
			// Use firstKeptEntryId from preparation to keep recent messages
			return {
				compaction: {
					summary,
					firstKeptEntryId,
					tokensBefore,
				},
			};
		} catch {
			ctx.ui.notify("Compaction request failed, using default compaction", "error");
			return;
		}
	});
}
