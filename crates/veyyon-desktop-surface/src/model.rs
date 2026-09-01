//! What the surfaces draw.
//!
//! These are view models, not protocol types. The protocol model in
//! `veyyon-desktop-model` states what a host may report; these state what a
//! surface has decided to show, after sectioning, ordering and truncation. The
//! separation is what lets a surface be rendered headlessly from a fixture with
//! no host attached.

use veyyon_desktop_kit::TintRole;
use veyyon_desktop_tokens::ColorRole;

/// A status badge (§5.1). The vocabulary is fixed: a badge states what the
/// session needs from the operator, or what it is doing without them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Badge {
	/// Running, no operator action required.
	Working,
	/// Running and reporting something the operator may want to see.
	Watching,
	/// Blocked on an approval.
	Approval,
	/// Blocked on an answer.
	Input,
	/// A plan is waiting to be read.
	Plan,
	/// A deferred session has come due.
	Due,
	/// Finished successfully.
	Done,
	/// Finished unsuccessfully.
	Failed,
}

impl Badge {
	/// The badge's label.
	pub const fn label(self) -> &'static str {
		match self {
			Self::Working => "Working",
			Self::Watching => "Watching",
			Self::Approval => "Approval",
			Self::Input => "Input",
			Self::Plan => "Plan",
			Self::Due => "Due",
			Self::Done => "Done",
			Self::Failed => "Failed",
		}
	}

	/// The tint the badge paints with.
	pub const fn tint(self) -> TintRole {
		match self {
			Self::Working => TintRole::Working,
			Self::Watching => TintRole::Attention,
			Self::Approval => TintRole::Approve,
			Self::Input => TintRole::Input,
			Self::Plan => TintRole::Plan,
			Self::Due => TintRole::Due,
			Self::Done => TintRole::Done,
			Self::Failed => TintRole::Error,
		}
	}

	/// Whether the badge is asking the operator for something. A section is
	/// ordered by this, so it is a property of the badge rather than a list the
	/// queue keeps separately.
	pub const fn blocks_on_operator(self) -> bool {
		matches!(self, Self::Approval | Self::Input | Self::Plan | Self::Due)
	}
}

/// A queue section (§5.1), in the order the queue lists them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Section {
	/// Composed but not yet sent.
	Unsent,
	/// Held at the top by the operator.
	Pinned,
	/// Running or waiting on the operator.
	Live,
	/// Set aside until a time or an event.
	Deferred,
	/// Set aside indefinitely.
	Parked,
}

impl Section {
	/// Every section, in display order.
	pub const fn all() -> [Self; 5] {
		[Self::Unsent, Self::Pinned, Self::Live, Self::Deferred, Self::Parked]
	}

	/// The section's header label.
	pub const fn label(self) -> &'static str {
		match self {
			Self::Unsent => "Unsent",
			Self::Pinned => "Pinned",
			Self::Live => "Live",
			Self::Deferred => "Deferred",
			Self::Parked => "Parked",
		}
	}

	/// Whether rows in this section draw as cards. A card carries a badge, a
	/// title and a subtitle; a line carries a title and nothing else. Sections
	/// the operator is not currently working in draw as lines, which is what
	/// keeps a long parked list from costing the same vertical space as the
	/// live one.
	pub const fn draws_cards(self) -> bool {
		matches!(self, Self::Unsent | Self::Pinned | Self::Live)
	}
}

/// A row in the queue.
#[derive(Debug, Clone)]
pub struct Row {
	/// The session this row opens. Stable across a re-section, so selection
	/// survives a row moving from Live to Deferred, which a positional index
	/// would not.
	pub id:       u64,
	/// The session's title.
	pub title:    String,
	/// The repository or working directory, shown on card rows.
	pub subtitle: String,
	/// The badge, absent on a row that is neither running nor finished.
	pub badge:    Option<Badge>,
	/// Elapsed or due time, already formatted.
	pub meta:     Option<String>,
}

/// One block inside an assistant turn (§5.2).
#[derive(Debug, Clone)]
pub enum Block {
	/// Prose the assistant wrote.
	Prose(String),
	/// A tool invocation, collapsed to one line.
	Invoke {
		/// The tool's name.
		tool:   String,
		/// The tool's target, already shortened.
		target: String,
		/// The outcome, absent while running.
		result: Option<String>,
	},
	/// A reasoning summary, collapsed.
	Reason(String),
	/// A mono pane: a diff, a command's output, a file excerpt.
	Pane {
		/// The pane's caption.
		caption: String,
		/// The pane's lines.
		lines:   Vec<String>,
	},
}

