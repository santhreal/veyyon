// Generated from the wire types in crates/veyyon-desktop-model. Do not edit by hand.
// Regenerate with: UPDATE_WIRE=1 cargo test -p veyyon-desktop-model --test the_typescript_wire_is_generated_from_the_rust_types

import type { ToolView } from "@veyyon/view";
import type { TodoStatus } from "@veyyon/wire";
import type { AgentDisplayState } from "../registry/live-roster";

/**
 * The requests the providers page sends about an account it lists, each
 * tagged as the wire names it.
 *
 * A family of its own rather than more variants of `HostAction`; the
 * variant that holds it is `untagged`, so a window still sends
 * `{"SignOutAccount": {…}}` and the host still reads one flat action.
 */
export type AccountsRequest = { "SignOutAccount": { provider: string, credential_id: number, } };

/**
 * How one line of agent traffic landed.
 */
export type AgentMessageOutcome = "injected" | "woken" | "revived" | "failed";

/**
 * One line of agent-to-agent traffic, oldest first, as the comms stream draws
 * it.
 */
export type AgentMessageView = { id: string, from: string, to: string, body: string, at_ms: number, reply_to: string | null, outcome: AgentMessageOutcome, error: string | null, };

/**
 * Whether the host's agents are frozen, and since when.
 *
 * The host holds one gate for the whole process: the main session, every
 * spawned agent and the advisor poll it at their action boundaries, so a
 * pause is not a property of the session the window has open. Every attached
 * window therefore reads the same value, and a pause engaged from a terminal
 * running beside the window reaches the window the same way one it engaged
 * itself does.
 *
 * `since_ms` is the wall clock the host started the pause on, not a duration,
 * so a window that attaches mid-pause states how long the freeze has run
 * rather than starting a clock of its own at zero. It is `None` exactly when
 * `paused` is false.
 */
export type AgentPauseView = { 
/**
 * True while every agent in the host process is frozen.
 */
paused: boolean, 
/**
 * Epoch milliseconds the current freeze began; `None` while running.
 */
since_ms: number | null, };

/**
 * Background or worker subagent execution metadata.
 */
export type AgentView = { 
/**
 * Unique agent identifier: what a peer addresses and what a control names.
 */
id: string, 
/**
 * The short name a person reads and says: `Main`, `Kestrel`, `Advisor-2`.
 * Assigned from spawn order, so the terminal and the window call one agent
 * the same thing.
 */
call_sign: string, 
/**
 * The registry's own label, which for a spawned agent is the agent TYPE it
 * was spawned from.
 */
display_name: string, 
/**
 * The registry's kind: `main`, `sub` or `advisor`.
 */
kind: string, 
/**
 * The state a surface names: `running`, `blocked`, `idle`, `waiting`,
 * `parked` or `aborted`. Finer than the registry's own status, which
 * cannot say that a running agent is stopped at an approval prompt or
 * that a stopped one is waiting on a peer.
 */
status: AgentDisplayState, 
/**
 * Parent agent identifier if nested.
 */
parent: string | null, 
/**
 * Working directory or scope path.
 */
scope: string, 
/**
 * Owning session identifier if tied to a session.
 */
session: SessionId | null, 
/**
 * Short gist of what the agent is doing right now; null when it has not
 * said.
 */
activity: string | null, 
/**
 * The model it runs on as `provider/id`; null when the registry does not
 * know.
 */
model: string | null, };

/**
 * Pending tool execution approval request.
 */
export type ApprovalInteraction = { id: InteractionId, tool_name: string, detail: string, requested_at_ms: number, };

/**
 * Binary attachment descriptor for prompt submission.
 *
 * `media_type` is one of the image or video types the host accepts;
 * `data` crosses the wire as base64 (see [`crate::base64_bytes`]).
 */
export type AttachmentSubmission = { id: string, name: string, media_type: string, data: string, };

/**
 * Interactive OAuth authentication flow phase.
 */
export type AuthFlowState = "AwaitingBrowser" | "AwaitingSecret" | "Completed" | "Failed" | "Cancelled";

/**
 * Active OAuth authentication flow progress.
 */
export type AuthFlowView = { 
/**
 * Provider identifier undergoing authentication.
 */
provider: string, 
/**
 * Current state of the flow.
 */
state: AuthFlowState, 
/**
 * Authorization URL for browser navigation.
 */
url: string | null, 
/**
 * Prompt text instructing the user on required input.
 */
prompt: string | null, 
/**
 * Status or error message.
 */
message: string | null, };

/**
 * The actions a console offers, as the console model names them.
 */
export type AutoswarmAction = "start" | "resume" | "pause" | "new" | "stop" | "clear" | "reset";

/**
 * One action the swarm's state allows, with what stops it when something does.
 */
export type AutoswarmActionView = { 
/**
 * The action this row runs.
 */
action: AutoswarmAction, 
/**
 * The words the control is drawn as.
 */
label: string, 
/**
 * What the action does, for the footer under it.
 */
verb: string, 
/**
 * The first action the console offers, which is its default.
 */
primary: boolean, 
/**
 * Why the action cannot run now, or None when it can.
 */
blocker: string | null, };

/**
 * The console as one window holds it.
 *
 * A console with no fields and no actions is the run ledger on its own, which
 * `/autoresearch status` opens: there is state to read and nothing to change.
 */
export type AutoswarmConsoleView = { 
/**
 * The session the console belongs to.
 */
session: string, 
/**
 * The swarm on this branch, or None before the first start.
 */
swarm: AutoswarmSwarmView | null, 
/**
 * The setup rows, in the order the console states them.
 */
fields: Array<AutoswarmFieldView>, 
/**
 * What the setup costs, stated under the rows.
 */
notes: Array<AutoswarmNoteView>, 
/**
 * The actions the swarm's state allows, primary first.
 */
actions: Array<AutoswarmActionView>, 
/**
 * The runs logged so far, newest first.
 */
runs: Array<AutoswarmRunView>, 
/**
 * The id of the row a preset is named in, or None on a console that
 * saves none. The row is an ordinary text row of `fields`; this states
 * which one the save control beside it reads.
 */
save_field: string | null, };

/**
 * The control a row draws, from the kind the console's form declares.
 */
export type AutoswarmFieldKind = "Text" | "Stepper" | "Toggle" | "Segmented";

/**
 * One row of the console.
 *
 * The value arrives twice: `display` is what the console states, already
 * formatted, and the typed field beside it is what a change sends back. A
 * window that drew the number itself would state `3` where the console states
 * `3 arms`.
 */
export type AutoswarmFieldView = { 
/**
 * The row's id, which a change names.
 */
id: string, 
/**
 * The control the row draws.
 */
kind: AutoswarmFieldKind, 
/**
 * The row's name.
 */
label: string, 
/**
 * What the row states while it has the ring.
 */
hint: string, 
/**
 * The value as the console states it, for every kind of row.
 */
display: string, 
/**
 * The text a text row holds; absent on every other kind.
 */
text: string | null, 
/**
 * What an empty text row states in place of a value.
 */
placeholder: string | null, 
/**
 * The number a stepper holds.
 */
number: number | null, 
/**
 * The lowest number the stepper takes.
 */
min: number | null, 
/**
 * The highest number the stepper takes.
 */
max: number | null, 
/**
 * The state a toggle holds.
 */
on: boolean | null, 
/**
 * The options a segmented row offers; empty on every other kind.
 */
options: Array<AutoswarmOptionView>, };

/**
 * A line the console states under its rows: the cost, the arms, the harness.
 */
export type AutoswarmNoteView = { 
/**
 * The note's id, stable across frames.
 */
id: string, 
/**
 * What the note states.
 */
text: string, };

/**
 * One option a segmented row offers. A built-in preset cannot be removed.
 */
export type AutoswarmOptionView = { 
/**
 * The value sent back when this option is chosen.
 */
value: string, 
/**
 * The words the option is drawn as.
 */
label: string, 
/**
 * This option is the one the rows currently equal.
 */
selected: boolean, 
/**
 * This option can be deleted, which a built-in cannot.
 */
removable: boolean, };

/**
 * The requests the console takes, each tagged as the wire names it.
 *
 * A family of its own rather than five more variants of `HostAction`: the
 * console is one surface, and the variant that holds this is `untagged`, so a
 * window still sends `{"RunAutoswarmAction": {…}}` and the host still reads
 * one flat action.
 *
 * Every request names its session. A console belongs to the session it was
 * opened in, and the host refuses a request naming another one, so a window
 * that moved on cannot change a setup nobody is looking at.
 */
export type AutoswarmRequest = { "SetAutoswarmField": { 
/**
 * The session whose console is being set.
 */
session: SessionId, 
/**
 * The row's id, as the console states it.
 */
field: string, 
/**
 * The text a text or segmented row takes.
 */
text?: string, 
/**
 * The number a stepper takes, held to the row's own bounds.
 */
number?: number, 
/**
 * The state a toggle takes.
 */
on?: boolean, } } | { "RunAutoswarmAction": { 
/**
 * The session whose console is being acted on.
 */
session: SessionId, 
/**
 * The action to run.
 */
action: AutoswarmAction, } } | { "SaveAutoswarmPreset": { 
/**
 * The session whose console holds the setup.
 */
session: SessionId, 
/**
 * The name to save it under.
 */
name: string, } } | { "DeleteAutoswarmPreset": { 
/**
 * The session whose console is being changed.
 */
session: SessionId, } } | { "CloseAutoswarmConsole": { 
/**
 * The session whose console is closing.
 */
session: SessionId, } };

/**
 * One run of the ledger: a logged experiment, or the one measuring now.
 */
export type AutoswarmRunView = { 
/**
 * The run's number and the segment it belongs to.
 */
label: string, 
/**
 * The arm that produced it, or None on a serial loop.
 */
arm: string | null, 
/**
 * What it measured, with its unit.
 */
metric: string, 
/**
 * How that compares with the baseline of its own segment.
 */
delta: string | null, 
/**
 * What the run is worth, in one word.
 */
outcome: string, 
/**
 * This run leads its segment.
 */
best: boolean, 
/**
 * What the run states when the ledger opens it.
 */
detail: Array<string>, };

/**
 * The swarm recorded on this branch, once one has started.
 */
export type AutoswarmSwarmView = { 
/**
 * The session's name, which the first turn records.
 */
name: string | null, 
/**
 * The branch the session is recorded on.
 */
branch: string | null, 
/**
 * What the swarm is optimizing.
 */
goal: string, 
/**
 * How many runs it has logged.
 */
runs: number, 
/**
 * The best measurement so far, with its unit.
 */
best: string | null, 
/**
 * The command measuring now, or None when nothing is.
 */
running: string | null, };

