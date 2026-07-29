These credentials are available to you right now:

{{#each names}}
- `#{{this}}#`
{{/each}}

Each line is a placeholder, never a value. Write the placeholder wherever the credential belongs — a command line, a request header, a config file you are asked to write — and the real value is substituted locally, on this machine, immediately before the tool runs. The credential itself never travels back through the conversation.

You never see the value, and you NEVER ask for it. Asking would put the secret into the transcript, which is the one thing the placeholder exists to prevent.

A name that is not listed above is not available. Writing a placeholder for it substitutes nothing: the literal `#NAME#` text reaches the tool, and the call fails as though the credential were wrong rather than missing. This list is rebuilt from the live vault, so a credential that was removed or has expired is simply gone from it — if a name you used before is not here now, it no longer exists and you MUST stop writing it. Tell the user what you needed and let them decide whether to store it again.
