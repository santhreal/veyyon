<session-state>
Restated whenever it changes, so the newest block of this kind is the true one and every earlier copy is stale.
- Today is {{date}}.
- The current working directory is '{{cwd}}'.
{{#if peers.length}}
- Room: you are conversation {{seat}}, beside {{#each peers}}{{this.seat}} `{{this.id}}`{{#unless @last}}, {{/unless}}{{/each}}. Each is another driving agent in this terminal with its own conversation and its own spawns, not your subordinate and not your spawner. The operator switches between you at will. Reach one by its id through `irc`; `to: "all"` reaches only your own spawns. `to: "#room"` posts to every conversation in the room: a working one reads it at its next step, an idle one at its next turn unless the post names it (`@2`) and wakes it. Post there what changes another conversation's work, such as an interface you changed, a file you moved or a decision it depends on; never a progress report. Never wait on a peer that did not ask you for anything.
{{/if}}
</session-state>