/**
 * Structured error payload received from the host transport.
 */
export type BackendError = { scope: ErrorScope, code: string | null, message: string, retryable: boolean, request: RequestId | null, occurred_at_ms: number, };

/**
 * Every protocol capability, with explicit discriminants so the wire value of
 * one never shifts when another is declared.
 */
export type Capability = "Sessions" | "SessionDeletion" | "SessionTreeNavigation" | "Transcript" | "TurnControl" | "BackgroundSubmission" | "Tools" | "Approvals" | "Questions" | "Plans" | "Files" | "Changes" | "PendingEdits" | "Terminals" | "ProcessSupervisor" | "Models" | "Providers" | "Authentication" | "Mcp" | "Extensions" | "Agents" | "AgentCommands" | "Tasks" | "Settings" | "Themes" | "Keybindings" | "Diagnostics" | "Usage" | "ContextBreakdown" | "Lifecycle" | "Goals" | "Share" | "Profiles" | "Dictation" | "PromptHistory" | "ForegroundCommand" | "Autoswarm" | "Todo";

/**
 * Tri-state capability status reported by host transport.
 */
export type CapabilityStatus = "UnknownUntilAttached" | "Available" | { "Unavailable": { reason: string, } };

/**
 * Scope of uncommitted git working tree modifications.
 */
export type ChangeScope = "WorkingTree" | "Staged";

/**
 * Status classification for a modified path within a git repository.
 */
export type ChangeStatus = "Added" | "Modified" | "Deleted" | "Renamed" | "Untracked" | "Conflicted";

/**
 * Detailed file modification metadata within a git changes snapshot.
 */
export type ChangedFile = { 
/**
 * Workspace-relative path to the file.
 */
path: string, 
/**
 * Previous workspace-relative path if renamed.
 */
previous_path: string | null, 
/**
 * Git modification status.
 */
status: ChangeStatus, 
/**
 * Number of added lines.
 */
additions: number, 
/**
 * Number of deleted lines.
 */
deletions: number, };

/**
 * View of uncommitted repository changes and unified diff text.
 */
export type ChangesView = { 
/**
 * Revision counter tracking change snapshot order.
 */
revision: number, 
/**
 * Root path of the owning git repository.
 */
repository: string | null, 
/**
 * Scope filter applied to this changes snapshot.
 */
scope: ChangeScope, 
/**
 * Individual changed files in this snapshot.
 */
files: Array<ChangedFile>, 
/**
 * Unified diff string spanning the files this snapshot carries, cut on a
 * file, hunk or line boundary at the host's byte budget.
 */
diff: string, 
/**
 * Whether `diff` is a prefix of the scope's diff rather than all of it.
 */
diff_truncated: boolean, 
/**
 * Changed files this snapshot does not list, held back at the host's
 * file budget.
 */
files_withheld: number, };

/**
 * The branch a session's checkout is on.
 */
export type CheckoutView = { 
/**
 * The branch name, or the short label of a detached HEAD or of an
 * operation in progress, spelled as the terminal spells it.
 */
branch: string, 
/**
 * Whether the tree holds staged, unstaged or untracked changes.
 */
dirty: boolean, 
/**
 * The pull request `gh` reports for the branch, absent on the default
 * branch, without a GitHub remote, or while none is open.
 */
pull_request: PullRequestView | null, };

/**
 * Where a command came from, which the palette states so two rows with one
 * name are told apart.
 */
export type CommandSource = "Builtin" | "Skill" | "Extension" | "Custom" | "McpPrompt" | "File";

/**
 * One subcommand of a command that has them.
 */
export type CommandSubcommandView = { name: string, description: string | null, 
/**
 * How the subcommand is spelled with its arguments, when it takes any.
 */
usage: string | null, };

/**
 * One command the host will run when it is sent back as a `RunCommand`.
 */
export type CommandView = { 
/**
 * The name without its leading slash, as `RunCommand` spells it.
 */
name: string, 
/**
 * Every other spelling that reaches the same command.
 */
aliases: Array<string>, description: string | null, 
/**
 * What the command expects after its name, for the commands that take
 * arguments; a command that takes none has no hint.
 */
input_hint: string | null, source: CommandSource, subcommands: Array<CommandSubcommandView>, };

/**
 * One completion an extension offered for the draft.
 *
 * Offsets are UTF-8 byte offsets into the draft the `CompleteComposer`
 * carried. Accepting the completion replaces `replace_start..replace_end`
 * with `insert` and puts the caret at `caret`, an offset into the draft
 * after that replacement.
 */
export type ComposerCompletionView = { label: string, description: string | null, replace_start: number, replace_end: number, insert: string, caret: number, };

/**
 * The completions the host answered one `CompleteComposer` with.
 */
export type ComposerCompletionsView = { 
/**
 * The `query` of the `CompleteComposer` this answers. The store keeps
 * the answer to the newest query, so a slow answer to an earlier one
 * never replaces it.
 */
query: number, items: Array<ComposerCompletionView>, };

/**
 * How an extension edit changes the draft.
 */
export type ComposerEditKind = "Set" | "Paste";

/**
 * One edit an extension made to a session's draft.
 */
export type ComposerEditView = { 
/**
 * The host's number for the edit, rising with every edit it makes. A
 * `ReportComposerDraft` states the last one the composer applied.
 */
seq: number, kind: ComposerEditKind, text: string, };

/**
 * The requests the composer sends on behalf of a session's extensions, each
 * tagged as the wire names it.
 *
 * A family of its own rather than more variants of `HostAction`; the variant
 * that holds it is `untagged`, so a window still sends
 * `{"CompleteComposer": {…}}` and the host still reads one flat action.
 */
export type ComposerRequest = { "ReportComposerDraft": { session: SessionId, text: string, cursor: number, applied_edit: number, } } | { "CompleteComposer": { session: SessionId, query: number, text: string, cursor: number, } };

/**
 * Host transport connection states mirroring wire protocol definitions.
 */
export type ConnectionState = "Detached" | { "Connecting": { attempt: number, } } | { "Syncing": { received: number, expected: number | null, } } | { "Connected": { endpoint: string, protocol: number, } } | { "Reconnecting": { attempt: number, retry_at_ms: number, message: string, } } | { "Fatal": { message: string, } };

/**
 * Rich content block payload representing an element within a transcript turn
 * across eighteen variants.
 */
export type ContentBlock = { "Text": { text: string, } } | { "Image": { media_type: string, data: Array<number>, alt: string | null, } } | { "Video": { media_type: string, bytes: number, } } | { "Thinking": { text: string, } } | { "RedactedThinking": { marker: string, } } | { "ToolCall": { id: string, name: string, arguments: unknown, presentation?: ToolPresentation, } } | { "ToolResult": { tool: string, content: unknown, is_error: boolean, presentation?: ToolPresentation, } } | { "Execution": { language: string, command: string | null, output: string, exit_code: number | null, } } | { "FileMention": { path: string, has_content: boolean, lines: number | null, bytes: number | null, unavailable_reason: string | null, image: Array<number> | null, } } | { "Custom": { variant: string, view: ToolView, } } | { "Diff": { raw: string, } } | { "ModelChange": { provider: string, model: string, } } | { "ThinkingChange": { level: string, } } | { "ModeChange": { mode: string, } } | { "Lifecycle": { phase: string, reason: string | null, } } | { "Summary": { kind: string, text: string, } } | { "Fallback": { producer: string, value: unknown, } } | { "Unknown": { tag: string, value: unknown, } };

/**
 * One line of a file that matched a content search.
 */
export type ContentMatch = { 
/**
 * Workspace-relative path of the file the line is in.
 */
path: string, 
/**
 * One-indexed line number of the match.
 */
line: number, 
/**
 * The matched line, truncated by the host to a drawable width.
 */
preview: string, };

/**
 * The lines a content search matched, in the order the search reported them.
 */
export type ContentMatchesView = { 
/**
 * The text that was searched for.
 */
query: string, 
/**
 * The matching lines.
 */
matches: Array<ContentMatch>, 
/**
 * Whether the host stopped short of every match.
 */
truncated: boolean, };

/**
 * Token breakdown of the active session context window.
 */
export type ContextBreakdownView = { 
/**
 * Owning session identifier.
 */
session: SessionId, 
/**
 * Total tokens currently consumed.
 */
total_tokens: number, 
/**
 * Maximum context window token ceiling if known.
 */
limit_tokens: number | null, 
/**
 * Breakdown of tokens by category.
 */
categories: Array<ContextCategory>, };

/**
 * Token usage category item in a context window breakdown.
 */
export type ContextCategory = { 
/**
 * Category name (e.g., "system", "messages", "tools").
 */
name: string, 
/**
 * Token count occupied by this category.
 */
tokens: number, };

/**
 * How a stored credential signs in, spelled as the credential store spells
 * it.
 */
export type CredentialKind = "oauth" | "api_key";

/**
 * A dialog of questions answered in one submission.
 *
 * The `response` that answers it is `{ "kind": "submit", "answers": [...] }`
 * with one answer per question, or `{ "kind": "chat" }` to discuss the
 * questions instead.
 */
export type DialogInteraction = { id: InteractionId, questions: Array<DialogQuestion>, requested_at_ms: number, 
/**
 * When the host settles the dialog itself, taking each unanswered
 * question's recommended option. Absent while it waits indefinitely.
 */
expires_at_ms?: number, };

/**
 * One option of a dialog question.
 */
export type DialogOption = { label: string, description?: string, 
/**
 * Text drawn beside the option while it has focus, such as a code sample.
 */
preview?: string, };

/**
 * One question of a dialog.
 */
export type DialogQuestion = { id: string, question: string, 
/**
 * Short tab label for the question.
 */
header?: string, options: Array<DialogOption>, 
/**
 * Whether more than one option may be selected.
 */
multi: boolean, 
/**
 * Index of the option the asker recommends.
 */
recommended?: number, 
/**
 * Indices of the options selected when the dialog opens.
 */
preselected: Array<number>, };

/**
 * Where a dictation is.
 */
export type DictationState = "idle" | "recording" | "transcribing";

/**
 * Snapshot view of the speech this window is dictating.
 */
export type DictationView = { state: DictationState, 
/**
 * Everything this dictation has committed, trimmed of a spoken submit
 * phrase. The composer writes it after the draft the dictation started on.
 */
utterance: string, 
/**
 * The phrase still being said, which no draft holds until the recogniser
 * commits it.
 */
partial: string, 
/**
 * The spoken submit phrase fired, so the composer sends what it holds.
 */
submit: boolean, 
/**
 * What the dictation is doing that takes long enough to state; `None` when
 * there is nothing to state.
 */
status: string | null, 
/**
 * Why the last dictation stopped short; `None` until one does.
 */
error: string | null, 
/**
 * Rises once per committed change, so the composer applies each one once.
 */
revision: number, };

