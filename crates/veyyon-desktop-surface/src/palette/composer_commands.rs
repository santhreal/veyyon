//! Palette rows for the composer's own controls.
//!
//! A composer command row presses a control the composer already draws. Each
//! variant states the surface that control is, the spelling it is typed as,
//! whether the text after that spelling is a message, and the capability the
//! press needs from the host. `commands.rs` builds a palette item per variant.

use strum::EnumIter;
use veyyon_desktop_model::{Capability, SessionId, SurfaceId};

/// Actions requiring the composer's editor or a local selection surface.
#[derive(Debug, Clone, Copy, PartialEq, Eq, EnumIter)]
pub enum ComposerCommand {
	AttachFiles,
	Models,
	SwitchModel,
	Effort,
	QueueMode,
	Steer,
	Queue,
}

impl ComposerCommand {
	/// The existing composer control used for both list selection and execution.
	#[must_use]
	pub fn surface(self, session: &SessionId) -> Option<SurfaceId> {
		match self {
			Self::AttachFiles => None,
			Self::Models | Self::SwitchModel => {
				Some(SurfaceId::ComposerModelSelector(session.clone()))
			},
			Self::Effort => Some(SurfaceId::ComposerThinkingSelector(session.clone())),
			Self::QueueMode => Some(SurfaceId::ComposerQueueModeToggle(session.clone())),
			Self::Steer => Some(SurfaceId::ComposerSteerButton(session.clone())),
			Self::Queue => Some(SurfaceId::ComposerQueueButton(session.clone())),
		}
	}

	#[must_use]
	pub const fn name(self) -> &'static str {
		match self {
			Self::AttachFiles => "/attach",
			Self::Models => "/model",
			Self::SwitchModel => "/switch",
			Self::Effort => "/effort",
			Self::QueueMode => "/queue-mode",
			Self::Steer => "/steer",
			Self::Queue => "/queue",
		}
	}

	/// Whether the command sends the draft written after its spelling.
	///
	/// The composer's text is the palette's query while a slash menu is open,
	/// and the ranker scores a query against the row's own name: a message
	/// long enough to outrun that name loses the row it was addressed to. A
	/// command that carries a message is therefore ranked on its first word
	/// alone, and the rest is the message.
	#[must_use]
	pub const fn carries_draft(self) -> bool {
		match self {
			Self::Steer | Self::Queue => true,
			Self::AttachFiles | Self::Models | Self::SwitchModel | Self::Effort | Self::QueueMode => {
				false
			},
		}
	}

	/// The capability the command's action needs from the host, for the
	/// commands whose action a host can decline to carry (§5.13).
	///
	/// A command with no capability of its own is `None`: the draft, the
	/// attachment picker and the steering submission are the window's own or
	/// ride on the turn control the composer's arrow already gates.
	#[must_use]
	pub const fn capability(self) -> Option<Capability> {
		match self {
			Self::AttachFiles | Self::Steer => None,
			Self::Models | Self::SwitchModel => Some(Capability::Models),
			Self::Effort => Some(Capability::Models),
			// A follow-up behind a running turn, and the mode that chooses it,
			// are what background submission is.
			Self::QueueMode | Self::Queue => Some(Capability::BackgroundSubmission),
		}
	}
}
