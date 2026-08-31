//! Text selection model, span resolution, and geometry for rendered runs.
//!
//! A selection is anchored to a rendered run and a byte offset within it. When
//! dragging across runs or backwards, the selection normalises so that spans
//! are produced in document order. Grapheme clusters are never split.

use std::{
	ops::Range,
	sync::{LazyLock, Mutex},
};

use gpui::{HighlightStyle, Hsla};

use crate::theme::Theme;

pub mod geometry;
pub mod model;

pub use geometry::{line_range, snap_to_grapheme, word_range};
pub use model::{Position, Selection, Span, resolve_spans};

static STATE: LazyLock<Mutex<Selection>> = LazyLock::new(|| Mutex::new(Selection::default()));
static DOCUMENT: LazyLock<Mutex<Vec<(String, String)>>> = LazyLock::new(|| Mutex::new(Vec::new()));

/// Record the document elements in order for the current frame.
pub fn publish_document(elements: &[(String, String)]) {
	if let Ok(mut guard) = DOCUMENT.lock() {
		*guard = elements.to_vec();
	}
}

/// Record document elements from string slices.
pub fn publish_document_slices(elements: &[(&str, &str)]) {
	if let Ok(mut guard) = DOCUMENT.lock() {
		*guard = elements
			.iter()
			.map(|(k, v)| ((*k).to_string(), (*v).to_string()))
			.collect();
	}
}

/// Begin selection anchored at `key` and byte `offset`, resolving text from the
/// published document.
pub fn begin_at(key: &str, offset: usize) {
	let text = {
		let doc = DOCUMENT.lock().ok();
		doc.as_ref()
			.and_then(|d| d.iter().find(|(k, _)| k == key).map(|(_, t)| t.clone()))
			.unwrap_or_default()
	};
	if let Ok(mut guard) = global_state().lock() {
		guard.begin(key, offset, &text);
	}
}

/// Extend selection drag to a live pointer position at `key` and `offset`.
/// Returns true if the selection spans changed.
pub fn drag_to(key: &str, offset: usize) -> bool {
	let doc_guard = match DOCUMENT.lock() {
		Ok(g) => g,
		Err(_) => return false,
	};
	let Some(index) = doc_guard.iter().position(|(k, _)| k == key) else {
		return false;
	};
	let refs: Vec<(&str, &str)> = doc_guard
		.iter()
		.map(|(k, v)| (k.as_str(), v.as_str()))
		.collect();
	update_drag(&refs, (index, offset))
}

/// Extend selection anchor to `key` and `offset`, resolving through the
/// published document.
pub fn extend_anchor_at(key: &str, offset: usize) -> bool {
	let doc_guard = match DOCUMENT.lock() {
		Ok(g) => g,
		Err(_) => return false,
	};
	let refs: Vec<(&str, &str)> = doc_guard
		.iter()
		.map(|(k, v)| (k.as_str(), v.as_str()))
		.collect();
	extend_anchor(key, offset, &refs);
	true
}

fn global_state() -> &'static Mutex<Selection> {
	&STATE
}

/// The theme selection wash color.
pub fn selection_wash(theme: &Theme) -> Hsla {
	theme.accent.opacity(0.28)
}

/// Overlay selection background highlight onto a list of style ranges.
pub fn apply_selection_highlights(
	text: &str,
	key: &str,
	mut highlights: Vec<(Range<usize>, HighlightStyle)>,
	theme: &Theme,
) -> Vec<(Range<usize>, HighlightStyle)> {
	let Some(range) = wash_range(key) else {
		return highlights;
	};
	let start = range.start.min(text.len());
	let end = range.end.min(text.len());
	if start >= end {
		return highlights;
	}
	let wash = selection_wash(theme);
	let mut out = Vec::new();
	let mut covered_until = 0;

	for (h_range, style) in highlights.drain(..) {
		let h_start = h_range.start.min(text.len());
		let h_end = h_range.end.min(text.len());
		if h_start >= h_end {
			continue;
		}
		if h_start > covered_until && start < h_start && end > covered_until {
			let s = start.max(covered_until);
			let e = end.min(h_start);
			if s < e {
				out.push((s..e, HighlightStyle { background_color: Some(wash), ..Default::default() }));
			}
		}
		let overlap_start = h_start.max(start);
		let overlap_end = h_end.min(end);
		if overlap_start < overlap_end {
			if h_start < overlap_start {
				out.push((h_start..overlap_start, style));
			}
			let mut selected_style = style;
			selected_style.background_color = Some(wash);
			out.push((overlap_start..overlap_end, selected_style));
			if overlap_end < h_end {
				out.push((overlap_end..h_end, style));
			}
		} else {
			out.push((h_start..h_end, style));
		}
		covered_until = h_end;
	}

	if start > covered_until {
		out.push((start..end, HighlightStyle { background_color: Some(wash), ..Default::default() }));
	} else if end > covered_until {
		out.push((covered_until.max(start)..end, HighlightStyle {
			background_color: Some(wash),
			..Default::default()
		}));
	}

	out
}

pub fn begin(key: &str, offset: usize) {
	if let Ok(mut guard) = global_state().lock() {
		guard.begin(key, offset, "");
	}
}

pub fn begin_with_span(key: &str, text: &str, range: Range<usize>) {
	if let Ok(mut guard) = global_state().lock() {
		guard.begin_with_span(key, text, range);
	}
}

pub fn extend_anchor(key: &str, offset: usize, elements: &[(&str, &str)]) {
	if let Ok(mut guard) = global_state().lock() {
		guard.extend_anchor(key, offset, elements);
	}
}

pub fn update_drag(elements: &[(&str, &str)], head: (usize, usize)) -> bool {
	if let Ok(mut guard) = global_state().lock() {
		guard.update_drag(elements, head)
	} else {
		false
	}
}

pub fn end_drag(key: &str) -> Option<String> {
	let mut guard = global_state().lock().ok()?;
	guard.end_drag(Some(key))
}

pub fn end_active_drag() -> Option<String> {
	let mut guard = global_state().lock().ok()?;
	guard.end_drag(None)
}

pub fn clear() -> bool {
	if let Ok(mut guard) = global_state().lock() {
		guard.clear()
	} else {
		false
	}
}

pub fn clear_if_owner(key: &str) -> bool {
	if let Ok(mut guard) = global_state().lock() {
		guard.clear_if_owner(key)
	} else {
		false
	}
}

pub fn wash_range(key: &str) -> Option<Range<usize>> {
	let guard = global_state().lock().ok()?;
	guard.wash_range(key)
}

pub fn selected_text() -> Option<String> {
	let guard = global_state().lock().ok()?;
	guard.selected_text()
}

pub fn is_dragging() -> bool {
	global_state()
		.lock()
		.map(|g| g.is_dragging())
		.unwrap_or(false)
}

pub fn drag_anchor(key: &str) -> Option<usize> {
	let guard = global_state().lock().ok()?;
	(guard.is_dragging() && guard.anchor().map(|a| a.run.as_str()) == Some(key))
		.then(|| guard.anchor().map(|a| a.offset).unwrap_or(0))
}

pub fn select_all(elements: &[(&str, &str)]) -> bool {
	if let Ok(mut guard) = global_state().lock() {
		guard.select_all(elements)
	} else {
		false
	}
}

pub fn select_entry(entry_prefix: &str, elements: &[(&str, &str)]) -> bool {
	if let Ok(mut guard) = global_state().lock() {
		guard.select_entry(entry_prefix, elements)
	} else {
		false
	}
}