/**
 * Unique transcript entry identifier.
 */
export type EntryId = string;

/**
 * Metadata describing model generation, stop conditions, and resource usage.
 */
export type EntryMeta = { provider: string | null, model: string | null, stop_reason: string | null, error: string | null, usage: UsageTotals | null, };

/**
 * Classification of backend error origins across nineteen distinct protocol
 * domains.
 */
export type ErrorScope = "Connection" | "Session" | "Transcript" | "Tool" | "Interaction" | "Plan" | "File" | "Change" | "Terminal" | "Provider" | "Mcp" | "Extension" | "Agent" | "Task" | "Settings" | "Diagnostic" | "Usage" | "Authentication" | "Lifecycle";

/**
 * A document the host writes a session out as. The host takes no other.
 */
export type ExportFormat = "html" | "json";

/**
 * Transcript export result or file path snapshot.
 */
export type ExportView = { 
/**
 * Exported session identifier.
 */
session: SessionId, 
/**
 * The document the session was written out as.
 */
format: ExportFormat, 
/**
 * Path where the export file was written, if saved to disk.
 */
path: string | null, 
/**
 * Direct exported content string if returned in memory.
 */
content: string | null, };

/**
 * One discovered item.
 */
export type ExtensionItemView = { 
/**
 * `<kind>:<name>`, the id `SetExtensionEnabled` names.
 */
id: string, kind: ExtensionKind, name: string, description: string | null, 
/**
 * The slash command, glob or pattern that brings the item in.
 */
trigger: string | null, 
/**
 * File the item was read from.
 */
path: string, 
/**
 * Id of the source that provides it.
 */
source: string, level: ExtensionLevel, state: ExtensionState, 
/**
 * The item loaded in its place, when it is shadowed.
 */
shadowed_by: string | null, };

/**
 * What a discovered item is, spelled as the host spells it in the item's id.
 */
export type ExtensionKind = "extension-module" | "skill" | "rule" | "tool" | "mcp" | "prompt" | "instruction" | "context-file" | "hook" | "slash-command";

/**
 * Where an item was found.
 */
export type ExtensionLevel = "user" | "project" | "native";

/**
 * How much an extension notice interrupts, as the extension stated it.
 */
export type ExtensionNoticeLevel = "Info" | "Warning" | "Error";

/**
 * A notice an extension raised.
 */
export type ExtensionNoticeView = { level: ExtensionNoticeLevel, message: string, 
/**
 * Epoch milliseconds the host received the notice.
 */
raised_at_ms: number, };

/**
 * A source the host discovers items from, such as another agent's
 * configuration directory.
 */
export type ExtensionSourceView = { 
/**
 * The id `SetExtensionSourceEnabled` names.
 */
id: string, name: string, 
/**
 * Whether the host reads it. A source switched off withholds every item
 * it provides.
 */
enabled: boolean, };

/**
 * Whether the host loads an item, and what withholds it when it does not.
 */
export type ExtensionState = "Active" | "Disabled" | "SourceDisabled" | "Shadowed";

/**
 * One status entry an extension set, drawn in the run bar.
 */
export type ExtensionStatusView = { 
/**
 * The key the extension set it under; setting the key again replaces it.
 */
key: string, 
/**
 * The text to draw, with terminal styling already stripped.
 */
text: string, };

/**
 * Everything the extensions of one session draw around its composer.
 */
export type ExtensionUiView = { 
/**
 * The status entries, ordered by key.
 */
statuses: Array<ExtensionStatusView>, 
/**
 * The message the run bar states while a turn streams, or `None` for the
 * window's own.
 */
working_message: string | null, 
/**
 * The widgets, in the order they were last set.
 */
widgets: Array<ExtensionWidgetView>, 
/**
 * Whether an extension added a completion source, so the composer asks
 * the host for completions through `CompleteComposer`.
 */
completes: boolean, };

/**
 * Where a widget sits relative to the composer.
 */
export type ExtensionWidgetPlacement = "AboveEditor" | "BelowEditor";

/**
 * One text widget an extension set.
 */
export type ExtensionWidgetView = { 
/**
 * The key the extension set it under; setting the key again replaces it.
 */
key: string, placement: ExtensionWidgetPlacement, 
/**
 * The lines to draw, at most the ten the terminal draws.
 */
lines: Array<string>, 
/**
 * Whether the extension set more lines than `lines` holds, which the
 * window states under the last one.
 */
truncated: boolean, };

/**
 * The requests the extensions page sends, each tagged as the wire names it.
 *
 * A family of its own rather than three more variants of `HostAction`; the
 * variant that holds it is `untagged`, so a window still sends
 * `{"SetExtensionEnabled": {…}}` and the host still reads one flat action.
 * Every request is answered with a fresh `Extensions` section.
 */
export type ExtensionsRequest = "RefreshExtensions" | { "SetExtensionEnabled": { id: string, enabled: boolean, } } | { "SetExtensionSourceEnabled": { source: string, enabled: boolean, } };

/**
 * Every item the host discovers for its workspace, with the sources they
 * come from.
 */
export type ExtensionsView = { sources: Array<ExtensionSourceView>, items: Array<ExtensionItemView>, };

/**
 * File content snapshot payload.
 */
export type FileContentView = { 
/**
 * Workspace-relative path of the requested file.
 */
path: string, 
/**
 * Text content of the file.
 */
content: string, 
/**
 * Size of the file in bytes.
 */
size_bytes: number, 
/**
 * Flag indicating whether content was truncated due to buffer limits.
 */
truncated: boolean, 
/**
 * Flag indicating whether the file contains binary data.
 */
binary: boolean, };

/**
 * Filesystem node kind within a workspace directory tree.
 */
export type FileKind = "File" | "Directory" | "Symlink";

/**
 * Individual node within a directory listing.
 */
export type FileNode = { 
/**
 * Workspace-relative path separated with forward slashes.
 */
path: string, 
/**
 * Node base name without parent path components.
 */
name: string, 
/**
 * Filesystem node classification.
 */
kind: FileKind, 
/**
 * Nesting depth from the tree root.
 */
depth: number, };

/**
 * Workspace filesystem directory hierarchy view.
 */
export type FileTreeView = { 
/**
 * Root directory path.
 */
root: string, 
/**
 * Flattened list of file and directory nodes.
 */
entries: Array<FileNode>, 
/**
 * Flag indicating whether the listing was truncated due to size limits.
 */
truncated: boolean, };

/**
 * The command a session's turn is waiting on, while it can still be moved to
 * a background job.
 *
 * The view exists only while the wait does: a session that is waiting on
 * nothing carries no view at all, rather than a view stating it is idle. That
 * is what lets a control be drawn from the view's presence and vanish the
 * moment the command finishes, without polling for a state that changes
 * between two turns of the event loop.
 */
export type ForegroundCommandView = { 
/**
 * The command line being waited on, truncated by the host to a drawable
 * width.
 */
command: string, 
/**
 * Flag stating the command line was cut to the drawable width.
 */
truncated: boolean, };

/**
 * Operation applied to an autonomous goal.
 */
export type GoalControl = "pause" | "resume" | "drop";

/**
 * Execution status of an autonomous goal.
 */
export type GoalStatus = "active" | "paused" | "budget_limited" | "complete" | "dropped";

/**
 * Snapshot view of an autonomous goal.
 */
export type GoalView = { objective: string, status: GoalStatus, 
/**
 * The host is opening continuation turns for this goal right now.
 */
driving: boolean, tokens_used: number, token_budget: number | null, turns_completed: number, time_used_seconds: number, created_at_ms: number, updated_at_ms: number, 
/**
 * Why the host stopped driving, in the operator's words; `None` while it
 * drives.
 */
stood_down: string | null, };

/**
 * Host actions across connection, session and interactive domains.
 */
export type HostAction = { "Attach": { endpoint: string | null, } } | "Detach" | "RetryConnection" | "Shutdown" | "PauseAgents" | "ResumeAgents" | "ListSessions" | { "SearchSessions": { query: string, } } | { "PreviewSessionTranscript": { session: SessionId, } } | { "OpenSession": { session: SessionId, } } | { "CreateSession": { workspace: string | null, title: string | null, } } | { "RenameSession": { session: SessionId, title: string, } } | { "DeleteSession": { session: SessionId, } } | { "BranchSession": { session: SessionId, entry: EntryId | null, } } | { "ExportSession": { session: SessionId, format: ExportFormat, } } | { "CompactSession": { session: SessionId, } } | { "HandoffSession": { session: SessionId, target: string, } } | { "LoadTranscript": { session: SessionId, before: EntryId | null, } } | { "SubmitPrompt": { session: SessionId, text: string, attachments: Array<AttachmentSubmission>, } } | { "Steer": { session: SessionId, text: string, } } | { "FollowUp": { session: SessionId, text: string, } } | { "AbortTurn": { session: SessionId, } } | { "BackgroundCommand": { session: SessionId, } } | { "RetryTurn": { session: SessionId, } } | { "RephraseReply": { session: SessionId, } } | { "ReviewPlan": { session: SessionId, } } | { "SetQueueMode": { session: SessionId, mode: QueueMode, } } | { "SetSessionMode": { session: SessionId, mode: SettableMode, } } | { "CancelTool": { session: SessionId, tool_call_id: string, } } | { "SetToolViewExpanded": { session: SessionId, call_id: string, expanded: boolean, } } | { "DequeueQueuedPrompt": { session: SessionId, } } | { "RespondToInteraction": { session: SessionId, interaction_id: string, response: unknown, } } | { "LoadFileTree": { root: string | null, } } | { "ReadFile": { path: string, } } | { "SearchFiles": { query: string, } } | { "SearchContent": { query: string, } } | { "OpenExternal": { path: string, } } | { "SearchPromptHistory": { query: string, } } | "RefreshChanges" | { "SelectChangeScope": { scope: ChangeScope, } } | { "CreateTerminal": { cwd: string | null, shell: string | null, } } | { "AttachTerminal": { terminal_id: string, } } | { "WriteTerminal": { terminal_id: string, data: Array<number>, } } | { "ResizeTerminal": { terminal_id: string, cols: number, rows: number, } } | { "RestartTerminal": { terminal_id: string, } } | { "ClearTerminal": { terminal_id: string, } } | { "CloseTerminal": { terminal_id: string, } } | "RefreshProcesses" | { "ProcessLogs": { process_id: string, follow: boolean, } } | { "ProcessSend": { process_id: string, data: Array<number>, } } | { "ProcessSignal": { process_id: string, signal: SupervisorSignal, } } | { "ProcessStop": { process_id: string, } } | { "ProcessRestart": { process_id: string, } } | { "ProcessStart": { command: string, args: Array<string>, } } | "RefreshModels" | { "SelectModel": { provider: string, model: string, persist: boolean, } } | { "SetThinkingLevel": { level: string, } } | "RefreshProviders" | { "StartProviderAuth": { provider: string, } } | { "SubmitAuthSecret": { provider: string, secret: string, } } | { "OpenAuthUrl": { url: string, } } | { "CancelAuthFlow": { provider: string, } } | { "RetryAuthFlow": { provider: string, } } | "RefreshMcp" | { "SetMcpEnabled": { server: string, enabled: boolean, } } | "RefreshAgents" | { "ReviveAgent": { agent_id: string, } } | { "SpawnTask": { task: string, } } | { "CancelTask": { task_id: string, } } | "ListCommands" | { "RunCommand": { session: SessionId, text: string, } } | "LoadSettings" | { "SetSetting": { key: string, value: unknown, } } | { "ResetSetting": { key: string, } } | "LoadThemes" | "LoadKeybindings" | { "SetKeybinding": { action: string, keys: Array<string>, } } | "RefreshDiagnostics" | { "RetryDiagnosticSource": { source: string, } } | { "ClearOutput": { session: SessionId, } } | { "GetUsage": { session: SessionId | null, } } | { "GetContextBreakdown": { session: SessionId, } } | { "SetGoal": { session: SessionId, objective: string, token_budget: number | null, } } | { "ControlGoal": { session: SessionId, op: GoalControl, } } | { "StartShare": { read_only: boolean, } } | "StopShare" | "RefreshShare" | { "JoinShare": { session?: SessionId, link: string, } } | "LeaveShare" | "RefreshProfiles" | { "CreateProfile": { name: string, 
/**
 * Copy-item keys seeded from the active profile; empty makes a blank
 * profile.
 */
copy: Array<string>, } } | { "RenameProfile": { name: string, display_name: string, } } | { "DeleteProfile": { name: string, } } | "ToggleDictation" | "CancelDictation" | AutoswarmRequest | McpRequest | AccountsRequest | ExtensionsRequest | ComposerRequest | TreeRequest;

