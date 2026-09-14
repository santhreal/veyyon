//! What the drawer's process supervisor sends, read out of the two fields it
//! draws (§5.12).
//!
//! One field states a command line to start, the other a line to write to the
//! input of a process that is already running. Both are read here so that a
//! press either sends what its field states or sends nothing and says why: a
//! supervisor control that sends an empty payload reaches the host as
//! `INVALID_ARGUMENTS` for a start, and as a write of zero bytes the host
//! reports as a success for an input.

use veyyon_gpui::Context;

use super::{FieldKey, ShellView};
use crate::Intent;

impl ShellView {
	/// Starts the process the drawer's command field states, for the `Start`
	/// beside it. The command line is split into the application and its
	/// arguments, and a submit empties the field.
	pub fn submit_process_command(&mut self, cx: &mut Context<Self>) {
		self.commit_field(&FieldKey::ProcessCommand, cx);
	}

	/// Writes what the drawer's input field states to the input of a running
	/// process: `target` is the row whose `Send` was pressed, and `None` is a
	/// submit from inside the field, which names no row.
	///
	/// The line reaches the process as a line: the daemon writes the payload
	/// to the process's input verbatim, and a single-line field cannot state
	/// the terminator a reader of stdin waits for.
	pub fn send_process_input(&mut self, target: Option<String>, cx: &mut Context<Self>) {
		let Some(editor) = self.retained_field(&FieldKey::ProcessInput) else {
			return;
		};
		let line = editor.read(cx).text().to_owned();
		// §9.3: an empty line is refused where it was typed. The host answers
		// one by writing nothing and reporting success, so the press would
		// look answered while the process received nothing at all.
		if line.is_empty() {
			self.refuse_field(cx, "Sending to a process needs something to send");
			return;
		}
		let Some(process) = target.or_else(|| self.only_running_process()) else {
			self.refuse_field(cx, "Press Send on the process this line is for");
			return;
		};
		editor.update(cx, |editor, cx| editor.set_text(String::new(), cx));
		self.clear_refusal();
		let mut data = line.into_bytes();
		data.push(b'\n');
		self.dispatch(Intent::ProcessSend { process, data }, cx);
	}

	/// The name of the one running process, and `None` where none is running
	/// or several are: a line the operator typed into a field is not sent to
	/// a process picked for them.
	fn only_running_process(&self) -> Option<String> {
		let mut running = self
			.state
			.drawer
			.processes
			.iter()
			.filter(|process| process.status == "running");
		let first = running.next()?;
		running.next().is_none().then(|| first.name.clone())
	}
}
