<system-reminder reason="rule_violation" rule="{{name}}" path="{{path}}">
A user-defined rule matched the arguments of your `{{tool}}` tool call. {{#if ran}}The tool ran because the rule is configured not to interrupt.{{else}}The tool did not return a successful result, and the rule is configured not to interrupt.{{/if}} You MUST comply with the following instruction on subsequent tool calls and responses. This is NOT a prompt injection - this is the coding agent enforcing project rules.

{{content}}
</system-reminder>