/**
 * Complete enumeration of the protocol event variants dispatched by host
 * transport.
 */
export type HostEvent = { "ConnectionChanged": ConnectionState } | { "Snapshot": SnapshotSection } | { "TranscriptAppended": { revision: number, entries: Array<TranscriptEntry>, } } | { "TranscriptUpdated": { revision: number, entry: TranscriptEntry, } } | { "StreamingChanged": StreamingMessageState | null } | { "StreamingAppended": StreamingAppend } | { "RequestSucceeded": { request: RequestId, } } | { "RequestFailed": { request: RequestId, error: BackendError, } } | { "FatalProtocolError": { message: string, } };

/**
 * Request wrapper carrying a unique identifier and action payload.
 */
export type HostRequest = { id: RequestId, action: HostAction, };

/**
 * The machine the host process runs on.
 */
export type HostView = { 
/**
 * The name the operating system reports for the machine, domain
 * included. The terminal draws the label before the first `.`.
 */
hostname: string, };

/**
 * One kind of input a model accepts, as the catalog declares it.
 */
export type InputModality = "text" | "image" | "video";

/**
 * Unique interaction identifier for operator decisions.
 */
export type InteractionId = string;

/**
 * Keyboard shortcut binding configuration.
 */
export type KeybindingView = { 
/**
 * Target action name triggered by this binding.
 */
action: string, 
/**
 * Key sequence combination strings (e.g. `["ctrl+enter"]`).
 */
keys: Array<string>, 
/**
 * Configuration source (e.g. "default", "user").
 */
source: string, };

/**
 * What the connected MCP servers offer beyond tools: their resources, resource
 * templates and prompts, and the notifications each one sends.
 */
export type McpCatalogView = { 
/**
 * Whether the host subscribes to server notifications, as the
 * `mcp.notifications` setting states.
 */
notifications: boolean, 
/**
 * One entry per connected server, in the order the host lists them.
 */
servers: Array<McpServerCatalogView>, };

/**
 * The notifications an MCP server declares in its capabilities.
 */
export type McpNotificationsView = { 
/**
 * The server announces a changed tool list.
 */
tools_changed: boolean, 
/**
 * The server announces a changed resource list.
 */
resources_changed: boolean, 
/**
 * The server announces a changed prompt list.
 */
prompts_changed: boolean, 
/**
 * The server offers resources at all.
 */
offers_resources: boolean, 
/**
 * The server accepts subscriptions to a resource's updates.
 */
subscribe: boolean, };

/**
 * What a one-off connection to an MCP server found.
 */
export type McpProbeOutcome = { "Connected": { 
/**
 * The name the server reports for itself.
 */
name: string, 
/**
 * The version the server reports.
 */
version: string, 
/**
 * The tools it lists.
 */
tools: Array<string>, } } | { "Failed": { 
/**
 * The failure, as the transport or the server reported it.
 */
message: string, } };

/**
 * The outcome of connecting to a server once, apart from its running
 * connection.
 */
export type McpProbeView = { 
/**
 * The server's configured name.
 */
server: string, 
/**
 * What the connection found.
 */
outcome: McpProbeOutcome, };

/**
 * One argument of an MCP prompt.
 */
export type McpPromptArgumentView = { 
/**
 * The argument's name.
 */
name: string, 
/**
 * The server's description of it.
 */
description: string | null, 
/**
 * Whether the prompt fails without it.
 */
required: boolean, };

/**
 * A prompt an MCP server lists, which runs as a slash command.
 */
export type McpPromptView = { 
/**
 * The prompt's name.
 */
name: string, 
/**
 * The slash command that runs it, `/<server>:<prompt>`.
 */
command: string, 
/**
 * The server's description of it.
 */
description: string | null, 
/**
 * Its arguments, in the order the server lists them.
 */
arguments: Array<McpPromptArgumentView>, };

/**
 * One value the operator supplied for a registry server's configuration.
 */
export type McpRegistryInputValue = { 
/**
 * The input's key, as the registry result states it.
 */
key: string, 
/**
 * The value.
 */
value: string, };

/**
 * One value a registry server's configuration asks for.
 */
export type McpRegistryInputView = { 
/**
 * The key `DeployMcpRegistryServer` names it by.
 */
key: string, 
/**
 * The label to draw beside the field.
 */
label: string, 
/**
 * The registry's description of it.
 */
description: string | null, 
/**
 * Whether deploying fails without it.
 */
required: boolean, 
/**
 * The value used when none is given.
 */
default: string | null, 
/**
 * Whether the value is a secret the field masks.
 */
sensitive: boolean, 
/**
 * The values it accepts, or empty for free text.
 */
choices: Array<string>, };

/**
 * One server the registry returned.
 */
export type McpRegistryResultView = { 
/**
 * The result's id, which `DeployMcpRegistryServer` names.
 */
id: string, 
/**
 * The registry's display name.
 */
name: string, 
/**
 * The registry's description.
 */
description: string, 
/**
 * How the server is reached: `http` or `stdio`.
 */
transport: string, 
/**
 * How many times the registry reports it used.
 */
use_count: number, 
/**
 * Whether the registry verified the publisher.
 */
verified: boolean, 
/**
 * The name it is added under unless another is given: its registry name,
 * suffixed until no server in the profile's config holds it.
 */
server: string, 
/**
 * What the registry flagged about the entry.
 */
warnings: Array<string>, 
/**
 * The values the server's configuration asks for.
 */
inputs: Array<McpRegistryInputView>, };

/**
 * The Smithery registry as this profile reaches it: whether a key is stored,
 * and the results of the last search.
 */
export type McpRegistryView = { 
/**
 * Whether a Smithery API key is stored for this profile or set in the
 * host's environment.
 */
signed_in: boolean, 
/**
 * The words the last search was for, or None before any search.
 */
query: string | null, 
/**
 * The last search's results, best first.
 */
results: Array<McpRegistryResultView>, };

/**
 * The MCP management requests, each tagged as the wire names it.
 *
 * A family of its own rather than ten more variants of `HostAction`: the
 * variant that holds this is `untagged`, so a window still sends
 * `{"RemoveMcpServer": {…}}` and the host still reads one flat action.
 *
 * Every server the requests name is read from the profile's own MCP config
 * file or from the servers the host discovered; a repository's `mcp.json` is
 * never read, written or connected to.
 */
export type McpRequest = { "AddMcpServer": { 
/**
 * The server's name, which prefixes its tools.
 */
name: string, 
/**
 * How it is reached.
 */
target: McpServerTarget, } } | { "RemoveMcpServer": { 
/**
 * The server's name.
 */
server: string, } } | { "TestMcpServer": { 
/**
 * The server's name.
 */
server: string, } } | { "ReauthMcpServer": { 
/**
 * The server's name.
 */
server: string, } } | { "ClearMcpServerAuth": { 
/**
 * The server's name.
 */
server: string, } } | "ReloadMcp" | { "SearchMcpRegistry": { 
/**
 * The words to search for.
 */
query: string, 
/**
 * How many results to return, 1 to 100; the host's default when
 * absent.
 */
limit: number | null, 
/**
 * Rank by meaning rather than by name and use count.
 */
semantic: boolean, } } | { "DeployMcpRegistryServer": { 
/**
 * The result's id, as `McpRegistry` states it.
 */
result: string, 
/**
 * The name to add it under. A name already configured is refused.
 */
server: string, 
/**
 * Values for the result's inputs. A required input left out is
 * refused.
 */
inputs: Array<McpRegistryInputValue>, } } | "LoginMcpRegistry" | "LogoutMcpRegistry";

/**
 * A parameterized resource an MCP server lists, as an RFC 6570 URI template.
 */
export type McpResourceTemplateView = { 
/**
 * The URI template.
 */
uri_template: string, 
/**
 * The template's name.
 */
name: string, 
/**
 * The server's description of it.
 */
description: string | null, };

/**
 * A resource an MCP server lists.
 */
export type McpResourceView = { 
/**
 * The resource's URI.
 */
uri: string, 
/**
 * The resource's name.
 */
name: string, 
/**
 * The server's description of it.
 */
description: string | null, 
/**
 * Its MIME type, when the server states one.
 */
mime_type: string | null, };

/**
 * One connected server's resources, prompts and notification support.
 */
