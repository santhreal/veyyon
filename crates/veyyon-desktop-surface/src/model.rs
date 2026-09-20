//! What the surfaces draw.
//!
//! These are view models, not protocol types. The protocol model in
//! `veyyon-desktop-model` states what a host may report; these state what a
//! surface has decided to show, after sectioning, ordering and truncation. The
//! separation is what lets a surface be rendered headlessly from a fixture with
//! no host attached.

use std::sync::Arc;

use veyyon_desktop_model::tool_view::ToolPresentation;
use veyyon_desktop_tokens::ColorRole;

mod appearance;
mod artifact;
mod queue;
mod shell_state;
pub use appearance::AppearanceChoice;
pub use artifact::*;
pub use queue::{Badge, Row, Section};
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
	/// The agent or host refused an action or request.
	Refusal {
		/// What was refused.
		title:  String,
		/// The refusal explanation or lines.
		detail: Vec<String>,
	},
	/// An active goal with its progress and controls.
	Goal { view: veyyon_desktop_model::GoalView },
}

impl Card {
	/// How many answers this card offers the operator.
	///
	/// An approval offers the tool wrapper's four (deny, deny for the session,
	/// approve, approve for the session) and a plan two. A question offers its
	/// options, and the free-text reply row only where it has none: the host
	/// takes an option index for a question that lists them and refuses text
	/// for it (§5.5). This is the count of controls the card contributes, so a
	/// card kind added without answers is a card that cannot be answered.
	pub const fn answer_count(&self) -> usize {
		match self {
			Self::Approval { .. } => 4,
			Self::Plan { .. } => 2,
			Self::Refusal { .. } => 1,
			Self::Question { options, .. } => match options.len() {
				0 => 1,
				offered => offered,
			},
			Self::Goal { view } => view.status.allowed_controls().len(),
		}
	}
}

/// Whether each kind of decision can be answered at all, right now.
///
/// A card's answers are gated by the capability the host declared for that
/// kind of decision and by the transport under it. That is one answer for
/// every card of a kind rather than one per card, because it is the host's
/// ability to take the decision at all: an option row nothing can send is a
/// transcript of the question drawn as a control (§4.3, §5.5).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct CardAnswers {
	/// Whether an approval can be answered.
	pub approvals: Availability,
	/// Whether a question can be answered.
	pub questions: Availability,
	/// Whether a plan can be answered.
	pub plans:     Availability,
	/// Whether a goal's controls can be answered.
	pub goals:     Availability,
}

impl CardAnswers {
	/// The availability of the answers `card` offers.
	#[must_use]
	pub const fn of(&self, card: &Card) -> &Availability {
		match card {
			Card::Approval { .. } => &self.approvals,
			Card::Question { .. } => &self.questions,
			Card::Plan { .. } => &self.plans,
			Card::Refusal { .. } => &Availability::Enabled,
			Card::Goal { .. } => &self.goals,
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
