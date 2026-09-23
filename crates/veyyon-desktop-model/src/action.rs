mod request;

use serde::{Deserialize, Serialize};

pub use self::request::{AttachmentSubmission, GoalControl, HostRequest};
pub use crate::action_kind::{HostActionKind, HostActionKind as Kind};
use crate::{
	composer::QueueMode,
	connection::{EntryId, SessionId},
	domain::changes::ChangeScope,
	session::SettableMode,
	signal::SupervisorSignal,
};

/// Host actions across connection, session and interactive domains.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum HostAction {
	// Connection family (6 actions)
	Attach {
		endpoint: Option<String>,
	},
	Detach,
	RetryConnection,
	Shutdown,
	/// Freeze every agent in the host process at its next action boundary.
	///
	/// Process-wide rather than per session: the host holds one gate, and a
	/// turn already streaming finishes the call it is on before it parks, so
	/// nothing is aborted and nothing is lost. Refused when a pause is
	/// already engaged, so two windows pressing it never stack two releases.
	PauseAgents,
	/// Release the freeze, waking every parked agent. Refused when nothing is
	/// paused, so a stale window cannot release a pause that already ended.
	ResumeAgents,

	// Sessions family (10 actions)
	ListSessions,
	SearchSessions {
		query: String,
	},
	PreviewSessionTranscript {
		session: SessionId,
	},
	OpenSession {
		session: SessionId,
	},
	CreateSession {
		workspace: Option<String>,
		title:     Option<String>,
	},
	RenameSession {
		session: SessionId,
		title:   String,
	},
	DeleteSession {
		session: SessionId,
	},
	BranchSession {
		session: SessionId,
		entry:   Option<EntryId>,
	},
	ExportSession {
		session: SessionId,
		format:  String,
	},
	CompactSession {
		session: SessionId,
	},
	HandoffSession {
		session: SessionId,
		target:  String,
	},
	LoadTranscript {
		session: SessionId,
		before:  Option<EntryId>,
	},

	// Turn control family (11 actions)
	SubmitPrompt {
		session:     SessionId,
		text:        String,
		attachments: Vec<AttachmentSubmission>,
	},
	Steer {
		session: SessionId,
		text:    String,
	},
	FollowUp {
		session: SessionId,
		text:    String,
	},
	AbortTurn {
		session: SessionId,
	},
	/// Runs the last turn again, after it failed or was stopped.
	///
	/// The turn is the session's last, so the request names no turn: a host
	/// with nothing failed to run again refuses it, which is the same answer
	/// the terminal's `/retry` prints.
	RetryTurn {
		session: SessionId,
	},
	/// Asks for the reply just given again, in plainer prose.
	///
	/// The host sends its own request as the next turn, so the window supplies
	/// no text: the wording is the product's, and a session whose last turn is
	/// not a finished reply refuses it.
	RephraseReply {
		session: SessionId,
	},
	/// Raises the plan the agent last wrote for review again.
	///
	/// A plan decision is ordinarily raised by the agent, from inside the
	/// tool call that asks for approval. This asks for the same decision
	/// without one: the newest plan file the session wrote is read and put
	/// back in front of the operator, which is how a plan is reviewed after
	/// the card was answered, or before the agent has asked at all. A
	/// session that is not in plan mode, and one whose workspace holds no
	/// plan file, refuse it.
	ReviewPlan {
		session: SessionId,
	},
	SetQueueMode {
		session: SessionId,
		mode:    QueueMode,
	},
	/// Puts the session in a mode, or takes it out of the one it is in.
	///
	/// `SettableMode::None` leaves whatever mode the session was in, which is
	/// the same request the host reads as a mode of `none`. A host that
	/// declines a mode answers with its own refusal rather than the window
	/// guessing which modes it has.
	SetSessionMode {
		session: SessionId,
		mode:    SettableMode,
	},
	CancelTool {
		session:      SessionId,
		tool_call_id: String,
	},
	SetToolViewExpanded {
		session:  SessionId,
		call_id:  String,
		expanded: bool,
	},
	/// Takes the newest prompt back out of the session's queue, which is the
	/// order the runtime releases them in.
	DequeueQueuedPrompt {
		session: SessionId,
	},
	RespondToInteraction {
		session:        SessionId,
		interaction_id: String,
		response:       serde_json::Value,
	},

	// Files family (4 actions)
	LoadFileTree {
		root: Option<String>,
	},
	ReadFile {
		path: String,
	},
	SearchFiles {
		query: String,
	},
	/// The lines of the workspace's files that carry `query`, taken as literal
	/// text rather than as a pattern.
	SearchContent {
		query: String,
	},
	OpenExternal {
		path: String,
	},

	// Changes family (2 actions)
	RefreshChanges,
	SelectChangeScope {
		scope: ChangeScope,
	},

	// Terminals family (7 actions)
	CreateTerminal {
		cwd:   Option<String>,
		shell: Option<String>,
	},
	AttachTerminal {
		terminal_id: String,
	},
	WriteTerminal {
		terminal_id: String,
		data:        Vec<u8>,
	},
	ResizeTerminal {
		terminal_id: String,
		cols:        u16,
		rows:        u16,
	},
	RestartTerminal {
		terminal_id: String,
	},
	ClearTerminal {
		terminal_id: String,
	},
	CloseTerminal {
		terminal_id: String,
	},

	// Process supervisor family (9 actions)
	RefreshProcesses,
	ProcessLogs {
		process_id: String,
		follow:     bool,
	},
	ProcessSend {
		process_id: String,
		data:       Vec<u8>,
	},
	/// Sends one of the supervisor's signals to a process it manages.
	///
	/// Every signal the supervisor accepts is a variant of
	/// [`SupervisorSignal`], so the action cannot carry a name the supervisor
	/// rejects and the window has no default to fall back on.
	ProcessSignal {
		process_id: String,
		signal:     SupervisorSignal,
	},
	ProcessStop {
		process_id: String,
	},
	ProcessRestart {
		process_id: String,
	},
	ProcessStart {
		command: String,
		args:    Vec<String>,
	},

	// Models family (3 actions)
	RefreshModels,
	/// Runs the session on a model.
	///
	/// `persist` writes it as the default role, which is what choosing a model
	/// means; a session-only try sends `false`, and the host applies it to the
	/// session without touching the operator's configuration.
	SelectModel {
		provider: String,
		model:    String,
		persist:  bool,
	},
	SetThinkingLevel {
		level: String,
	},

	// Auth and Providers family (6 actions)
	RefreshProviders,
	StartProviderAuth {
		provider: String,
	},
	SubmitAuthSecret {
		provider: String,
		secret:   String,
	},
	OpenAuthUrl {
		url: String,
	},
	CancelAuthFlow {
		provider: String,
	},
	RetryAuthFlow {
		provider: String,
	},

	// MCP family (2 actions)
	RefreshMcp,
	SetMcpEnabled {
		server:  String,
		enabled: bool,
	},

	// Agents and Tasks family (4 actions)
	RefreshAgents,
	ReviveAgent {
		agent_id: String,
	},
	SpawnTask {
		task: String,
	},
	CancelTask {
		task_id: String,
	},

	// Commands family (2 actions)
	/// Asks for every slash command the host will run, which is what the
	/// palette lists: the window declares none of them itself.
	ListCommands,
	/// Runs one command line, spelled the way the composer accepts it:
	/// `/compact focus`, leading slash and arguments included. The host
	/// parses it, and a command that leaves a prompt behind runs that prompt
	/// as the session's next turn.
	RunCommand {
		session: SessionId,
		text:    String,
	},

	// Settings family (6 actions)
	LoadSettings,
	SetSetting {
		key:   String,
		value: serde_json::Value,
	},
	ResetSetting {
		key: String,
	},
	LoadThemes,
	LoadKeybindings,
	SetKeybinding {
		action: String,
		keys:   Vec<String>,
	},

	// Diagnostics and Usage family (5 actions)
	RefreshDiagnostics,
	RetryDiagnosticSource {
		source: String,
	},
	ClearOutput {
		session: SessionId,
	},
	GetUsage {
		session: Option<SessionId>,
	},
	GetContextBreakdown {
		session: SessionId,
	},

	// Goal mode family (2 actions)
	SetGoal {
		session:      SessionId,
		objective:    String,
		token_budget: Option<u64>,
	},
	ControlGoal {
		session: SessionId,
		op:      GoalControl,
	},

	// Share family (5 actions)
	StartShare {
		read_only: bool,
	},
	StopShare,
	RefreshShare,
	JoinShare {
		#[serde(skip_serializing_if = "Option::is_none")]
		session: Option<SessionId>,
		link:    String,
	},
	LeaveShare,
	// Profile family (4 actions)
	RefreshProfiles,
	CreateProfile {
		name: String,
		/// Copy-item keys seeded from the active profile; empty makes a blank
		/// profile.
		copy: Vec<String>,
	},
	RenameProfile {
		name:         String,
		display_name: String,
	},
	DeleteProfile {
		name: String,
	},
}