export type McpServerCatalogView = { 
/**
 * The server's name.
 */
server: string, 
/**
 * The resources the server lists.
 */
resources: Array<McpResourceView>, 
/**
 * The parameterized resources the server lists.
 */
templates: Array<McpResourceTemplateView>, 
/**
 * The prompts the server lists.
 */
prompts: Array<McpPromptView>, 
/**
 * The notifications the server declares it sends.
 */
notifies: McpNotificationsView, 
/**
 * The resource URIs the host is subscribed to on this server. Empty while
 * notifications are off.
 */
subscriptions: Array<string>, };

/**
 * Connectivity and lifecycle status of an MCP server.
 */
export type McpServerStatus = "Connected" | "Connecting" | "Disconnected" | { "Error": { 
/**
 * Error detail message.
 */
message: string, } };

/**
 * How a server added from the window is reached.
 */
export type McpServerTarget = { "Command": { 
/**
 * The executable.
 */
command: string, 
/**
 * Its arguments, in order.
 */
args: Array<string>, } } | { "Http": { 
/**
 * The endpoint. A URL without a scheme is read as `https://`.
 */
url: string, 
/**
 * A bearer token sent as the `Authorization` header. Without one the
 * host detects whether the server wants OAuth and runs the login.
 */
token: string | null, } } | { "Sse": { 
/**
 * The endpoint. A URL without a scheme is read as `https://`.
 */
url: string, 
/**
 * A bearer token sent as the `Authorization` header.
 */
token: string | null, } };

/**
 * Configured Model Context Protocol server configuration and tool list.
 */
export type McpServerView = { 
/**
 * Server identifier name.
 */
name: string, 
/**
 * Flag indicating whether the server is enabled.
 */
enabled: boolean, 
/**
 * Current server connection status.
 */
status: McpServerStatus, 
/**
 * List of exposed tool names.
 */
tools: Array<string>, };

/**
 * Message participant role classification across twelve protocol variants.
 */
export type MessageRole = "User" | "Developer" | "Assistant" | "ToolResult" | "BashExecution" | "PythonExecution" | "Custom" | "BranchSummary" | "CompactionSummary" | "FileMention" | "Lifecycle" | "Unknown";

/**
 * Reference identifying a provider and model pair.
 */
export type ModelRef = { 
/**
 * Provider identifier (e.g. "anthropic", "openai").
 */
provider: string, 
/**
 * Model identifier.
 */
id: string, };

/**
 * Detailed model capabilities and token window bounds.
 */
export type ModelView = { 
/**
 * Provider identifier.
 */
provider: string, 
/**
 * Model identifier.
 */
id: string, 
/**
 * Human-readable model display name.
 */
name: string, 
/**
 * Flag indicating whether the model supports extended reasoning.
 */
reasoning: boolean, 
/**
 * Maximum context window size in tokens.
 */
context_window: number, 
/**
 * Maximum generation output limit in tokens.
 */
max_output: number, 
/**
 * Input modalities the model accepts. Empty when the host did not say,
 * which a consumer treats as unknown rather than as text-only. Absent
 * stays absent on the wire so a snapshot round-trips byte-for-byte.
 */
input?: Array<InputModality>, };

/**
 * Available models, current model selection, and thinking configuration.
 */
export type ModelsView = { 
/**
 * List of all available models.
 */
models: Array<ModelView>, 
/**
 * Currently selected model reference.
 */
current: ModelRef | null, 
/**
 * Active thinking or reasoning effort level.
 */
thinking_level: string | null, 
/**
 * Supported thinking effort levels for the current model.
 */
thinking_levels: Array<string>, };

/**
 * How long the agent has worked in a session and how fast its reply streams.
 */
export type PaceView = { 
/**
 * Milliseconds of every finished working window, summed. Idle time
 * between turns never counts.
 */
worked_ms: number, 
/**
 * Epoch milliseconds the running working window opened, absent while
 * the agent is idle.
 */
working_since_ms: number | null, 
/**
 * The latest reply's output rate in tenths of a token per second (`423`
 * is 42.3 tok/s), absent before a reply long enough to rate.
 */
tokens_per_second_tenths: number | null, };

/**
 * Single definition of operator decision requests awaiting input, approval,
 * plan review or a multi-question dialog.
 */
export type PendingDecisions = { approvals: Array<ApprovalInteraction>, questions: Array<QuestionInteraction>, plans: Array<PlanInteraction>, 
/**
 * Dialogs of one or more questions answered together, which is what the
 * `ask` tool raises.
 */
dialogs: Array<DialogInteraction>, };

/**
 * Pending plan review requiring acceptance, refinement, or new session fork.
 */
export type PlanInteraction = { id: InteractionId, markdown_plan: string, requested_at_ms: number, };

/**
 * Incremental log line chunk from a supervised process.
 */
export type ProcessLogsChunk = { 
/**
 * Name of the process producing log lines.
 */
process: string, 
/**
 * Log line text items.
 */
lines: Array<string>, 
/**
 * Host log cursor position.
 */
cursor: number, 
/**
 * When true, clears previous log buffer.
 */
reset: boolean, };

/**
 * Supervised child process metadata.
 */
export type ProcessView = { 
/**
 * Process display name.
 */
name: string, 
/**
 * Operating system process ID if currently running.
 */
pid: number | null, 
/**
 * Status summary string (e.g., "running", "exited").
 */
status: string, 
/**
 * Executable or application command name.
 */
application: string, 
/**
 * Command line argument list.
 */
args: Array<string>, 
/**
 * Working directory of the process.
 */
cwd: string, 
/**
 * Process lifetime policy.
 */
lifetime: string, 
/**
 * Unix timestamp in milliseconds when the process was started.
 */
started_at_ms: number, 
/**
 * Exit status code if the process completed.
 */
exit_code: number | null, 
/**
 * Termination initiator or reason if stopped.
 */
terminated_by: string | null, };

/**
 * One item a new profile copies from the profile it is seeded off.
 */
export type ProfileCopyItemView = { 
/**
 * The key a create sends back for this item.
 */
key: string, label: string, description: string, };

/**
 * One profile directory under the base config root.
 */
export type ProfileView = { 
/**
 * Directory name. The default profile is the literal `default`.
 */
name: string, 
/**
 * What the profile shows as; the directory name when none was written.
 */
display_name: string, root_dir: string, 
/**
 * The endpoint a window attaches to for this profile, none when no
 * socket path on this platform fits.
 */
endpoint: string | null, 
/**
 * Why this profile has no addressable endpoint; none when it has one.
 */
endpoint_error: string | null, 
/**
 * True for the profile the attached host runs under.
 */
is_active: boolean, };

/**
 * Every profile on disk, the active one marked, and what a new one may copy.
 */
export type ProfilesView = { 
/**
 * Directory name of the profile the attached host runs under.
 */
active: string, entries: Array<ProfileView>, 
/**
 * What a new profile may copy, in the order a window offers them.
 */
copy_items: Array<ProfileCopyItemView>, };

/**
 * One prompt submitted earlier, as the host recorded it.
 */
export type PromptHistoryEntry = { 
/**
 * Row identifier in the host's history store, stable across searches.
 */
id: number, 
/**
 * The submitted prompt text, truncated by the host to a drawable width.
 */
prompt: string, 
/**
 * Submission time in milliseconds since the Unix epoch.
 */
submitted_at_ms: number, 
/**
 * Working directory the prompt was submitted from, when recorded.
 */
cwd: string | null, 
/**
 * Session the prompt was submitted from, when recorded.
 */
session: SessionId | null, 
/**
 * Flag stating the prompt text was cut to the drawable width.
 */
truncated: boolean, };

/**
 * The prompts the host's last history lookup matched.
 *
 * An empty `query` is the listing the mode opens on: the most recent prompts
 * rather than nothing, so the mode carries rows before anything is typed.
 */
export type PromptHistoryView = { 
/**
 * Query the entries answer, empty for the opening listing.
 */
query: string, 
/**
 * Matching prompts, most recent first.
 */
entries: Array<PromptHistoryEntry>, };

/**
 * Model provider account and authentication state.
 */
export type ProviderView = { 
/**
 * Unique provider identifier.
 */
id: string, 
/**
 * Human-readable provider name.
 */
name: string, 
/**
 * Flag indicating whether valid credentials exist.
 */
authenticated: boolean, 
/**
 * Flag indicating whether OAuth flow is supported.
 */
oauth: boolean, 
/**
 * Flag indicating whether API key authentication is supported.
 */
api_key: boolean, };

/**
 * A pull request opened from the checked-out branch.
 */
export type PullRequestView = { 
/**
 * The pull request's number in its repository.
 */
number: number, 
/**
 * The pull request's web address.
 */
url: string, };

/**
 * Pending user question requiring option selection or text entry.
 */
export type QuestionInteraction = { id: InteractionId, prompt: string, options: Array<string>, requested_at_ms: number, };

/**
 * Mode selecting whether a submitted prompt steers the active turn or queues
 * behind it.
 */
export type QueueMode = "Steer" | "Queue";

/**
 * The prompts one session is holding, as the host reported them.
 *
 * A prompt submitted while a turn runs leaves the composer and waits inside
 * the runtime, so the host states what it holds and which session it holds it
 * for. `steering` enters the turn in flight at its next boundary and
 * `follow_up` runs after the turn ends, both oldest first. `restored` carries
 * the text a `DequeueQueuedPrompt` took back out, on the one frame that
 * answers that action and on no other.
 */
export type QueuedPromptsView = { 
/**
 * The session holding the prompts.
 */
session: SessionId, 
/**
 * Prompts that enter the running turn, oldest first.
 */
steering: Array<string>, 
/**
 * Prompts that run after the turn ends, oldest first.
 */
follow_up: Array<string>, 
/**
 * The prompt the host just handed back, for the composer to hold.
 */
restored: string | null, };

/**
 * The subscription quota of the login serving a session.
 */
export type QuotaView = { 
/**
 * The plan tier the provider names, when it names one.
 */
tier: string | null, 
/**
 * The rolling five-hour window.
 */
five_hour: QuotaWindowView | null, 
/**
 * The rolling seven-day window.
 */
seven_day: QuotaWindowView | null, };

/**
 * One subscription quota window.
 */
export type QuotaWindowView = { 
/**
 * Share of the window used, in tenths of a percent (`805` is 80.5%).
 */
used_permille: number, 
/**
 * Epoch milliseconds the window resets, when the provider reports it.
 */
resets_at_ms: number | null, };

/**
 * Request identifier correlating host requests and responses.
 */
export type RequestId = number;

/**
 * Text search match results across workspace files.
 */
export type SearchResultsView = { 
/**
 * Query text or pattern matched.
 */
query: string, 
/**
 * Workspace-relative matching file paths.
 */
paths: Array<string>, 
/**
 * Flag indicating whether results were truncated due to match limits.
 */
truncated: boolean, };

