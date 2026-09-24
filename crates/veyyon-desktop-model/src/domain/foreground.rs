//! The command a session is waiting on in the foreground (§5, §8).

use serde::{Deserialize, Serialize};

/// The command a session's turn is waiting on, while it can still be moved to
/// a background job.
///
/// The view exists only while the wait does: a session that is waiting on
/// nothing carries no view at all, rather than a view stating it is idle. That
/// is what lets a control be drawn from the view's presence and vanish the
/// moment the command finishes, without polling for a state that changes
/// between two turns of the event loop.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ForegroundCommandView {
	/// The command line being waited on, truncated by the host to a drawable
	/// width.
	pub command:   String,
	/// Flag stating the command line was cut to the drawable width.
	pub truncated: bool,
}

impl ForegroundCommandView {
	/// The words a control states, naming the command it would move.
	#[must_use]
	pub fn label(&self) -> String {
		let command = if self.truncated {
			format!("{}…", self.command)
		} else {
			self.command.clone()
		};
		format!("Background {command}")
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn a_truncated_command_is_drawn_with_the_cut_stated() {
		let view = ForegroundCommandView { command: "bun test packa".to_owned(), truncated: true };
		assert_eq!(view.label(), "Background bun test packa…");
	}

	#[test]
	fn a_whole_command_is_drawn_as_it_runs() {
		let view = ForegroundCommandView { command: "bun test".to_owned(), truncated: false };
		assert_eq!(view.label(), "Background bun test");
	}
}
