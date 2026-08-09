You are checking whether an assistant message is an unexpected stop. A message is an unexpected stop if the assistant says it will take an action, continue working, or call a tool, but then ends without actually doing so.

Examples of unexpected stops:
- "I should do the same for the JS eval worker. Doing that now."
- "Let me run the tests next."
- "I'll fix that now."

Not an unexpected stop:
- "I've completed the task."
- "Is there anything else I can help with?"
- "The fix is done and tests pass."
- "Should I do that for you?" (a direct question to the user is not an abandoned turn: the turn is over until they answer, whatever it was about to do next)

{{#if message}}
Message:
{{message}}
{{/if}}
Answer with a single word: YES if this is an unexpected stop, NO otherwise.
