//! Pure reducers for frontend commands and host events.

mod apply;
mod dispatch;

use std::collections::{BTreeMap, VecDeque};

use crate::{host::HostRequest, model::*, navigation::FrontendState};

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub enum CommandTarget {
	Connection,
	Sessions,
	Session(SessionId),
	Draft(SessionId),
	Transcript(SessionId),
	Tool(ToolId),
	Interaction(InteractionId),
	Files,
	Changes,
	Terminal(TerminalId),
	Terminals,
	Process(ProcessId),
	Models,
	Providers,
	Authentication,
	Mcp(Option<McpServerId>),
	Extensions,
	Agents,
	Agent(AgentId),
	Task(TaskId),
	Settings(Option<SettingPath>),
	Themes,
	Keybindings,
	Diagnostics,
	Output,
	Usage,
	Context,
	Lifecycle,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FocusTarget {
	Composer,
	Palette,
	Interaction,
	RenameField,
	Terminal(TerminalId),
	Shell,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ShellEffect {
	Focus(FocusTarget),
	ChooseAttachments {
		session:     SessionId,
		images_only: bool,
		replace:     Option<AttachmentId>,
	},
	QuitWindow,
	CopyText(String),
	RequestPaste(TerminalId),
	RevealSelection,
	RevealFile(FileId),
	ScrollTranscriptToLatest,
	ScrollTranscriptToOldest,
	Notify {
		message: String,
	},
	SystemNotification {
		tag:   NotificationKey,
		title: String,
		body:  Option<String>,
	},
	Chime {
		tone: NotificationTone,
	},
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct Effects {
	pub requests: Vec<HostRequest>,
	pub shell:    Vec<ShellEffect>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Changes {
	pub connection:          bool,
	pub replica:             bool,
	pub frontend:            bool,
	pub ignored_stale_event: bool,
	pub completed_request:   Option<RequestId>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Completion {
	None,
	ClearDraft(SessionId),
	CloseInteraction(InteractionId),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PendingRecord {
	pub target:     CommandTarget,
	pub completion: Completion,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Store {
	pub connection:      ConnectionState,
	pub replica:         Replica,
	pub frontend:        FrontendState,
	next_request:        RequestId,
	next_attachment:     u64,
	next_review_thread:  u64,
	next_review_comment: u64,
	next_change_request: u64,
	outbox:              VecDeque<HostRequest>,
	pending:             BTreeMap<RequestId, PendingRecord>,
	command_states:      BTreeMap<CommandTarget, CommandState>,
}

impl Store {
	pub fn detached() -> Self {
		let frontend = FrontendState { terminal_split_ratio_milli: 500, ..FrontendState::default() };
		Self {
			connection: ConnectionState::Detached,
			replica: Replica::default(),
			frontend,
			next_request: RequestId::FIRST,
			next_attachment: 1,
			next_review_thread: 1,
			next_review_comment: 1,
			next_change_request: 1,
			outbox: VecDeque::new(),
			pending: BTreeMap::new(),
			command_states: BTreeMap::new(),
		}
	}

	pub fn command_state(&self, target: &CommandTarget) -> CommandState {
		self.command_states.get(target).cloned().unwrap_or_default()
	}

	/// Whether a request for this target is in flight.
	///
	/// A surface that offers to fetch something reads this to stop offering it
	/// twice, and an automatic fetch reads it to stop asking again.
	pub fn request_pending(&self, target: &CommandTarget) -> bool {
		matches!(self.command_state(target), CommandState::Pending { .. })
	}

	pub fn drain_requests(&mut self) -> Vec<HostRequest> {
		self.outbox.drain(..).collect()
	}

	pub(crate) fn emit(
		&mut self,
		action: crate::host::HostAction,
		target: CommandTarget,
		completion: Completion,
		effects: &mut Effects,
	) {
		let id = self.next_request;
		self.next_request = self.next_request.next();
		self
			.command_states
			.insert(target.clone(), CommandState::Pending { request: id });
		self
			.pending
			.insert(id, PendingRecord { target, completion });
		let request = HostRequest { id, action };
		self.outbox.push_back(request.clone());
		effects.requests.push(request);
	}

	pub(crate) fn next_attachment_id(&mut self) -> Result<AttachmentId, EmptyId> {
		let value = self.next_attachment;
		self.next_attachment = self.next_attachment.saturating_add(1);
		AttachmentId::new(format!("attachment-{value}"))
	}

	pub(crate) fn next_review_thread_id(&mut self) -> ReviewThreadId {
		let value = self.next_review_thread;
		self.next_review_thread = self.next_review_thread.saturating_add(1);
		ReviewThreadId::new(format!("thread-{value}"))
	}

	pub(crate) fn next_review_comment_id(&mut self) -> ReviewCommentId {
		let value = self.next_review_comment;
		self.next_review_comment = self.next_review_comment.saturating_add(1);
		ReviewCommentId::new(format!("comment-{value}"))
	}

	pub(crate) fn next_change_request_id(&mut self) -> ChangeRequestId {
		let value = self.next_change_request;
		self.next_change_request = self.next_change_request.saturating_add(1);
		ChangeRequestId::new(format!("cr-{value}"))
	}
}

impl Default for Store {
	fn default() -> Self {
		Self::detached()
	}
}

#[cfg(test)]
mod tests;
