<session-state>
Restated whenever it changes, so the newest block of this kind is the true one and every earlier copy is stale.
- Today is {{date}}.
- The current working directory is '{{cwd}}'.
{{#if peers.length}}
- Room peers: {{#each peers}}`{{this.id}}`{{#unless @last}}, {{/unless}}{{/each}}. Each is another driving agent in this terminal with its own conversation and its own spawns, not your subordinate and not your spawner. The operator switches between you at will. Reach one by its id through `irc`; `to: "all"` reaches only your own spawns. Never wait on a peer that did not ask you for anything.
{{/if}}
</session-state>
