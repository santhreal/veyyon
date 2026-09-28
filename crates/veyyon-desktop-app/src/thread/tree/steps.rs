//! What the sheet does with a row: goes there, first asking whether to
//! summarize the branch it leaves when the host offers a summary, or labels
//! it. Escape steps back the way the terminal's `/tree` does: from the
//! instructions to the summary choices, from the choices to the rows.

use gpui::{Context, Window};
use veyyon_desktop_model::{EntryId, TreeRequest};
use veyyon_desktop_ui::editor::EditorEvent;

use super::{Navigating, SessionTreeSheet, SheetEvent, Status, Step};

/// The answers to whether to summarize the branch left, in the terminal's
/// order.
pub(super) const SUMMARY_CHOICES: [&str; 3] =
	["No summary", "Summarize", "Summarize with custom prompt"];

/// The choice that asks for instructions first.
const CUSTOM: usize = 2;

/// What Enter on the leaf states.
const AT_LEAF: &str = "Already at this point";

impl SessionTreeSheet {
	/// Goes to the row the keyboard is on, asking first whether to summarize
	/// the branch left when the host offers a summary. Enter on the leaf sends
	/// nothing, and nothing is sent while a navigation is pending.
	pub(super) fn confirm(&mut self, window: &mut Window, cx: &mut Context<Self>) {
		if self.navigating.is_some() {
			return;
		}
		let (Some(tree), Some(entry)) = (self.tree(cx), self.selected.clone()) else {
			return;
		};
		if tree.leaf.as_ref() == Some(&entry) {
			self.status = Some(Status::Note(AT_LEAF));
			cx.notify();
		} else if tree.summary_offered {
			self.step = Step::Summary { entry, cursor: 0 };
			cx.notify();
		} else {
			self.navigate(entry, false, None, window, cx);
		}
	}

	/// Picks summary choice `choice` for the entry the choices were asked for.
	pub(super) fn pick_summary(
		&mut self,
		choice: usize,
		window: &mut Window,
		cx: &mut Context<Self>,
	) {
		let Step::Summary { entry, .. } = &self.step else {
			return;
		};
		let entry = entry.clone();
		match choice {
			0 => self.navigate(entry, false, None, window, cx),
			CUSTOM => {
				let step = Step::Instructions { entry };
				self.open_input(step, "", "Custom summarization instructions", window, cx);
			},
			_ => self.navigate(entry, true, None, window, cx),
		}
	}

	/// Opens the label field on the row the keyboard is on, holding its label.
	pub(super) fn edit_label(&mut self, window: &mut Window, cx: &mut Context<Self>) {
		let Some(entry) = self.selected.clone() else {
			return;
		};
		let label = self
			.node(&entry, cx)
			.and_then(|node| node.label.clone())
			.unwrap_or_default();
		self.open_input(Step::Label { entry }, &label, "Label, or empty to clear it", window, cx);
	}

	/// Steps back: stops the summary a pending navigation writes, once, or
	/// leaves the field or the choices for the step before, or closes the
	/// sheet from the rows.
	pub(super) fn escape(&mut self, window: &mut Window, cx: &mut Context<Self>) {
		if let Some(navigating) = &self.navigating {
			if navigating.summarize && !navigating.aborted {
				let abort = TreeRequest::AbortBranchSummary { session: self.session.clone() };
				let request = self.send(abort, cx);
				self.sent.push(request);
				if let Some(navigating) = self.navigating.as_mut() {
					navigating.aborted = true;
				}
				cx.notify();
			}
			return;
		}
		match std::mem::replace(&mut self.step, Step::Browse) {
			Step::Browse => cx.emit(SheetEvent::Closed),
			Step::Instructions { entry } => {
				self.step = Step::Summary { entry, cursor: CUSTOM };
				window.focus(&self.focus, cx);
				cx.notify();
			},
			Step::Summary { .. } | Step::Label { .. } => self.browse(window, cx),
		}
	}

	pub(super) fn on_input(
		&mut self,
		event: EditorEvent,
		window: &mut Window,
		cx: &mut Context<Self>,
	) {
		match event {
			EditorEvent::Submit => self.submit_input(window, cx),
			EditorEvent::Escape => self.escape(window, cx),
			_ => {},
		}
	}

	/// Sends what the field holds, trimmed: the instructions go with the
	/// navigation, and the label, or `None` for an empty one, is set when it
	/// differs from the entry's.
	fn submit_input(&mut self, window: &mut Window, cx: &mut Context<Self>) {
		let text = self.input.read(cx).text().trim();
		let written = (!text.is_empty()).then(|| text.to_owned());
		match std::mem::replace(&mut self.step, Step::Browse) {
			Step::Instructions { entry } => self.navigate(entry, true, written, window, cx),
			Step::Label { entry } => {
				if self
					.node(&entry, cx)
					.is_some_and(|node| node.label != written)
				{
					let session = self.session.clone();
					let request =
						self.send(TreeRequest::SetEntryLabel { session, entry, label: written }, cx);
					self.sent.push(request);
				}
				self.browse(window, cx);
			},
			step @ (Step::Browse | Step::Summary { .. }) => self.step = step,
		}
	}

	/// Asks the host to move the session's leaf to `entry` and waits on the
	/// rows for its answer.
	fn navigate(
		&mut self,
		entry: EntryId,
		summarize: bool,
		instructions: Option<String>,
		window: &mut Window,
		cx: &mut Context<Self>,
	) {
		let session = self.session.clone();
		let navigate = TreeRequest::NavigateTree { session, entry, summarize, instructions };
		let request = self.send(navigate, cx);
		self.navigating = Some(Navigating { request, summarize, aborted: false });
		self.browse(window, cx);
	}

	/// Opens the field for `step`, holding `text`.
	fn open_input(
		&mut self,
		step: Step,
		text: &str,
		placeholder: &'static str,
		window: &mut Window,
		cx: &mut Context<Self>,
	) {
		self.input.update(cx, |input, cx| {
			input.set_text(text, cx);
			input.set_placeholder(placeholder, cx);
			input.focus(window, cx);
		});
		self.step = step;
		self.status = None;
		cx.notify();
	}

	/// Returns to the rows, the keyboard on the sheet.
	fn browse(&mut self, window: &mut Window, cx: &mut Context<Self>) {
		self.step = Step::Browse;
		window.focus(&self.focus, cx);
		cx.notify();
	}
}
