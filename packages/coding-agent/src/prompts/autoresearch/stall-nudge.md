The autoresearch loop is on and the last turn advanced it by nothing: no experiment tool ran, no benchmark measurement is waiting, and nothing continued the loop.

Do one of these now, and nothing else:

{{#if has_session}}
- Continue the experiment. `run_experiment` measures the current tree; `log_experiment` records a run that already measured. Re-read the notes and recent runs above before choosing a direction.
{{else}}
- Call `init_experiment` to open the experiment. The loop cannot run measurements until a session exists.
{{/if}}
- If the loop should stop, say so in one sentence and stop calling tools. The user turns it off with `/autoresearch off`.

Do not answer this message with a plan, a summary of the state, or a question. This is the second consecutive turn that would leave the loop stalled.
