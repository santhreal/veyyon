//! The transcript's controls: the hover row's Branch from here under a
//! prompt and Retry and Rephrase under the last reply, a running call's row
//! and its Cancel, and a link in a reply.

use gpui::{Bounds, Modifiers, Pixels, point, px};
use serde_json::{Value, json};
use veyyon_desktop_model::{HostEvent, SnapshotSectionKind};
use veyyon_desktop_ui::theme::{size, space};

use crate::harness::{Win, corpus, section};

/// The prompt the world's transcript holds.
const PROMPT: &str = "entry-0";

/// The reply to [`PROMPT`] a drive adds.
const REPLY: &str = "entry-1";

/// The words of the link a finished reply holds.
const LINK: &str = "the docs";

/// A transcript entry as the host writes it on the wire.
fn entry(id: &str, parent: Option<&str>, role: &str, content: &Value) -> Value {
	json!({
		"id": id, "parent": parent, "revision": 1, "timestamp_ms": 1_600_000_000_000_u64,
		"role": role, "content": content, "meta": null,
		"raw_discriminator": "message", "raw": { "type": "message" }
	})
}

/// The open thread's transcript: the world's prompt and a reply to it made
/// of `content`.
fn replied(content: &Value) -> HostEvent {
	let prompt = json!([{ "Text": { "text": "first words" } }]);
	HostEvent::Snapshot(section(json!({ "Transcript": { "revision": 2, "value": [
		entry(PROMPT, None, "User", &prompt),
		entry(REPLY, Some(PROMPT), "Assistant", content),
	] } })))
}

/// A finished turn whose reply is one link.
fn answered(w: &mut Win<'_>) {
	let reply = json!([{ "Text": { "text": format!("[{LINK}](https://example.com/docs)") } }]);
	w.apply(vec![replied(&reply)]);
}

/// A turn the host states still running, whose reply called `read` and has
/// no result yet.
fn reading(w: &mut Win<'_>) {
	let reply = json!([
		{ "Text": { "text": "reading" } },
		{ "ToolCall": { "id": "call-1", "name": "read", "arguments": { "path": "src/lib.rs" } } }
	]);
	w.apply(vec![replied(&reply), corpus(SnapshotSectionKind::Pace)]);
}

/// Moves the pointer over item `entry`, which shows its hover row, and
/// clicks the row's `verb` button.
fn hover_row(w: &mut Win<'_>, entry: &str, verb: &str) {
	let item = format!("transcript.entry:{entry}");
	let over = w
		.bounds(&item)
		.unwrap_or_else(|| panic!("the transcript lays out {item}"))
		.center();
	w.cx.simulate_mouse_move(over, None, Modifiers::none());
	w.cx.run_until_parked();
	w.click(&format!("transcript.{verb}:{entry}"));
}

/// Where the last frame drew the run reading `text`.
fn drawn(w: &mut Win<'_>, text: &str) -> Bounds<Pixels> {
	w.cx
		.update(|window, _| {
			window
				.rendered_text_runs()
				.iter()
				.find(|run| run.text.trim() == text)
				.map(|run| run.bounds)
		})
		.unwrap_or_else(|| panic!("the window draws {text:?}"))
}

pub(super) fn branch(w: &mut Win<'_>) {
	hover_row(w, PROMPT, "branch");
}

pub(super) fn retry(w: &mut Win<'_>) {
	answered(w);
	hover_row(w, REPLY, "retry");
}

pub(super) fn rephrase(w: &mut Win<'_>) {
	answered(w);
	hover_row(w, REPLY, "rephrase");
}

pub(super) fn open_link(w: &mut Win<'_>) {
	answered(w);
	w.click_text(LINK);
}

/// Clicks the running call's row, which opens it.
pub(super) fn open_call(w: &mut Win<'_>) {
	reading(w);
	w.click_text("Read");
}

/// Clicks the running call's Cancel. The button is drawn at the right end
/// of the call's row, which spans the reply's column: at most
/// [`size::COLUMN_MAX`] wide and centred in the item inside its
/// [`space::S6`] margins, with the row's words vertically centred on it.
pub(super) fn cancel_call(w: &mut Win<'_>) {
	reading(w);
	let item = format!("transcript.entry:{REPLY}");
	let item = w
		.bounds(&item)
		.unwrap_or_else(|| panic!("the transcript lays out {item}"));
	let row = drawn(w, "Read");
	let column = 2.0f32
		.mul_add(-f32::from(space::S6), f32::from(item.size.width))
		.min(f32::from(size::COLUMN_MAX));
	let right = f32::from(item.center().x) + column / 2.0;
	w.click_at(point(px(right - f32::from(size::CONTROL) / 2.0), row.center().y));
}