/**
 * The stored login serving a session's provider.
 */
export type ServingAccountView = { 
/**
 * The provider the session's model runs on.
 */
provider: string, 
/**
 * The login's display label: its account name, email or identifier.
 */
label: string, 
/**
 * Logins stored for the provider. The terminal states the account only
 * when this is two or more, since one login is not in question.
 */
logins: number, 
/**
 * True before the session's first request, when routing has predicted
 * the login that will serve rather than confirmed one.
 */
predicted: boolean, };

/**
 * Detailed session header information for the active session.
 */
export type SessionHeaderView = { id: SessionId, schema_version: number, title: string | null, title_source: string | null, parent: SessionId | null, created_at_ms: number, cwd: string, 
/**
 * The mode the session is in as the host spells it (`plan`, `goal`,
 * `none`), absent from a host that reports no mode at all.
 */
mode: string | null, };

/**
 * Unique session identifier.
 */
export type SessionId = string;

/**
 * Error encountered when reading or parsing a session header file.
 */
export type SessionLoadError = { path: string, reason: string, };

export type SessionSearchView = { query: string, sessions: Array<SessionSummary>, };

/**
 * Status summary for a session stored on disk.
 */
export type SessionStatus = "Complete" | "Interrupted" | "Aborted" | "Error" | "Pending" | "Unknown";

/**
 * Lightweight session metadata returned in session directory listings.
 */
export type SessionSummary = { id: SessionId, workspace: string, path: string, cwd: string, title: string | null, parent_path: string | null, created_at_ms: number, modified_at_ms: number, message_count: number, size_bytes: number, first_message: string | null, searchable_messages: string | null, status: SessionStatus, };

export type SessionTranscriptView = { session: SessionId, transcript: Versioned<Array<TranscriptEntry>>, };

/**
 * What a tree entry records, which is what its row is toned by.
 */
export type SessionTreeEntryKind = "user" | "developer" | "assistant" | "tool_result" | "bash" | "custom_message" | "compaction" | "branch_summary" | "model_change" | "thinking_change" | "label" | "custom" | "other";

/**
 * Which entries a tree sheet shows, in the order the terminal cycles them.
 */
export type SessionTreeFilter = "default" | "no-tools" | "user-only" | "labeled-only" | "all";

/**
 * One row of the tree sheet.
 */
export type SessionTreeNode = { 
/**
 * The entry the row stands for; `NavigateTree` names it.
 */
id: EntryId, 
/**
 * The entry this one follows, or `None` for a root.
 */
parent: EntryId | null, 
/**
 * The row's indent in levels: a single-child chain stays flat and a
 * branch point indents its children, as the terminal draws it.
 */
depth: number, 
/**
 * What the entry records.
 */
kind: SessionTreeEntryKind, 
/**
 * The role marker drawn in the kind's tone (`user: `, `[branch
 * summary]: `), or empty when the whole row is one tone.
 */
prefix: string, 
/**
 * The rest of the row on one line: `[bash]: ls`, `[read: src/a.ts]`.
 */
text: string, 
/**
 * The label set on the entry, if any.
 */
label: string | null, 
/**
 * The entry lies on the path from the root to the current leaf.
 */
on_path: boolean, 
/**
 * The filter modes that show the row. An assistant turn holding only tool
 * calls lists none unless it is the current leaf.
 */
shown_in: Array<SessionTreeFilter>, };

/**
 * A session's entry tree as the host answered `LoadSessionTree`.
 */
export type SessionTreeView = { 
/**
 * The entry the session continues from, or `None` before any entry.
 */
leaf: EntryId | null, 
/**
 * Every entry, in the order the sheet draws them.
 */
nodes: Array<SessionTreeNode>, 
/**
 * Navigating away from a branch offers to summarize it.
 */
summary_offered: boolean, 
/**
 * The filter mode the sheet opens in.
 */
filter: SessionTreeFilter, };

/**
 * A mode the operator sets from the window, in the spelling the host accepts.
 *
 * Narrower than `SessionMode` on purpose: `goal` runs turns of its own from a
 * controller no desktop gesture reaches, and `plan_paused` is the agent's,
 * A mode the operator sets from the window in host wire spelling.
 */
export type SettableMode = "plan" | "vibe" | "loop" | "none";

/**
 * One setting as the host reports it: the effective value, where it came
 * from, the schema it is declared with, and the copy the settings screen
 * shows.
 *
 * Every field past `source` defaults, so a host that reports only the value
 * triple still decodes; such an entry renders under its key with no
 * description and no choices.
 */
export type SettingEntry = { 
/**
 * The effective value.
 */
value: unknown, 
/**
 * The schema default.
 */
default: unknown, 
/**
 * Where the effective value came from (e.g. "default", "profile",
 * "project").
 */
source: string, 
/**
 * The declared type.
 */
type: SettingKind, 
/**
 * Display label; absent when the setting declares no UI block.
 */
label: string | null, 
/**
 * One-line description.
 */
description: string | null, 
/**
 * The settings tab the entry is filed under.
 */
tab: string | null, 
/**
 * The group within the tab.
 */
group: string | null, 
/**
 * The values an `Enum` setting accepts, in declaration order.
 */
values: Array<string>, 
/**
 * The choices offered with labels; empty when the setting is free-form.
 */
options: Array<SettingOption>, 
/**
 * Inclusive lower bound of a `Number` setting.
 */
min: number | null, 
/**
 * Inclusive upper bound of a `Number` setting.
 */
max: number | null, 
/**
 * Whether the value is cross-profile rather than per-profile.
 */
global: boolean, 
/**
 * Whether the setting belongs in the tab's collapsed advanced fold.
 */
advanced: boolean, 
/**
 * Whether the setting is machine-written or retired and is not a row.
 */
hidden: boolean, };

/**
 * The type tag a setting is declared with in the host's schema.
 */
export type SettingKind = "boolean" | "string" | "modelChain" | "number" | "enum" | "array" | "record";

/**
 * One choice a setting offers, with the copy the settings screen shows for it.
 */
export type SettingOption = { 
/**
 * The value written when the option is chosen.
 */
value: string, 
/**
 * Display label.
 */
label: string, 
/**
 * One-line description, when the schema has one.
 */
description: string | null, };

/**
 * The room this window joined, present only while it is in one.
 */
export type ShareGuestView = { 
/**
 * The relay room the link named.
 */
room: string, 
/**
 * What the hosting session calls itself, or null before the first state.
 */
host_name: string | null, 
/**
 * True when the link that was joined carries no write token.
 */
read_only: boolean, 
/**
 * False while the socket is down and the guest is reconnecting.
 */
connected: boolean, };

/**
 * One party on the relay, the hosting session included.
 */
export type ShareParticipantView = { 
/**
 * Relay peer id. The hosting session is 0.
 */
id: number, name: string, 
/**
 * False for a guest that arrived by the read-only link.
 */
can_write: boolean, 
/**
 * True for the row that is this window's own session.
 */
is_host: boolean, };

/**
 * Which side of a share this window is on.
 */
export type ShareRole = "Off" | "Hosting" | "Guest";

/**
 * Relay session sharing status and link bundle.
 */
export type ShareView = { 
/**
 * Where the share is: what the window draws and what a control may ask for.
 */
state: SharePhase, 
/**
 * Whether this window hosts a share, is in one, or is in neither.
 */
role: ShareRole, 
/**
 * The relay the share runs on; null when the settings name none.
 */
relay_url: string | null, 
/**
 * The link another veyyon opens. Null unless hosting.
 */
link: string | null, 
/**
 * The same room in a browser.
 */
web_link: string | null, 
/**
 * The two links above, read-only.
 */
view_link: string | null, web_view_link: string | null, 
/**
 * The parties connected to the relay.
 */
participants: Array<ShareParticipantView>, 
/**
 * The room this window joined, or null when it joined none.
 */
guest: ShareGuestView | null, 
/**
 * Why the last attempt failed; null when nothing failed.
 */
error: string | null, };

/**
 * Domain sections received during initial connection or snapshot
 * synchronization.
 *
 * Each section is the whole of its domain as the host holds it at that
 * moment, so reducing one replaces rather than merges.
 */
export type SnapshotSection = { "Sessions": [Versioned<Array<SessionSummary>>, Array<SessionLoadError>] } | { "ActiveSession": Versioned<SessionHeaderView> } | { "Transcript": Versioned<Array<TranscriptEntry>> } | { "SessionSearch": SessionSearchView } | { "SessionTranscript": SessionTranscriptView } | { "Capabilities": Array<[Capability, CapabilityStatus]> } | { "Interactions": { 
/**
 * Target session identifier.
 */
session: SessionId, 
/**
 * Pending decisions.
 */
pending: PendingDecisions, } } | { "Settings": { [key in string]: SettingEntry } } | { "Diagnostics": unknown } | { "Changes": ChangesView } | { "FileTree": FileTreeView } | { "FileContent": FileContentView } | { "SearchResults": SearchResultsView } | { "ContentMatches": ContentMatchesView } | { "PromptHistory": PromptHistoryView } | { "Terminals": Array<TerminalView> } | { "TerminalOutput": TerminalOutputChunk } | { "Processes": Array<ProcessView> } | { "ProcessLogs": ProcessLogsChunk } | { "Models": ModelsView } | { "Providers": Array<ProviderView> } | { "AuthFlow": AuthFlowView } | { "Mcp": Array<McpServerView> } | { "McpCatalog": McpCatalogView } | { "McpProbe": McpProbeView } | { "McpRegistry": McpRegistryView } | { "Agents": Array<AgentView> } | { "AgentComms": Array<AgentMessageView> } | { "Share": ShareView } | { "Profiles": ProfilesView } | { "Usage": UsageView } | { "ContextBreakdown": ContextBreakdownView } | { "Export": ExportView } | { "Themes": ThemesView } | { "Keybindings": Array<KeybindingView> } | { "QueuedPrompts": QueuedPromptsView } | { "Commands": Array<CommandView> } | { "AgentPause": AgentPauseView } | { "Goal": { 
/**
 * Target session identifier.
 */
session: SessionId, 
/**
 * Goal view or None if cleared.
 */
goal: GoalView | null, } } | { "Dictation": DictationView } | { "ForegroundCommand": { 
/**
 * Target session identifier.
 */
session: SessionId, 
/**
 * The command being waited on, or None once nothing is.
 */
command: ForegroundCommandView | null, } } | { "AutoswarmConsole": { 
/**
 * Target session identifier.
 */
session: SessionId, 
/**
 * The console as the host holds it, or None once none is open.
 */
console: AutoswarmConsoleView | null, } } | { "Todo": { 
/**
 * Target session identifier.
 */
session: SessionId, 
/**
 * The board as the host holds it, or None once it records no task.
 */
board: TodoBoardView | null, } } | { "Accounts": Array<StoredAccountView> } | { "Extensions": ExtensionsView } | { "Host": HostView } | { "Checkout": { 
/**
 * Target session identifier.
 */
session: SessionId, 
/**
 * The checkout as the host reads it, or None outside a repository.
 */
checkout: CheckoutView | null, } } | { "Pace": { 
/**
 * Target session identifier.
 */
session: SessionId, 
/**
 * The session's pace as the host holds it.
 */
pace: PaceView, } } | { "ServingAccount": { 
/**
 * Target session identifier.
 */
session: SessionId, 
/**
 * The serving login, or None when no login is stored.
 */
account: ServingAccountView | null, } } | { "Quota": { 
/**
 * Target session identifier.
 */
session: SessionId, 
/**
 * The quota windows, or None when the provider reports none.
 */
quota: QuotaView | null, } } | { "ExtensionUi": { session: SessionId, ui: ExtensionUiView, } } | { "ComposerEdit": { session: SessionId, edit: ComposerEditView, } } | { "ComposerCompletions": { session: SessionId, completions: ComposerCompletionsView, } } | { "ExtensionNotice": { session: SessionId, notice: ExtensionNoticeView, } } | { "SessionTree": { session: SessionId, tree: SessionTreeView, } };

