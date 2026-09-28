//! What one transcript item drew, read off the last frame, and the host
//! events and clicks the sweeps drive the window with.

use gpui::{Bounds, Modifiers, Pixels};
use veyyon_desktop_app::{driver, transcript::plan::Piece};
use veyyon_desktop_model::{HostEvent, TranscriptEntry, tool_view::view_rows};

use super::{Thread, WINDOW};

/// The host appending `entries` to the open session's transcript.
pub fn appended(entries: Vec<TranscriptEntry>) -> HostEvent {
	let revision = entries
		.iter()
		.map(|entry| entry.revision)
		.max()
		.unwrap_or_default();
	HostEvent::TranscriptAppended { revision, entries }
}

/// The host restating `entry` in place, as a producer does while it grows.
pub const fn restated(entry: TranscriptEntry) -> HostEvent {
	HostEvent::TranscriptUpdated { revision: entry.revision, entry }
}

/// Draws the frame a finished picture load requests. A test window
/// delivers no frame on its own, so a picture decoded after its item first
/// drew shows what it decoded to only on the frame drawn here.
pub fn redrawn(thread: &mut Thread<'_>) {
	thread.cx.update(|window, _| window.refresh());
}

/// Where the driver last saw target `id` laid out.
pub fn laid_out(thread: &mut Thread<'_>, id: &str) -> Option<Bounds<Pixels>> {
	thread
		.cx
		.update(|window, cx| driver::bounds(cx, window.window_handle().window_id(), id))
}

/// The text runs item `id` drew in the last frame, in paint order, with
/// where each was painted. Blank runs are left out.
pub fn runs_in(thread: &mut Thread<'_>, id: &str) -> Vec<(String, Bounds<Pixels>)> {
	let Some(item) = laid_out(thread, &format!("transcript.entry:{id}")) else {
		return Vec::new();
	};
	thread
		.runs()
		.into_iter()
		.filter(|(run, bounds)| !run.trim().is_empty() && item.contains(&bounds.center()))
		.collect()
}

/// The words item `id` drew in the last frame, in paint order.
pub fn drawn_by(thread: &mut Thread<'_>, id: &str) -> Vec<String> {
	runs_in(thread, id)
		.into_iter()
		.map(|(run, _)| run)
		.collect()
}

/// Whether every word item `id` drew sits right of the window's middle, in
/// the operator's register, or every one left of it; `None` for an item
/// that drew no word or drew on both sides.
pub fn side_of(thread: &mut Thread<'_>, id: &str) -> Option<Side> {
	let middle = WINDOW.0 / 2.0;
	let sides: Vec<Side> = runs_in(thread, id)
		.into_iter()
		.map(|(_, bounds)| {
			if f32::from(bounds.center().x) > middle {
				Side::Operator
			} else {
				Side::Agent
			}
		})
		.collect();
	let first = *sides.first()?;
	sides.iter().all(|side| *side == first).then_some(first)
}

/// Which side of the column an item draws on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Side {
	/// The operator's register, at the right.
	Operator,
	/// Everything that came back, at the left.
	Agent,
}

/// Clicks the run the last frame drew reading `text`.
pub fn click_run(thread: &mut Thread<'_>, text: &str) {
	let at = thread
		.runs()
		.into_iter()
		.find(|(run, _)| run == text)
		.map_or_else(|| panic!("`{text}` was not drawn"), |(_, bounds)| bounds.center());
	thread.cx.simulate_click(at, Modifiers::none());
	thread.cx.run_until_parked();
}

/// The forms of item `ix`'s pieces, with every finished turn unfolded.
pub fn forms(thread: &mut Thread<'_>, ix: usize) -> Vec<String> {
	thread.plan(ix).pieces.iter().map(form).collect()
}

/// `piece` as the words a test compares. The match names every variant, so a
/// piece added to the plan does not compile here until it states its form.
pub fn form(piece: &Piece) -> String {
	match piece {
		Piece::Bubble(words) => format!("bubble: {words}"),
		Piece::Prose { block } => format!("prose #{block}"),
		Piece::Note { label, text, boundary } => {
			let edge = if *boundary { " (boundary)" } else { "" };
			format!("note {label}: {text}{edge}")
		},
		Piece::Thinking { block, text, redacted } => {
			let hidden = if *redacted { " (redacted)" } else { "" };
			let body = text
				.as_deref()
				.map_or_else(String::new, |text| format!(": {text}"));
			format!("thought #{block}{hidden}{body}")
		},
		Piece::Tool(row) => {
			let target = row.target.as_deref().unwrap_or_default();
			let open = if row.open { " (open)" } else { "" };
			format!("tool {} {:?}: {} {target}{open}", row.call_id, row.status, row.verb)
		},
		Piece::Worked { anchor, text, open } => {
			let open = if *open { " (open)" } else { "" };
			format!("worked from {anchor}: {text}{open}")
		},
		Piece::Pane { caption, lines, diff } => {
			let diff = if *diff { " (diff)" } else { "" };
			format!("pane {caption}: {}{diff}", lines.join(" | "))
		},
		Piece::Report { variant, view } => {
			format!("report {variant}: {}", view_rows(view).join(" | "))
		},
		Piece::Image { block, alt } => match alt {
			Some(alt) => format!("image #{block}: {alt}"),
			None => format!("image #{block}"),
		},
		Piece::File { path, detail } if detail.is_empty() => format!("file {path}"),
		Piece::File { path, detail } => format!("file {path}: {detail}"),
		Piece::Error(message) => format!("error: {message}"),
		Piece::Footer(model) => format!("footer: {model}"),
	}
}
