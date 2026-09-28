//! The decision the dock shows, held by value so a render never borrows the
//! store across the card's own state, and what the card holds besides it.

use gpui::{Context, SharedString, Window};
use veyyon_desktop_model::{
	ApprovalInteraction, DialogInteraction, InteractionId, PlanInteraction, QuestionInteraction,
	SessionId, SurfaceId,
};
use veyyon_desktop_ui::{controls::ButtonVariant, markdown::MarkdownDoc};

use super::{InteractionDock, dialog::DialogState};
use crate::state::{Answer, Decision};

/// The control an answer is sent from, under which the host's reply to it is
/// filed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Control {
	Approve,
	AlwaysAllow,
	Decline,
	Option(usize),
	Submit,
	Accept,
}

impl Control {
	/// The surface the answer to `id` of `session` is sent from.
	pub(super) const fn surface(self, session: SessionId, id: InteractionId) -> SurfaceId {
		match self {
			Self::Approve => SurfaceId::ApprovalApproveButton(session, id),
			Self::AlwaysAllow => SurfaceId::ApprovalAlwaysAllowButton(session, id),
			Self::Decline => SurfaceId::ApprovalDeclineButton(session, id),
			Self::Option(index) => SurfaceId::QuestionOptionButton(session, id, index),
			Self::Submit => SurfaceId::QuestionSubmitButton(session, id),
			Self::Accept => SurfaceId::PlanAcceptButton(session, id),
		}
	}
}

/// What pressing one of a card's answers does.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum Act {
	/// Sends the answer from the control.
	Send(Answer, Control),
	/// Hands the answer to the composer, whose draft is the reply to a
	/// question without options or the change a plan is sent back with.
	Composer,
}

/// One answer a card offers, in the order 1–9 pick them.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Choice {
	pub(super) label:   SharedString,
	pub(super) variant: ButtonVariant,
	pub(super) act:     Act,
}

impl Choice {
	/// A choice sending `answer` from `control`.
	pub(super) fn send(
		label: impl Into<SharedString>,
		variant: ButtonVariant,
		answer: Answer,
		control: Control,
	) -> Self {
		Self { label: label.into(), variant, act: Act::Send(answer, control) }
	}
}

/// One decision, owned.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum Owned {
	Approval(ApprovalInteraction),
	Question(QuestionInteraction),
	Plan(PlanInteraction),
	Dialog(DialogInteraction),
}

impl From<&Decision<'_>> for Owned {
	fn from(decision: &Decision<'_>) -> Self {
		match *decision {
			Decision::Approval(approval) => Self::Approval(approval.clone()),
			Decision::Question(question) => Self::Question(question.clone()),
			Decision::Plan(plan) => Self::Plan(plan.clone()),
			Decision::Dialog(dialog) => Self::Dialog(dialog.clone()),
		}
	}
}

impl Owned {
	/// The interaction the decision answers.
	pub(super) const fn id(&self) -> &InteractionId {
		match self {
			Self::Approval(approval) => &approval.id,
			Self::Question(question) => &question.id,
			Self::Plan(plan) => &plan.id,
			Self::Dialog(dialog) => &dialog.id,
		}
	}

	/// Whether the card is answered from the keyboard. A question without
	/// options is answered in the composer, so it leaves the keyboard there.
	pub(super) const fn takes_keys(&self) -> bool {
		match self {
			Self::Question(question) => !question.options.is_empty(),
			Self::Approval(_) | Self::Plan(_) | Self::Dialog(_) => true,
		}
	}

	/// The answers the card offers, the first one 1 picks. A dialog answers
	/// through its own options and fields and offers none here.
	pub(super) fn choices(&self) -> Vec<Choice> {
		match self {
			Self::Approval(_) => super::approval::choices(),
			Self::Question(question) => super::question::choices(question),
			Self::Plan(_) => super::plan::choices(),
			Self::Dialog(_) => Vec::new(),
		}
	}
}

/// The line a waiting decision is listed by: its kind and the subject that
/// tells two of a kind apart.
pub(super) fn waiting_line(decision: &Decision<'_>) -> String {
	match decision {
		Decision::Approval(approval) => format!("Approval · {}", approval.tool_name),
		Decision::Question(question) => format!("Question · {}", first_line(&question.prompt)),
		Decision::Plan(plan) => format!("Plan · {}", plan_title(&plan.markdown_plan)),
		Decision::Dialog(dialog) => match dialog.questions.as_slice() {
			[only] => format!("Question · {}", first_line(&only.question)),
			many => format!("{} questions", many.len()),
		},
	}
}

/// The first line of `text` with text on it.
pub(super) fn first_line(text: &str) -> &str {
	text
		.lines()
		.map(str::trim)
		.find(|line| !line.is_empty())
		.unwrap_or_default()
}

/// A plan's name: its first line with text on it, without heading marks.
pub(super) fn plan_title(markdown: &str) -> &str {
	let line = first_line(markdown).trim_start_matches('#').trim();
	if line.is_empty() { "Plan" } else { line }
}

/// The decision shown and the state its card keeps while it stays shown.
pub(super) struct Shown {
	pub(super) id:       InteractionId,
	pub(super) decision: Owned,
	/// Folded to its one line by Esc; a click or a new decision opens it.
	pub(super) folded:   bool,
	/// The choice the keyboard or the pointer is on. Nothing is on a choice
	/// until one is moved to, so a stray Enter answers nothing; a dialog
	/// opens on its preselected or recommended option.
	pub(super) cursor:   Option<usize>,
	/// The plan's body, parsed once.
	pub(super) plan:     Option<MarkdownDoc>,
	/// A dialog's tabs, answers and fields.
	pub(super) dialog:   Option<DialogState>,
	/// The host refused the last answer sent to this decision.
	pub(super) refused:  bool,
}

impl Shown {
	/// The card for `decision`, with nothing picked yet.
	pub(super) fn new(
		decision: Owned,
		window: &mut Window,
		cx: &mut Context<InteractionDock>,
	) -> Self {
		let plan = match &decision {
			Owned::Plan(plan) => Some(MarkdownDoc::new(plan.markdown_plan.clone())),
			Owned::Approval(_) | Owned::Question(_) | Owned::Dialog(_) => None,
		};
		let (dialog, cursor) = match &decision {
			Owned::Dialog(dialog) => (
				Some(DialogState::new(dialog, window, cx)),
				dialog
					.questions
					.first()
					.and_then(super::dialog::opening_cursor),
			),
			Owned::Approval(_) | Owned::Question(_) | Owned::Plan(_) => (None, None),
		};
		Self {
			id: decision.id().clone(),
			decision,
			folded: false,
			cursor,
			plan,
			dialog,
			refused: false,
		}
	}
}
