//! What the composer's primary control does, and the drafts that name it
//! themselves.

use veyyon_desktop_model::HostActionKind;
use veyyon_desktop_ui::icons::IconName;

/// What the composer's primary control does now.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Primary {
	/// Starts a turn with the draft.
	Send,
	/// Sends the draft into the running turn.
	Steer,
	/// Queues the draft behind the running turn.
	Queue,
	/// Stops the running turn; the draft is empty.
	Stop,
	/// Answers the question the session waits on with the draft.
	Answer,
	/// Approves the call the session waits on, once.
	Approve,
	/// Accepts the plan the session waits on.
	Accept,
	/// Sends the draft back to the plan as the change to make.
	Refine,
}

impl Primary {
	/// The control's accessible name and tooltip.
	#[must_use]
	pub const fn label(self) -> &'static str {
		match self {
			Self::Send => "Send message",
			Self::Steer => "Steer turn",
			Self::Queue => "Queue message",
			Self::Stop => "Stop turn",
			Self::Answer => "Submit answer",
			Self::Approve => "Approve request",
			Self::Accept => "Accept plan",
			Self::Refine => "Refine plan",
		}
	}

	/// The glyph the control draws.
	#[must_use]
	pub const fn icon(self) -> IconName {
		match self {
			Self::Stop => IconName::Square,
			Self::Approve | Self::Accept => IconName::Check,
			Self::Send | Self::Steer | Self::Queue | Self::Answer | Self::Refine => IconName::ArrowUp,
		}
	}

	/// The request the control sends, whose gate it reads.
	#[must_use]
	pub const fn kind(self) -> HostActionKind {
		match self {
			Self::Send => HostActionKind::SubmitPrompt,
			Self::Steer => HostActionKind::Steer,
			Self::Queue => HostActionKind::FollowUp,
			Self::Stop => HostActionKind::AbortTurn,
			Self::Answer | Self::Approve | Self::Accept | Self::Refine => {
				HostActionKind::RespondToInteraction
			},
		}
	}
}

/// A draft that states how it is sent, as the terminal reads it:
/// `/steer <text>` sends the text into the running turn and `/queue <text>`
/// queues it behind the turn, whatever the queue mode. `None` for any other
/// draft and for either command without text.
pub(super) fn directed(draft: &str) -> Option<(Primary, &str)> {
	let (command, text) = draft.strip_prefix('/')?.split_once(char::is_whitespace)?;
	let primary = match command {
		"steer" => Primary::Steer,
		"queue" => Primary::Queue,
		_ => return None,
	};
	let text = text.trim();
	(!text.is_empty()).then_some((primary, text))
}
