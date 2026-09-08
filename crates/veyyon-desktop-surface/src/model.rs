//! What the surfaces draw.
//!
//! These are view models, not protocol types. The protocol model in
//! `veyyon-desktop-model` states what a host may report; these state what a
//! surface has decided to show, after sectioning, ordering and truncation. The
//! separation is what lets a surface be rendered headlessly from a fixture with
//! no host attached.

use std::sync::Arc;

use veyyon_desktop_kit::TintRole;
use veyyon_desktop_model::tool_view::ToolPresentation;
use veyyon_desktop_tokens::ColorRole;

mod artifact;
mod shell_state;
pub use artifact::*;
pub use shell_state::ShellState;

pub use crate::{
	attach::{ConnectionPhase, ConnectionSurface},
	composer::{
		Attachment, ComposerState, ContextMeter, ModelControl, ModelOption, ThinkingControl,
		TurnPhase,
	},
	controls::{Availability, ControlError, ControlStates},
	drawer::DrawerContent,
	keymap::KeymapState,
	overlay::{Overlay, PaletteState, SettingsState},
	right_panel::{
		DiffFile, DiffRow, FileLine, FileView, HighlightSpan, PanelContent, PanelTab, TreeContent,
		TreeRowItem,
	},
};
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
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
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

	/// The name the section is written under in what the window remembers
	/// (§8.10).
	///
	/// Its own label, lowercased, so the file states which sections are
	/// collapsed in the words the rail draws.
	pub const fn slug(self) -> &'static str {
		match self {
			Self::Unsent => "unsent",
			Self::Pinned => "pinned",
			Self::Live => "live",
			Self::Deferred => "deferred",
			Self::Parked => "parked",
		}
	}

	/// The section a remembered name stands for, or `None` for a name this
	/// binary does not draw a section for.
	///
	/// Resolved over `all`, so a section added to the queue is readable back
	/// without an edit here.
	#[must_use]
	pub fn from_slug(slug: &str) -> Option<Self> {
		Self::all()
			.into_iter()
			.find(|section| section.slug() == slug)
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
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Row {
	/// The session this row opens. Stable across a re-section, so selection
	/// survives a row moving from Live to Deferred, which a positional index
	/// would not.
	pub id:        u64,
	/// The session's title.
	pub title:     String,
	/// The repository or working directory, shown on card rows.
	pub subtitle:  String,
	/// The badge, absent on a row that is neither running nor finished.
	pub badge:     Option<Badge>,
	/// Elapsed or due time, already formatted.
	pub meta:      Option<String>,
	/// The section whose partition the session is placed in.
	///
	/// The same section the row is drawn in, except for a row lifted into
	/// `Unsent` by a draft: `Unsent` is derived and is no partition, so a
	/// partition chord toggles against the placement rather than against the
	/// draft. Reading the drawn section instead pins a pinned session again,
	/// because `Unsent` is not the partition it names.
	pub placement: Section,
}

/// Host-generated call and result presentations, shared with the decoded
/// transcript.
#[derive(Debug, Clone, Default, PartialEq, Eq, Hash)]
pub struct ToolInvocationViews {
	pub call:   Option<Arc<ToolPresentation>>,
	pub result: Option<Arc<ToolPresentation>>,
}

/// One block inside an assistant turn (§5.2).
#[derive(Debug, Clone, PartialEq, Eq, strum::EnumDiscriminants)]
#[strum_discriminants(name(BlockShape), derive(Hash, PartialOrd, Ord, strum::EnumIter))]
#[strum_discriminants(doc = "Fieldless projection of `Block`, so a rhythm sweep can enumerate \
                             every block a turn can hold.")]
pub enum Block {
	/// Prose the assistant wrote.
	Prose(String),
	/// A subordinate event or structural annotation.
	Note {
		/// Static event or role description.
		label:    &'static str,
		/// Recorded content, retained for search.
		text:     String,
		/// Whether this entry separates structural regions.
		boundary: bool,
	},
	/// A tool invocation, collapsed to one line.
	Invoke {
		/// Recorded invocation identity used to correlate results.
		call_id: String,
		/// The tool's name.
		tool:    String,
		/// The tool's target, already shortened.
		target:  String,
		/// The outcome, absent while running.
		result:  Option<String>,
		/// Semantic output supplied by the registered tool renderer.
		views:   ToolInvocationViews,
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
	/// An unrecognized record with its retained raw representation.
	Unknown { producer: String, lines: Vec<String> },
	/// A recorded file reference or image with expandable details.
	Artifact(Artifact),
}

/// A turn in the transcript.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Turn {
	/// What the operator sent.
	Operator(String),
	/// An operator message with recorded attachments or file references.
	OperatorArtifacts { text: String, artifacts: Vec<Artifact> },
	/// What the agent produced, and the model that produced it. The model is
	/// absent when the host reported none for the turn (§5.3).
	Agent { blocks: Vec<Block>, model: Option<String> },
}

/// A decision attached above the composer (§5.3).
#[derive(Debug, Clone, PartialEq, Eq)]
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
	/// An approval offers three (reject, approve, approve for the session), a
	/// plan two, and a question its options plus a free-text reply row.
	/// This is the count of controls the card
	/// contributes, so a card kind added without answers is a card that cannot
	/// be answered.
	pub const fn answer_count(&self) -> usize {
		match self {
			Self::Approval { .. } => 3,
			Self::Plan { .. } => 2,
			Self::Question { options, .. } => options.len() + 1,
		}
	}
}

/// A row in the right panel's file tree (§5.4).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TreeRow {
	/// Nesting depth, zero at the root.
	pub depth:   usize,
	/// The entry's name.
	pub name:    String,
	/// Added and removed line counts, absent on a directory.
	pub changed: Option<(u32, u32)>,
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
