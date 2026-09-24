//! The autoswarm console a session has open, and the runs it has logged (§5,
//! §8).
//!
//! Every value here is the host's: the console model decides what a row holds,
//! what a stepper formats to, which actions the swarm's state allows and why
//! one of them cannot run. The window draws the projection and sends back a
//! row, an action or a preset. Nothing is computed twice, so the ledger drawn
//! here and the card the terminal draws cannot disagree about a run.

use serde::{Deserialize, Serialize};

/// The actions a console offers, as the console model names them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, strum::EnumIter)]
#[serde(rename_all = "lowercase")]
pub enum AutoswarmAction {
	/// Start a swarm on the setup the rows hold.
	Start,
	/// Resume the swarm recorded on this branch.
	Resume,
	/// Stop the turn that is streaming, keeping the session.
	Pause,
	/// Start a fresh session, closing the one on the branch.
	New,
	/// Turn the mode off, leaving the session recorded.
	Stop,
	/// Close the session and keep every file it wrote.
	Clear,
	/// Reset the worktree to the baseline the session recorded.
	Reset,
}

impl AutoswarmAction {
	/// Complete list for runtime sweeps, in the wire's declaration order.
	pub const ALL: [Self; 7] =
		[Self::Start, Self::Resume, Self::Pause, Self::New, Self::Stop, Self::Clear, Self::Reset];

	/// The stable string identifier matching the wire protocol.
	#[must_use]
	pub const fn as_str(self) -> &'static str {
		match self {
			Self::Start => "start",
			Self::Resume => "resume",
			Self::Pause => "pause",
			Self::New => "new",
			Self::Stop => "stop",
			Self::Clear => "clear",
			Self::Reset => "reset",
		}
	}
}

/// The control a row draws, from the kind the console's form declares.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, strum::EnumIter)]
pub enum AutoswarmFieldKind {
	/// A line of text: the goal, the models, the preset name.
	Text,
	/// A bounded number, stepped by one.
	Stepper,
	/// An on/off switch.
	Toggle,
	/// One of a fixed set, which is how presets are chosen.
	Segmented,
}

/// One option a segmented row offers. A built-in preset cannot be removed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AutoswarmOptionView {
	/// The value sent back when this option is chosen.
	pub value:     String,
	/// The words the option is drawn as.
	pub label:     String,
	/// This option is the one the rows currently equal.
	pub selected:  bool,
	/// This option can be deleted, which a built-in cannot.
	pub removable: bool,
}

/// One row of the console.
///
/// The value arrives twice: `display` is what the console states, already
/// formatted, and the typed field beside it is what a change sends back. A
/// window that drew the number itself would state `3` where the console states
/// `3 arms`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AutoswarmFieldView {
	/// The row's id, which a change names.
	pub id:          String,
	/// The control the row draws.
	pub kind:        AutoswarmFieldKind,
	/// The row's name.
	pub label:       String,
	/// What the row states while it has the ring.
	pub hint:        String,
	/// The value as the console states it, for every kind of row.
	pub display:     String,
	/// The text a text row holds; absent on every other kind.
	pub text:        Option<String>,
	/// What an empty text row states in place of a value.
	pub placeholder: Option<String>,
	/// The number a stepper holds.
	pub number:      Option<i64>,
	/// The lowest number the stepper takes.
	pub min:         Option<i64>,
	/// The highest number the stepper takes.
	pub max:         Option<i64>,
	/// The state a toggle holds.
	pub on:          Option<bool>,
	/// The options a segmented row offers; empty on every other kind.
	pub options:     Vec<AutoswarmOptionView>,
}

/// A line the console states under its rows: the cost, the arms, the harness.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AutoswarmNoteView {
	/// The note's id, stable across frames.
	pub id:   String,
	/// What the note states.
	pub text: String,
}

/// One action the swarm's state allows, with what stops it when something does.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AutoswarmActionView {
	/// The action this row runs.
	pub action:  AutoswarmAction,
	/// The words the control is drawn as.
	pub label:   String,
	/// What the action does, for the footer under it.
	pub verb:    String,
	/// The first action the console offers, which is its default.
	pub primary: bool,
	/// Why the action cannot run now, or None when it can.
	pub blocker: Option<String>,
}

/// One run of the ledger: a logged experiment, or the one measuring now.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AutoswarmRunView {
	/// The run's number and the segment it belongs to.
	pub label:   String,
	/// The arm that produced it, or None on a serial loop.
	pub arm:     Option<String>,
	/// What it measured, with its unit.
	pub metric:  String,
	/// How that compares with the baseline of its own segment.
	pub delta:   Option<String>,
	/// What the run is worth, in one word.
	pub outcome: String,
	/// This run leads its segment.
	pub best:    bool,
	/// What the run states when the ledger opens it.
	pub detail:  Vec<String>,
}

/// The swarm recorded on this branch, once one has started.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AutoswarmSwarmView {
	/// The session's name, which the first turn records.
	pub name:    Option<String>,
	/// The branch the session is recorded on.
	pub branch:  Option<String>,
	/// What the swarm is optimizing.
	pub goal:    String,
	/// How many runs it has logged.
	pub runs:    usize,
	/// The best measurement so far, with its unit.
	pub best:    Option<String>,
	/// The command measuring now, or None when nothing is.
	pub running: Option<String>,
}

/// The console as one window holds it.
///
/// A console with no fields and no actions is the run ledger on its own, which
/// `/autoresearch status` opens: there is state to read and nothing to change.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AutoswarmConsoleView {
	/// The session the console belongs to.
	pub session:    String,
	/// The swarm on this branch, or None before the first start.
	pub swarm:      Option<AutoswarmSwarmView>,
	/// The setup rows, in the order the console states them.
	pub fields:     Vec<AutoswarmFieldView>,
	/// What the setup costs, stated under the rows.
	pub notes:      Vec<AutoswarmNoteView>,
	/// The actions the swarm's state allows, primary first.
	pub actions:    Vec<AutoswarmActionView>,
	/// The runs logged so far, newest first.
	pub runs:       Vec<AutoswarmRunView>,
	/// The id of the row a preset is named in, or None on a console that
	/// saves none. The row is an ordinary text row of `fields`; this states
	/// which one the save control beside it reads.
	pub save_field: Option<String>,
}

impl AutoswarmConsoleView {
	/// The action the console runs by default, or None while it offers none.
	#[must_use]
	pub fn primary(&self) -> Option<&AutoswarmActionView> {
		self.actions.iter().find(|action| action.primary)
	}

	/// True while the console takes no change: the ledger without its setup.
	#[must_use]
	pub const fn is_read_only(&self) -> bool {
		self.fields.is_empty() && self.actions.is_empty()
	}
}
