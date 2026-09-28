//! A driver client in the window's own process, for tests.

use gpui::App;

use super::answer::{self, Incoming};

/// A driver client in the same process as the window. Its requests take the
/// path a socket client's take, request line to reply line, without the
/// socket and its threads.
///
/// Dropping the client hangs it up: its parked waits are dropped after the
/// next frame, and frame events stop.
pub struct Client {
	reply:   flume::Sender<String>,
	replies: flume::Receiver<String>,
}

impl Client {
	/// Connects to the driver of `cx`, turning the driver on: targets record
	/// their bounds from now on and the workspace reports its frames.
	pub fn connect(cx: &mut App) -> Self {
		answer::install(cx);
		let (reply, replies) = flume::unbounded();
		Self { reply, replies }
	}

	/// Sends one request line, as a socket client writes it.
	pub fn send(&self, line: &str, cx: &mut App) {
		answer::answer(Incoming { line: line.to_owned(), reply: self.reply.clone() }, cx);
	}

	/// The oldest reply or event not read yet, if one arrived.
	#[must_use]
	pub fn next_line(&self) -> Option<String> {
		self.replies.try_recv().ok()
	}
}

/// The `wait` requests parked until their condition holds, across every
/// client.
#[must_use]
pub fn waiting(cx: &App) -> usize {
	answer::waiting(cx)
}