/// A turn in the transcript.
#[derive(Debug, Clone)]
pub enum Turn {
	/// What the operator sent.
	Operator(String),
	/// What the agent produced.
	Agent(Vec<Block>),
}

/// A decision attached above the composer (§5.3).
#[derive(Debug, Clone)]
pub enum Card {
	/// The agent wants to run something that needs permission.
	Approval {
		/// The tool and its target, as one line.
		tool:   String,
		/// What it will do, as the operator would read it.
		detail: Vec<String>,
	},
	/// The agent needs an answer before it can continue.
	Question {
		/// What is being asked.
		prompt:  String,
		/// The answers offered.
		options: Vec<String>,
	},
	/// The agent has a plan waiting to be read.
	Plan {
		/// The plan's one-line subject.
		title: String,
		/// The plan's body.
		body:  Vec<String>,
	},
}

impl Card {
	/// How many answers this card offers the operator.
	///
	/// An approval and a plan each offer two, and a question offers whatever it
	/// was asked with. This is the count of controls the card contributes, so a
	/// card kind added without answers is a card that cannot be answered.
	pub const fn answer_count(&self) -> usize {
		match self {
			Self::Approval { .. } | Self::Plan { .. } => 2,
			Self::Question { options, .. } => options.len(),
		}
	}
}

/// A row in the right panel's file tree (§5.4).
#[derive(Debug, Clone)]
pub struct TreeRow {
	/// Nesting depth, zero at the root.
	pub depth:   usize,
	/// The entry's name.
	pub name:    String,
	/// Added and removed line counts, absent on a directory.
	pub changed: Option<(u32, u32)>,
}

/// Everything one shell render draws.
#[derive(Debug, Clone)]
pub struct ShellState {
	/// The window title: the open session's name.
	pub title:        String,
	/// The queue's sections and their rows.
	pub sections:     Vec<(Section, Vec<Row>)>,
	/// The open session's transcript.
	pub transcript:   Vec<Turn>,
	/// The composer's current text, empty when it shows its placeholder.
	pub composed:     String,
	/// The run bar's status line.
	pub run_status:   Option<(Badge, String)>,
	/// The right panel's tree, empty when the panel is closed.
	pub tree:         Vec<TreeRow>,
	/// The right panel's tab labels and which is active.
	pub tabs:         Vec<String>,
	/// The active tab's index.
	pub active_tab:   usize,
	/// Decisions attached above the composer.
	pub cards:        Vec<Card>,
	/// Supervised output lines. Retained while the drawer is closed, so
	/// reopening it shows what was there rather than an empty pane.
	pub drawer_lines: Vec<String>,
	/// Whether the terminal drawer is open.
	pub drawer_open:  bool,
	/// The open session.
	pub current_id:   u64,
}

impl ShellState {
	/// The row with this id, in whatever section holds it.
	///
	/// A row's identity is the session's, not its position, because a section
	/// re-sorts under the operator and a position taken before a click is not
	/// the row that was clicked.
	pub fn row(&self, id: u64) -> Option<&Row> {
		self
			.sections
			.iter()
			.flat_map(|(_, rows)| rows.iter())
			.find(|row| row.id == id)
	}
}

impl Default for ShellState {
	fn default() -> Self {
		Self {
			title:        "veyyon".to_string(),
			sections:     Vec::new(),
			transcript:   Vec::new(),
			composed:     String::new(),
			run_status:   None,
			tree:         Vec::new(),
			tabs:         Vec::new(),
			active_tab:   0,
			cards:        Vec::new(),
			drawer_lines: Vec::new(),
			drawer_open:  false,
			current_id:   0,
		}
	}
}

/// Resolves a role name from a token file to a role.
///
/// Derived from `ColorRole::all()` rather than a match arm per role, so a role
/// added to the enum is resolvable here without an edit, and a name that is not
/// a role is rejected rather than silently substituted.
pub fn role_named(name: &str) -> Option<ColorRole> {
	ColorRole::all()
		.into_iter()
		.find(|role| role.as_str() == name)
}
