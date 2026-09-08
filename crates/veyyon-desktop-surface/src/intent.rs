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

use veyyon_desktop_model::SurfaceId;

mod apply;

use crate::{
	composer::{Attachment, ModelChoice, QueueMode, ThinkingLevel},
	keymap::ScrollBy,
	model::ShellState,
	overlay::Overlay,
	palette::PaletteState,
};

/// One thing the operator did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Intent {
	SelectSession(u64),
	SelectTab(usize),
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
	Plan {
		card:     usize,
		accepted: bool,
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
	SelectModel(ModelChoice),
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
	SelectTheme(String),
	ReloadSettings,
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
	ProcessStop(String),
	ProcessRestart(String),
	ProcessSignal(String),
	PinSession(u64),
	UnpinSession(u64),
	DeferSession(u64),
	ParkSession(u64),
	UnparkSession(u64),
	RecallSession(u64),
	DeleteSession(u64),
	BranchSession(u64),
	FilterQueue(String),
	NewSession,
	CloseTabOrPark,
	MoveQueueSelection(i32),
	ScrollTranscript(ScrollBy),
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
}

impl Intent {
	/// Whether this intent moves a session between queue partitions.
	///
	/// The window owns the partitions, so nothing arrives from the host to
	/// redraw the rail after one of these: the projection is re-run for them
	/// (§5.2). An intent added to a partition pair and left out here moves the
	/// session and leaves the rail showing where it was.
	pub const fn moves_partition(&self) -> bool {
		matches!(
			self,
			Self::PinSession(_)
				| Self::UnpinSession(_)
				| Self::DeferSession(_)
				| Self::RecallSession(_)
				| Self::ParkSession(_)
				| Self::UnparkSession(_)
		)
	}

	/// Whether the shell can finish this intent alone.
	pub const fn is_local(&self) -> bool {
		matches!(
			self,
			Self::SelectTab(_)
				| Self::Attach(_)
				| Self::RemoveAttachment(_)
				| Self::SelectDrawerTab(_)
				| Self::SetDrawer { open: false }
				| Self::SetPanel { open: false }
				| Self::OpenOverlay(_)
				| Self::CloseOverlay
				| Self::CloseTabOrPark
				| Self::PaletteMove(_)
				| Self::PaletteQuery(_)
				| Self::FilterQueue(_)
				| Self::MoveQueueSelection(_)
				| Self::ScrollTranscript(_)
				| Self::FindInTranscript
				| Self::StepTurn(_)
				| Self::ToggleBlock
				| Self::ToggleQueue
				| Self::SetDiffMode(_)
				| Self::ToggleTreeNode(_)
				| Self::ExpandContext { .. }
		)
	}

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

impl Intents {
	/// An empty record.
	pub const fn new() -> Self {
		Self { pending: Vec::new() }
	}

	/// Applies what the operator did, and records what a host must answer.
	///
	/// Running a palette command is the command: the palette closes and the
	/// command is dispatched as if its own control had been clicked, so one
	/// that needs a host reaches the host.
	pub fn dispatch(&mut self, intent: Intent, state: &mut ShellState) {
		if match &intent {
			Intent::Send { text, .. } | Intent::Steer(text) | Intent::Queue(text) => {
				text.trim().is_empty()
			},
			_ => false,
		} {
			return;
		}

		if intent == Intent::PaletteRun
			&& let Some(run) = state.overlay_palette().and_then(PaletteState::run_intent)
		{
			state.overlay = None;
			self.dispatch(run, state);
			return;
		}

		if intent == Intent::CloseTabOrPark && state.panel.tabs.len() <= 1 {
			self.dispatch(Intent::ParkSession(state.current_id), state);
			return;
		}

		intent.apply(state);
		if !intent.is_local() {
			self.pending.push(intent);
		}
	}

	/// Takes the intents a host has not seen yet.
	pub fn drain(&mut self) -> Vec<Intent> {
		std::mem::take(&mut self.pending)
	}

	/// The intents recorded and not yet drained, in the order they happened.
	pub fn pending(&self) -> &[Intent] {
		&self.pending
	}
}
