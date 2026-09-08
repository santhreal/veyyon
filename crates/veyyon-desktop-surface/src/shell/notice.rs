//! The attention strip's one line, and the two channels that write it.

use veyyon_gpui::Context;

use super::ShellView;

impl ShellView {
	/// Returns true if the attention strip has a line to draw.
	#[must_use]
	pub fn has_notice(&self) -> bool {
		self.notice().is_some()
	}

	/// The line the attention strip draws, if it has one.
	///
	/// The strip carries two channels: what the host reports about itself,
	/// and the refusal this window put up for a value it would not send. The
	/// refusal outranks it while it stands, because the host's commentary is
	/// its connection state rather than an answer to what the operator just
	/// typed, and a heartbeat that reports a healthy socket carries no notice
	/// at all — which used to erase a refusal 60 milliseconds after it was
	/// stated.
	#[must_use]
	pub fn notice(&self) -> Option<&str> {
		self.field_refusal.as_deref().or(self.notice.as_deref())
	}

	/// Sets or clears the attention strip's message.
	///
	/// The strip is a band of the window rather than a field of a control, so
	/// a message that changes moves the columns under it. The repaint belongs
	/// here: a notice reaches the strip from a refusal that sends nothing, a
	/// picker that was cancelled, a store that failed to save and a host
	/// snapshot, and the ones that send nothing otherwise mark nothing dirty,
	/// which leaves the strip stated in the state and drawn on whatever later
	/// frame something else happens to request.
	pub fn set_notice(&mut self, notice: Option<String>, cx: &mut Context<Self>) {
		if self.notice == notice {
			return;
		}
		self.notice = notice;
		cx.notify();
	}

	/// The same message, on a view that has no window yet: the first frame
	/// draws it, so there is nothing to repaint.
	#[must_use]
	pub fn with_notice(mut self, notice: Option<String>) -> Self {
		self.notice = notice;
		self
	}
}
