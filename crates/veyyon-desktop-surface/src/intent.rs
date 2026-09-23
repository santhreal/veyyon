//! What the operator asked the shell to do.
//!
//! An intent is separated from its effect because the two have different
//! owners. Some of what an intent changes belongs to the window alone: which
//! row is drawn as open, which tab the panel shows, whether the drawer is
//! docked. The rest belongs to a host: approving a tool call, answering a
//! question, sending a message, and streaming the session that was just
//! opened.
//!
//! So an intent is applied locally for the part the shell owns, and is also
//! recorded when something outside the window has to answer it. A surface never
//! talks to a host directly, which is what keeps every surface renderable with
//! no host attached.

use veyyon_desktop_model::{SettableMode, SupervisorSignal, SurfaceId};

mod apply;
mod classify;
mod pending;

use crate::{
	composer::{Attachment, ModelChoice, QueueMode, ThinkingLevel},
	keymap::ScrollBy,
	menu::MenuSectionId,
	model::ShellState,
	overlay::Overlay,
	right_panel::PanelTab,
};

/// One thing the operator did.
#[derive(Debug, Clone, PartialEq, Eq, strum::EnumDiscriminants)]
#[strum_discriminants(derive(strum::EnumIter))]
#[strum_discriminants(vis(pub))]
pub enum Intent {
	SelectSession(u64),
	/// Selects an existing session by its host identity, never a new runtime.
	OpenSession(veyyon_desktop_model::SessionId),
	CloseSessionTab(veyyon_desktop_model::SessionId),
	ReorderSessionTab {
		session: veyyon_desktop_model::SessionId,
		target:  veyyon_desktop_model::SessionId,
	},
	CreateSpace(String),
	RenameSpace {
		id:   u64,
		name: String,
	},
	SwitchSpace(u64),
	FindSessions(String),
	PreviewSession(String),
	ResumeHistory(String),
	/// The workspace tab the operator moved to. The tab travels rather than
	/// its index, because the panel's tab list is window state a host never
	/// sees, and what the tab draws is a domain the host has to re-state.
	SelectTab(PanelTab),
	/// Closes the workspace tab in the right panel. The tab travels rather than
	/// its index, because the panel's tab list is window state a host never
	/// sees, and what the tab draws is a domain the host has to re-state.
	CloseTab(PanelTab),
	SetDrawer {
		open: bool,
	},
	Approval {
		card:     usize,
		approved: bool,
		standing: bool,
	},
	Answer {
		card:   usize,
		option: usize,
	},
	Reply {
		card: usize,
		text: String,
	},
	/// A plan review answered: accepted as written, or sent back with the
	/// refinement the draft states. The refinement travels with the answer
	/// because the agent is inside the call that raised the plan and reads its
	/// result; a refusal that carried nothing told it only to try again.
	Plan {
		card:     usize,
		accepted: bool,
		feedback: String,
	},
	/// A prompt and the images and clips it carries, sent as the next turn.
	Send {
		text:        String,
		attachments: Vec<Attachment>,
	},
	Steer(String),
	Queue(String),
	AbortTurn,
	SetQueueMode(QueueMode),
	/// Puts the session in a mode, or takes it out of one.
	///
	/// A mode was reachable only by starting a session with the setting for it
	/// already on, which is a decision an operator makes about the next task
	/// rather than about every session. `SettableMode::None` leaves whichever
	/// mode the session is in.
	SetSessionMode {
		mode: SettableMode,
	},
	/// Runs the session on a model, saved as the default or tried for this
	/// session alone.
	SelectModel {
		choice:  ModelChoice,
		persist: bool,
	},
	SetThinking(ThinkingLevel),
	/// Takes the newest queued prompt back out of the runtime into the composer.
	DequeueQueuedPrompt,
	/// An image or clip read and admitted, added to the next prompt.
	Attach(Attachment),
	RemoveAttachment(usize),
	RetryConnection,
	StartProviderAuth(String),
	SubmitAuthSecret {
		provider: String,
		secret:   String,
	},
	OpenAuthUrl(String),
	CancelAuthFlow,
	RetryAuthFlow,
	RetryControl(SurfaceId),
	DismissError(SurfaceId),
	OpenOverlay(Box<Overlay>),
	Navigate(crate::navigation::SurfaceRoute),
	CloseOverlay,
	SetAgentsTab(crate::agents::AgentViewTab),
	ConfirmTermination(Option<String>),
	/// Ranks the rows a mode already holds against what was typed. The rows
	/// come from the window, so nothing is asked of the host.
	PaletteQuery(String),
	PaletteMove(i32),
	PaletteRun,
	/// Lists one directory in Browse mode: `None` is the workspace root, and
	/// a path is the directory a row named or the parent an ascent reached.
	BrowseTo {
		path: Option<String>,
	},
	/// Looks a file up by name in Files mode: the empty query opens the mode
	/// on the workspace tree, and a query is answered by the host's search.
	FindFile(String),
	/// Looks text up across the workspace's files in Content Search mode.
	/// The empty query opens the mode, which lists nothing until something
	/// is typed, since there is no whole-workspace listing of lines.
	FindText(String),
	SettingChanged {
		key:   String,
		value: serde_json::Value,
	},
	ResetSetting(String),
	/// Rebinds the keymap action `action` to the alternatives `keys`, from
	/// the field the Keybindings page draws beside that action's row.
	KeybindingChanged {
		action: String,
		keys:   Vec<String>,
	},
	/// Runs `task` as a background subagent of the active session, from the
	/// field the Agents page draws above its listing.
	SpawnTask(String),
	/// Configures `id` as the theme for the ground it is drawn on. A dark theme
	/// becomes the dark-ground theme and a light one the light-ground theme,
	/// which is the pair the settings hold; choosing a theme never changes
	/// which ground the window is on.
	SelectTheme {
		id:   String,
		dark: bool,
	},
	/// Draws the window in the appearance the pointer is resting on, and puts
	/// the chosen one back when it carries nothing (§6.9).
	PreviewAppearance(Option<String>),
	/// Settles the window on an appearance, which a relaunch comes back in
	/// (§6.9).
	SelectAppearance(String),
	ReloadSettings,
	/// Takes the announcement with this key off the stack, which a press on
	/// its card means (§5.15).
	DismissNotice(String),
	SetMcpEnabled {
		server:  String,
		enabled: bool,
	},
	RefreshDiagnostics,
	RetryDiagnosticSource(String),
	RefreshUsage,
	TerminalInput(Vec<u8>),
	ResizeTerminal {
		cols: u16,
		rows: u16,
	},
	SelectDrawerTab(usize),
	OpenProcessLogs(String),
	ClearTerminal,
	RestartTerminal,
	CloseTerminal,
	/// Opens one more terminal in the drawer, and the first one back into a
	/// drawer whose last terminal was closed.
	NewTerminal,
	ClearOutput,
	CancelTool {
		call_id: String,
	},
	ProcessStart {
		command: String,
		args:    Vec<String>,
	},
	ProcessSend {
		process: String,
		data:    Vec<u8>,
	},
	ProcessStop(String),
	ProcessRestart(String),
	/// Sends one signal to a supervised process. The signal is the operator's
	/// choice, because the supervisor answers five of them and a process that
	/// ignores one is the reason to reach for another.
	ProcessSignal {
		process: String,
		signal:  SupervisorSignal,
	},
	PinSession(u64),
	UnpinSession(u64),
	DeferSession(u64),
	ParkSession(u64),
	UnparkSession(u64),
	RecallSession(u64),
	DeleteSession(u64),
	BranchSession(u64),
	/// Forks the open session at the prompt one drawn turn holds, so a road
	/// not taken is reachable from the turn that took the other one rather
	/// than only from the transcript's last prompt.
	BranchTurn(usize),
	/// Runs the open session's last turn again, after it failed or was
	/// stopped.
	RetryTurn,
	/// Asks the agent for the reply it just gave again, in plainer prose.
	RephraseReply,
	/// Puts the plan the agent last wrote back in front of the operator,
	/// without waiting for the agent to ask for it again.
	ReviewPlan,
	SetGoal {
		objective:    String,
		token_budget: Option<u64>,
	},
	ControlGoal {
		op: veyyon_desktop_model::GoalControl,
	},
	ToggleGoalCard,
	/// Freezes every agent the host runs, whatever session it belongs to.
	PauseAgents,
	/// Releases the freeze, waking every agent the host parked.
	ResumeAgents,
	/// Starts sharing this session over the configured relay.
	StartShare {
		read_only: bool,
	},
	/// Stops sharing this session.
	StopShare,
	/// Asks the host for the share as it stands, participants included.
	RefreshShare,
	RenameSession {
		session: u64,
		title:   String,
	},
	ExportSession(Option<u64>),
	CompactSession(Option<u64>),
	HandoffSession(Option<u64>),
	LoadTranscript(Option<u64>),
	FilterQueue(String),
	NewSession,
	CloseTabOrPark,
	MoveQueueSelection(i32),
	/// Folds or unfolds the branch a rail row roots, named by the path the
	/// session occupies.
	///
	/// A fold decides which rows exist, so it is written where a projection
	/// reads it back rather than into the frame the window is drawing: a
	/// fold held only in the drawn state is undone by the next host event.
	ToggleQueueParent(String),
	ScrollTranscript(ScrollBy),
	/// Puts the text a surface states on the clipboard. The words travel with
	/// the intent because they are the words that were drawn, not a second
	/// reading of the store.
	CopyText(String),
	FindInTranscript,
	StepTurn(i32),
	ToggleBlock,
	SetToolViewExpanded {
		call_id:  String,
		expanded: bool,
	},
	OpenToolTarget(crate::tool_view::ToolViewTarget),
	ToggleQueue,
	SetPanel {
		open: bool,
	},
	SetDiffMode(veyyon_desktop_model::DiffMode),
	OpenFile(String),
	OpenUsage,
	ToggleTreeNode(String),
	ExpandContext {
		file: usize,
		row:  usize,
	},
	SelectChangeScope(veyyon_desktop_model::ChangeScope),
	/// Runs one slash command the host advertises, spelled as the host reads
	/// it: the command's own name and whatever was written after it. The
	/// window holds no table of these, so a command a workspace installs is
	/// run by the same path as a builtin (§5.8).
	RunCommand(String),
	/// Opens one menu of the bar, closes the bar when that menu is already
	/// open, and closes it outright with `None`.
	SetMenuSection(Option<MenuSectionId>),
	/// Moves the keyboard inside the open menu, by entries.
	MoveMenuHighlight(i32),
	/// Moves the open menu along the bar, by sections.
	MoveMenuSection(i32),
	/// Takes the verb the keyboard is on in the open menu.
	/// Closes this window, leaving the process up where something can bring
	/// a window back.
	CloseWindow,
	/// Ends the process, after what is held is written.
	Quit,
}

impl Intent {
	/// Applies the part of this intent the shell owns.
	pub fn apply(&self, state: &mut ShellState) {
		apply::apply_intent(self, state);
	}
}

/// The intents recorded for a host, and the one place an intent is applied.
#[derive(Debug, Default)]
pub struct Intents {
	pending: Vec<Intent>,
}
