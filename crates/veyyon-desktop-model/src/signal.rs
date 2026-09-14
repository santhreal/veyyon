//! The signals a supervised process can be sent (§5.11).
//!
//! The supervisor accepts five, and the window sent one: a process that
//! ignores `SIGTERM` could be asked to stop and never killed, and a server
//! that wanted an interrupt got a termination. Each is a variant here, so the
//! menu that offers them is built by iterating the union and a signal the
//! supervisor gains is a variant the window draws rather than a string
//! somewhere in the action layer.

use serde::{Deserialize, Serialize};

/// One signal the process supervisor accepts.
///
/// The serialized form is the signal's own name, which is what the supervisor
/// reads; [`Self::wire`] states the same name for a label to draw and for the
/// suite that holds the two together.
#[derive(
	Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize, strum::EnumIter,
)]
pub enum SupervisorSignal {
	/// What a keyboard interrupt sends: a foreground program's own cancel.
	#[serde(rename = "SIGINT")]
	Interrupt,
	/// The polite ask, which a program may catch and finish on.
	#[default]
	#[serde(rename = "SIGTERM")]
	Terminate,
	/// What a closing terminal sends, which a daemon often reloads on.
	#[serde(rename = "SIGHUP")]
	HangUp,
	/// Terminate with a core dump, which states where a wedged program was.
	#[serde(rename = "SIGQUIT")]
	Quit,
	/// The one no program can catch, for the process that answered nothing
	/// else.
	#[serde(rename = "SIGKILL")]
	Kill,
}

impl SupervisorSignal {
	/// The name the supervisor reads, which is the serialized form.
	#[must_use]
	pub const fn wire(self) -> &'static str {
		match self {
			Self::Interrupt => "SIGINT",
			Self::Terminate => "SIGTERM",
			Self::HangUp => "SIGHUP",
			Self::Quit => "SIGQUIT",
			Self::Kill => "SIGKILL",
		}
	}

	/// What the signal is called where it is offered, in the words of what it
	/// does rather than of its number.
	#[must_use]
	pub const fn label(self) -> &'static str {
		match self {
			Self::Interrupt => "Interrupt",
			Self::Terminate => "Terminate",
			Self::HangUp => "Hang up",
			Self::Quit => "Quit",
			Self::Kill => "Kill",
		}
	}

	/// Whether the signal ends the process whatever it is doing, which is what
	/// the row that sends it is drawn as.
	#[must_use]
	pub const fn uncatchable(self) -> bool {
		matches!(self, Self::Kill)
	}
}
