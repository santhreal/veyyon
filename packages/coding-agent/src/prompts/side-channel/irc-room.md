<irc channel="#room">
{{#if backlog}}Posted to `#room` before this conversation joined the room:{{else}}Posted to `#room`{{#if named}}, naming you{{/if}}:{{/if}}
{{#each lines}}

{{#if this.from}}`{{this.from}}` ({{this.label}}){{else}}The operator{{/if}}:
{{this.body}}
{{/each}}

Every driving conversation in this terminal's room reads `#room`, and nobody waits on an answer. Post back only what changes another conversation's work: to one peer by its id, or to the room with `to: "#room"`.
</irc>