/**
 * One credential the host stores for a provider, which `SignOutAccount`
 * names to remove it.
 *
 * Only stored credentials are listed: a key read from an environment
 * variable or a config file signs in without being stored, and signing out
 * does not remove it.
 */
export type StoredAccountView = { 
/**
 * Provider the credential signs in to.
 */
provider: string, 
/**
 * Row the credential store keeps it under, unique within the host.
 */
credential_id: number, 
/**
 * The account's chosen name, else its email, organisation or account
 * id, else the provider and row.
 */
label: string, 
/**
 * How the credential signs in.
 */
kind: CredentialKind, 
/**
 * Whether it is the account the provider is set to use on this machine.
 */
selected: boolean, };

/**
 * Text a streaming reply grew by since the frame before it.
 *
 * The host sends one instead of a whole [`StreamingMessageState`] when the
 * reply differs from the one the window holds only by text appended to one
 * `Text` or `Thinking` block, so a frame costs the size of the delta rather
 * than the size of the reply. Every other field of the held entry, `raw`
 * included, keeps the value the last `StreamingChanged` carried.
 */
export type StreamingAppend = { entry: EntryId, block: number, text: string, revision: number, };

/**
 * State container representing in-flight assistant token generation and active
 * tool progress.
 */
export type StreamingMessageState = { entry: EntryId, tool: string | null, accumulating: TranscriptEntry, revision: number, };

/**
 * One signal the process supervisor accepts.
 *
 * The serialized form is the signal's own name, which is what the supervisor
 * reads; [`Self::wire`] states the same name for a label to draw and for the
 * suite that holds the two together.
 */
export type SupervisorSignal = "SIGINT" | "SIGTERM" | "SIGHUP" | "SIGQUIT" | "SIGKILL";

/**
 * Incremental terminal output byte stream chunk.
 */
export type TerminalOutputChunk = { 
/**
 * Terminal identifier producing the output.
 */
terminal: string, 
/**
 * Monotonic sequence number for ordering and gap detection.
 */
seq: number, 
/**
 * Raw ANSI/UTF-8 output bytes.
 */
data: Array<number>, 
/**
 * When true, clears previous scrollback buffer and resets sequence
 * tracking.
 */
reset: boolean, };

/**
 * Execution status of a managed terminal session.
 */
export type TerminalStatus = "Running" | { "Exited": { 
/**
 * Process exit code.
 */
code: number, } } | { "Failed": { 
/**
 * Error message describing the failure.
 */
message: string, } };

/**
 * Managed terminal instance metadata.
 */
export type TerminalView = { 
/**
 * Unique terminal identifier.
 */
id: string, 
/**
 * Working directory of the terminal process.
 */
cwd: string, 
/**
 * Shell executable path.
 */
shell: string, 
/**
 * Column count of the terminal grid.
 */
cols: number, 
/**
 * Row count of the terminal grid.
 */
rows: number, 
/**
 * Operational state of the terminal.
 */
status: TerminalStatus, };

/**
 * Single visual color theme definition.
 */
export type ThemeView = { 
/**
 * Unique theme identifier.
 */
id: string, 
/**
 * Display name.
 */
name: string, 
/**
 * Flag indicating whether this is a dark theme.
 */
dark: boolean, };

/**
 * Installed themes, and the theme configured for each ground.
 *
 * Two themes are configured at once, one per ground, which is the shape the
 * settings hold. Which of them is drawn is the window's own ground, so the
 * choice is made where that is known rather than stated here.
 */
export type ThemesView = { 
/**
 * List of all installed themes.
 */
themes: Array<ThemeView>, 
/**
 * Identifier of the theme configured for a dark ground.
 */
dark: string, 
/**
 * Identifier of the theme configured for a light ground.
 */
light: string, };

/**
 * The plan a session is working.
 *
 * A session whose board holds no task publishes no view at all, so the
 * presence of one is what the card is drawn from and there is no empty board
 * to distinguish from an absent one.
 */
export type TodoBoardView = { 
/**
 * The phases in the order the board records them.
 */
phases: Array<TodoPhaseView>, 
/**
 * Tasks closed across every phase.
 */
closed: number, 
/**
 * Tasks recorded across every phase.
 */
total: number, 
/**
 * The task in flight, or the first one waiting, or `None` once none is.
 */
current: TodoTaskView | null, };

/**
 * One phase of the plan, with the tally the host computed for it.
 */
export type TodoPhaseView = { 
/**
 * The phase as the board states it, numbered: `II. Shared`.
 */
name: string, 
/**
 * The phase's tasks, open work first.
 */
tasks: Array<TodoTaskView>, 
/**
 * Tasks of this phase that are finished with: done or abandoned.
 */
closed: number, 
/**
 * The next actionable task belongs to this phase.
 */
active: boolean, };

/**
 * One task of the plan.
 */
export type TodoTaskView = { 
/**
 * The task in the words the board records.
 */
content: string, 
/**
 * Where the task stands.
 */
status: TodoStatus, };

/**
 * Host presentation wrapper carrying disclosure state and view.
 */
export type ToolPresentation = { expanded: boolean, view: ToolView, };

/**
 * Fully revisioned node within a session's transcript tree.
 */
export type TranscriptEntry = { id: EntryId, parent: EntryId | null, revision: number, timestamp_ms: number, role: MessageRole, content: Array<ContentBlock>, meta: EntryMeta | null, raw_discriminator: string, raw: unknown, };

/**
 * The requests the tree sheet and the `/fork` row send, each tagged as the
 * wire names it.
 *
 * A family of its own rather than more variants of `HostAction`; the variant
 * that holds it is `untagged`, so a window still sends
 * `{"NavigateTree": {…}}` and the host still reads one flat action.
 */
export type TreeRequest = { "ForkSession": { session: SessionId, } } | { "LoadSessionTree": { session: SessionId, } } | { "NavigateTree": { session: SessionId, entry: EntryId, summarize: boolean, instructions: string | null, } } | { "AbortBranchSummary": { session: SessionId, } } | { "SetEntryLabel": { session: SessionId, entry: EntryId, label: string | null, } };

/**
 * Token and financial accounting totals associated with a turn.
 */
export type UsageTotals = { input_tokens: number, output_tokens: number, cache_read_tokens: number, cache_write_tokens: number, orchestration_tokens: number, premium_requests: number, cost_microusd: number | null, };

/**
 * Session resource and financial cost accounting totals.
 */
export type UsageView = { 
/**
 * Owning session identifier.
 */
session: SessionId, 
/**
 * Aggregated token counts and costs.
 */
totals: UsageTotals, };

/**
 * Container associating a monotonically increasing revision with payload.
 */
export type Versioned<T> = { revision: number, value: T, };

export const GUI_HOST_PROTOCOL_VERSION = 1;

export const ALL_SNAPSHOT_SECTIONS = [
	"Sessions",
	"ActiveSession",
	"Transcript",
	"SessionSearch",
	"SessionTranscript",
	"Capabilities",
	"Interactions",
	"Settings",
	"Diagnostics",
	"Changes",
	"FileTree",
	"FileContent",
	"SearchResults",
	"ContentMatches",
	"PromptHistory",
	"Terminals",
	"TerminalOutput",
	"Processes",
	"ProcessLogs",
	"Models",
	"Providers",
	"AuthFlow",
	"Mcp",
	"McpCatalog",
	"McpProbe",
	"McpRegistry",
	"Agents",
	"AgentComms",
	"Share",
	"Profiles",
	"Usage",
	"ContextBreakdown",
	"Export",
	"Themes",
	"Keybindings",
	"QueuedPrompts",
	"Commands",
	"AgentPause",
	"Goal",
	"Dictation",
	"ForegroundCommand",
	"AutoswarmConsole",
	"Todo",
	"Accounts",
	"Extensions",
	"Host",
	"Checkout",
	"Pace",
	"ServingAccount",
	"Quota",
	"ExtensionUi",
	"ComposerEdit",
	"ComposerCompletions",
	"ExtensionNotice",
	"SessionTree",
] as const;

export type SnapshotSectionTag = (typeof ALL_SNAPSHOT_SECTIONS)[number];

export const ALL_HOST_ACTIONS = [
	"Attach",
	"Detach",
	"RetryConnection",
	"Shutdown",
	"PauseAgents",
	"ResumeAgents",
	"ListSessions",
	"SearchSessions",
	"PreviewSessionTranscript",
	"OpenSession",
	"CreateSession",
	"RenameSession",
	"DeleteSession",
	"BranchSession",
	"ExportSession",
	"CompactSession",
	"HandoffSession",
	"LoadTranscript",
	"SubmitPrompt",
	"Steer",
	"FollowUp",
	"AbortTurn",
	"BackgroundCommand",
	"RetryTurn",
	"RephraseReply",
	"ReviewPlan",
	"SetQueueMode",
	"SetSessionMode",
	"CancelTool",
	"SetToolViewExpanded",
	"DequeueQueuedPrompt",
	"RespondToInteraction",
	"LoadFileTree",
	"ReadFile",
	"SearchFiles",
	"SearchContent",
	"SearchPromptHistory",
	"OpenExternal",
	"RefreshChanges",
	"SelectChangeScope",
	"CreateTerminal",
	"AttachTerminal",
	"WriteTerminal",
	"ResizeTerminal",
	"RestartTerminal",
	"ClearTerminal",
	"CloseTerminal",
	"RefreshProcesses",
	"ProcessLogs",
	"ProcessSend",
	"ProcessSignal",
	"ProcessStop",
	"ProcessRestart",
	"ProcessStart",
	"RefreshModels",
	"SelectModel",
	"SetThinkingLevel",
	"RefreshProviders",
	"StartProviderAuth",
	"SubmitAuthSecret",
	"OpenAuthUrl",
	"CancelAuthFlow",
	"RetryAuthFlow",
	"RefreshMcp",
	"SetMcpEnabled",
	"AddMcpServer",
	"RemoveMcpServer",
	"TestMcpServer",
	"ReauthMcpServer",
	"ClearMcpServerAuth",
	"ReloadMcp",
	"SearchMcpRegistry",
	"DeployMcpRegistryServer",
	"LoginMcpRegistry",
	"LogoutMcpRegistry",
	"RefreshAgents",
	"ReviveAgent",
	"SpawnTask",
	"CancelTask",
	"ListCommands",
	"RunCommand",
	"LoadSettings",
	"SetSetting",
	"ResetSetting",
	"LoadThemes",
	"LoadKeybindings",
	"SetKeybinding",
	"RefreshDiagnostics",
	"RetryDiagnosticSource",
	"ClearOutput",
	"GetUsage",
	"GetContextBreakdown",
	"SetGoal",
	"ControlGoal",
	"StartShare",
	"StopShare",
	"RefreshShare",
	"JoinShare",
	"LeaveShare",
	"RefreshProfiles",
	"CreateProfile",
	"RenameProfile",
	"DeleteProfile",
	"ToggleDictation",
	"CancelDictation",
	"SetAutoswarmField",
	"RunAutoswarmAction",
	"SaveAutoswarmPreset",
	"DeleteAutoswarmPreset",
	"CloseAutoswarmConsole",
	"SignOutAccount",
	"RefreshExtensions",
	"SetExtensionEnabled",
	"SetExtensionSourceEnabled",
	"ReportComposerDraft",
	"CompleteComposer",
	"ForkSession",
	"LoadSessionTree",
	"NavigateTree",
	"AbortBranchSummary",
	"SetEntryLabel",
] as const;

export type HostActionTag = (typeof ALL_HOST_ACTIONS)[number];

export const ACTION_TO_CAPABILITY: Record<HostActionTag, Capability> = {
	Attach: "Lifecycle",
	Detach: "Lifecycle",
	RetryConnection: "Lifecycle",
	Shutdown: "Lifecycle",
	PauseAgents: "Lifecycle",
	ResumeAgents: "Lifecycle",
	ListSessions: "Sessions",
	SearchSessions: "Sessions",
	PreviewSessionTranscript: "Transcript",
	OpenSession: "Sessions",
	CreateSession: "Sessions",
	RenameSession: "Sessions",
	DeleteSession: "SessionDeletion",
	BranchSession: "SessionTreeNavigation",
	ExportSession: "Sessions",
	CompactSession: "Sessions",
	HandoffSession: "Sessions",
	LoadTranscript: "Transcript",
	SubmitPrompt: "TurnControl",
	Steer: "TurnControl",
	FollowUp: "TurnControl",
	AbortTurn: "TurnControl",
	BackgroundCommand: "ForegroundCommand",
	RetryTurn: "TurnControl",
	RephraseReply: "TurnControl",
	ReviewPlan: "Approvals",
	SetQueueMode: "TurnControl",
	SetSessionMode: "Sessions",
	CancelTool: "Tools",
	SetToolViewExpanded: "Tools",
	DequeueQueuedPrompt: "TurnControl",
	RespondToInteraction: "Approvals",
	LoadFileTree: "Files",
	ReadFile: "Files",
	SearchFiles: "Files",
	SearchContent: "Files",
	SearchPromptHistory: "PromptHistory",
	OpenExternal: "Files",
	RefreshChanges: "Changes",
	SelectChangeScope: "Changes",
	CreateTerminal: "Terminals",
	AttachTerminal: "Terminals",
	WriteTerminal: "Terminals",
	ResizeTerminal: "Terminals",
	RestartTerminal: "Terminals",
	ClearTerminal: "Terminals",
	CloseTerminal: "Terminals",
	RefreshProcesses: "ProcessSupervisor",
	ProcessLogs: "ProcessSupervisor",
	ProcessSend: "ProcessSupervisor",
	ProcessSignal: "ProcessSupervisor",
	ProcessStop: "ProcessSupervisor",
	ProcessRestart: "ProcessSupervisor",
	ProcessStart: "ProcessSupervisor",
	RefreshModels: "Models",
	SelectModel: "Models",
	SetThinkingLevel: "Models",
	RefreshProviders: "Providers",
	StartProviderAuth: "Authentication",
	SubmitAuthSecret: "Authentication",
	OpenAuthUrl: "Authentication",
	CancelAuthFlow: "Authentication",
	RetryAuthFlow: "Authentication",
	RefreshMcp: "Mcp",
	SetMcpEnabled: "Mcp",
	AddMcpServer: "Mcp",
	RemoveMcpServer: "Mcp",
	TestMcpServer: "Mcp",
	ReauthMcpServer: "Mcp",
	ClearMcpServerAuth: "Mcp",
	ReloadMcp: "Mcp",
	SearchMcpRegistry: "Mcp",
	DeployMcpRegistryServer: "Mcp",
	LoginMcpRegistry: "Mcp",
	LogoutMcpRegistry: "Mcp",
	RefreshAgents: "Agents",
	ReviveAgent: "Agents",
	SpawnTask: "Tasks",
	CancelTask: "Tasks",
	ListCommands: "AgentCommands",
	RunCommand: "AgentCommands",
	LoadSettings: "Settings",
	SetSetting: "Settings",
	ResetSetting: "Settings",
	LoadThemes: "Themes",
	LoadKeybindings: "Keybindings",
	SetKeybinding: "Keybindings",
	RefreshDiagnostics: "Diagnostics",
	RetryDiagnosticSource: "Diagnostics",
	ClearOutput: "Sessions",
	GetUsage: "Usage",
	GetContextBreakdown: "ContextBreakdown",
	SetGoal: "Goals",
	ControlGoal: "Goals",
	StartShare: "Share",
	StopShare: "Share",
	RefreshShare: "Share",
	JoinShare: "Share",
	LeaveShare: "Share",
	RefreshProfiles: "Profiles",
	CreateProfile: "Profiles",
	RenameProfile: "Profiles",
	DeleteProfile: "Profiles",
	ToggleDictation: "Dictation",
	CancelDictation: "Dictation",
	SetAutoswarmField: "Autoswarm",
	RunAutoswarmAction: "Autoswarm",
	SaveAutoswarmPreset: "Autoswarm",
	DeleteAutoswarmPreset: "Autoswarm",
	CloseAutoswarmConsole: "Autoswarm",
	SignOutAccount: "Authentication",
	RefreshExtensions: "Extensions",
	SetExtensionEnabled: "Extensions",
	SetExtensionSourceEnabled: "Extensions",
	ReportComposerDraft: "Extensions",
	CompleteComposer: "Extensions",
	ForkSession: "SessionTreeNavigation",
	LoadSessionTree: "SessionTreeNavigation",
	NavigateTree: "SessionTreeNavigation",
	AbortBranchSummary: "SessionTreeNavigation",
	SetEntryLabel: "SessionTreeNavigation",
};

export const SHARE_PHASES = [
	"off",
	"starting",
	"hosting",
	"stopping",
	"joining",
	"joined",
	"leaving",
] as const;

export type SharePhase = (typeof SHARE_PHASES)[number];

export const ALL_CAPABILITIES = [
	"Sessions",
	"SessionDeletion",
	"SessionTreeNavigation",
	"Transcript",
	"TurnControl",
	"BackgroundSubmission",
	"Tools",
	"Approvals",
	"Questions",
	"Plans",
	"Files",
	"Changes",
	"PendingEdits",
	"Terminals",
	"ProcessSupervisor",
	"Models",
	"Providers",
	"Authentication",
	"Mcp",
	"Extensions",
	"Agents",
	"AgentCommands",
	"Tasks",
	"Settings",
	"Themes",
	"Keybindings",
	"Diagnostics",
	"Usage",
	"ContextBreakdown",
	"Lifecycle",
	"Goals",
	"Share",
	"Profiles",
	"Dictation",
	"PromptHistory",
	"ForegroundCommand",
	"Autoswarm",
	"Todo",
] as const satisfies readonly Capability[];

export const ALL_GOAL_CONTROLS = [
	"pause",
	"resume",
	"drop",
] as const satisfies readonly GoalControl[];

export const SETTABLE_MODES = [
	"plan",
	"vibe",
	"loop",
	"none",
] as const satisfies readonly SettableMode[];

export const ALL_GOAL_STATUSES = [
	"active",
	"paused",
	"budget_limited",
	"complete",
	"dropped",
] as const satisfies readonly GoalStatus[];

export const ALL_AUTOSWARM_ACTIONS = [
	"start",
	"resume",
	"pause",
	"new",
	"stop",
	"clear",
	"reset",
] as const satisfies readonly AutoswarmAction[];

export const ALL_AUTOSWARM_FIELD_KINDS = [
	"Text",
	"Stepper",
	"Toggle",
	"Segmented",
] as const satisfies readonly AutoswarmFieldKind[];

export const AGENT_MESSAGE_OUTCOMES = [
	"injected",
	"woken",
	"revived",
	"failed",
] as const satisfies readonly AgentMessageOutcome[];

export const DICTATION_STATES = [
	"idle",
	"recording",
	"transcribing",
] as const satisfies readonly DictationState[];

export const SHARE_ROLES = [
	"Off",
	"Hosting",
	"Guest",
] as const satisfies readonly ShareRole[];

export const ALL_EXPORT_FORMATS = [
	"html",
	"json",
] as const satisfies readonly ExportFormat[];

export const SESSION_TREE_FILTERS = [
	"default",
	"no-tools",
	"user-only",
	"labeled-only",
	"all",
] as const satisfies readonly SessionTreeFilter[];

export const SESSION_TREE_ENTRY_KINDS = [
	"user",
	"developer",
	"assistant",
	"tool_result",
	"bash",
	"custom_message",
	"compaction",
	"branch_summary",
	"model_change",
	"thinking_change",
	"label",
	"custom",
	"other",
] as const satisfies readonly SessionTreeEntryKind[];
