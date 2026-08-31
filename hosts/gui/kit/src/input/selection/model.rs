//! Core data types and algorithms for run-anchored text selection.

use std::ops::Range;

use super::geometry::snap_to_grapheme;

/// An anchor or head position within a rendered run.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Position {
	pub run:    String,
	pub offset: usize,
}

impl Position {
	pub fn new(run: impl Into<String>, offset: usize) -> Self {
		Self { run: run.into(), offset }
	}
}

/// One element's slice of the active selection in document order.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Span {
	pub key:   String,
	pub range: Range<usize>,
	pub text:  String,
}

/// Pure selection state over rendered runs.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Selection {
	anchor:   Option<Position>,
	head:     Option<Position>,
	dragging: bool,
	forward:  Option<bool>,
	spans:    Vec<Span>,
}

impl Selection {
	pub fn new() -> Self {
		Self::default()
	}

	pub fn anchor(&self) -> Option<&Position> {
		self.anchor.as_ref()
	}

	pub fn head(&self) -> Option<&Position> {
		self.head.as_ref()
	}

	pub fn is_dragging(&self) -> bool {
		self.dragging
	}

	pub fn is_empty(&self) -> bool {
		self.spans.is_empty() || self.spans.iter().all(|s| s.range.is_empty())
	}

	pub fn spans(&self) -> &[Span] {
		&self.spans
	}

	/// Normalise anchor and head into ordered start and end positions given
	/// document-ordered elements.
	pub fn normalize(&self, elements: &[(&str, &str)]) -> Option<(Position, Position)> {
		let anchor = self.anchor.as_ref()?;
		let head = self.head.as_ref().unwrap_or(anchor);

		let anchor_ix = elements.iter().position(|(k, _)| *k == anchor.run)?;
		let head_ix = elements.iter().position(|(k, _)| *k == head.run)?;

		if (anchor_ix, anchor.offset) <= (head_ix, head.offset) {
			Some((anchor.clone(), head.clone()))
		} else {
			Some((head.clone(), anchor.clone()))
		}
	}

	/// Begin a selection drag anchored at `key` and byte `offset`.
	pub fn begin(&mut self, key: &str, offset: usize, text: &str) {
		let offset = snap_to_grapheme(text, offset);
		let pos = Position::new(key, offset);
		self.anchor = Some(pos.clone());
		self.head = Some(pos);
		self.dragging = true;
		self.forward = None;
		self.spans.clear();
	}

	/// Begin a selection with an explicit pre-resolved span (e.g. word or line).
	pub fn begin_with_span(&mut self, key: &str, text: &str, range: Range<usize>) {
		let start = snap_to_grapheme(text, range.start);
		let end = snap_to_grapheme(text, range.end).max(start);
		self.anchor = Some(Position::new(key, start));
		self.head = Some(Position::new(key, end));
		self.dragging = false;
		self.forward = Some(true);
		if start < end {
			self.spans =
				vec![Span { key: key.to_string(), range: start..end, text: text.to_string() }];
		} else {
			self.spans.clear();
		}
	}

	/// Extend selection from existing anchor to a new head at `key` and
	/// `offset`.
	pub fn extend_anchor(&mut self, key: &str, offset: usize, elements: &[(&str, &str)]) {
		let Some((_, text)) = elements.iter().find(|(k, _)| *k == key) else {
			return;
		};
		let offset = snap_to_grapheme(text, offset);
		if self.anchor.is_none() {
			self.begin(key, offset, text);
			return;
		}
		let head_pos = Position::new(key, offset);
		self.head = Some(head_pos);
		self.dragging = false;
		if let Some((start, end)) = self.normalize(elements) {
			let a_ix = elements.iter().position(|(k, _)| *k == start.run);
			let b_ix = elements.iter().position(|(k, _)| *k == end.run);
			if let (Some(a), Some(b)) = (a_ix, b_ix) {
				self.spans = resolve_spans(elements, (a, start.offset), (b, end.offset));
			}
		}
	}

	/// Update active drag head position against visible document elements.
	pub fn update_drag(&mut self, elements: &[(&str, &str)], head: (usize, usize)) -> bool {
		if !self.dragging {
			return false;
		}
		let Some(anchor) = self.anchor.as_ref() else {
			return false;
		};
		let (head_key, head_raw_text) = match elements.get(head.0) {
			Some((k, t)) => (*k, *t),
			None => return false,
		};
		let head_offset = snap_to_grapheme(head_raw_text, head.1);
		self.head = Some(Position::new(head_key, head_offset));

		let spans = if let Some(anchor_ei) = elements.iter().position(|(k, _)| *k == anchor.run) {
			let anchor_pt = (anchor_ei, anchor.offset);
			let head_pt = (head.0, head_offset);
			self.forward = Some(anchor_pt <= head_pt);
			resolve_spans(elements, anchor_pt, head_pt)
		} else {
			let Some(forward) = self.forward else {
				return false;
			};
			let Some(spans) =
				extend_virtualized_drag(&self.spans, elements, (head.0, head_offset), forward)
			else {
				return false;
			};
			spans
		};

		if self.spans == spans {
			return false;
		}
		self.spans = spans;
		true
	}

	/// End an active drag, returning the plain text if non-empty.
	pub fn end_drag(&mut self, key: Option<&str>) -> Option<String> {
		if let Some(k) = key
			&& self.anchor.as_ref().map(|a| a.run.as_str()) != Some(k)
		{
			return None;
		}
		if !self.dragging {
			return None;
		}
		self.dragging = false;
		if self.is_empty() {
			self.clear();
			return None;
		}
		self.selected_text()
	}

	/// Clear the selection.
	pub fn clear(&mut self) -> bool {
		let changed = self.anchor.is_some() || !self.spans.is_empty();
		self.anchor = None;
		self.head = None;
		self.dragging = false;
		self.forward = None;
		self.spans.clear();
		changed
	}

	/// Clear if `key` matches the anchor element.
	pub fn clear_if_owner(&mut self, key: &str) -> bool {
		if self.anchor.as_ref().map(|a| a.run.as_str()) == Some(key) && !self.dragging {
			self.clear()
		} else {
			false
		}
	}

	/// The active wash range for `key`.
	pub fn wash_range(&self, key: &str) -> Option<Range<usize>> {
		self
			.spans
			.iter()
			.find(|s| s.key == key && !s.range.is_empty())
			.map(|s| s.range.clone())
	}

	/// Joined plain text of the selection in document order.
	pub fn selected_text(&self) -> Option<String> {
		if self.is_empty() {
			return None;
		}
		let text = self
			.spans
			.iter()
			.filter(|s| !s.range.is_empty() && s.range.end <= s.text.len())
			.map(|s| &s.text[s.range.clone()])
			.collect::<Vec<_>>()
			.join("\n");
		(!text.is_empty()).then_some(text)
	}

	/// Select all visible elements.
	pub fn select_all(&mut self, elements: &[(&str, &str)]) -> bool {
		if elements.is_empty() {
			return false;
		}
		let first_key = elements[0].0;
		let last_key = elements[elements.len() - 1].0;
		let last_text = elements[elements.len() - 1].1;
		self.anchor = Some(Position::new(first_key, 0));
		self.head = Some(Position::new(last_key, last_text.len()));
		self.dragging = false;
		self.forward = Some(true);
		self.spans = elements
			.iter()
			.filter(|(_, text)| !text.is_empty())
			.map(|(key, text)| Span {
				key:   (*key).to_string(),
				range: 0..text.len(),
				text:  (*text).to_string(),
			})
			.collect();
		!self.spans.is_empty()
	}

	/// Select elements matching an entry prefix.
	pub fn select_entry(&mut self, entry_prefix: &str, elements: &[(&str, &str)]) -> bool {
		let matching: Vec<_> = elements
			.iter()
			.filter(|(k, _)| k.starts_with(entry_prefix))
			.copied()
			.collect();
		self.select_all(&matching)
	}
}

/// Resolve spans between two `(element_index, byte_offset)` pairs.
pub fn resolve_spans(elements: &[(&str, &str)], a: (usize, usize), b: (usize, usize)) -> Vec<Span> {
	let (start, end) = if (a.0, a.1) <= (b.0, b.1) {
		(a, b)
	} else {
		(b, a)
	};
	let mut spans = Vec::new();
	for (ei, (key, text)) in elements.iter().enumerate().take(end.0 + 1).skip(start.0) {
		let from = if ei == start.0 {
			snap_to_grapheme(text, start.1)
		} else {
			0
		};
		let to = if ei == end.0 {
			snap_to_grapheme(text, end.1)
		} else {
			text.len()
		};
		let from = from.min(text.len());
		let to = to.min(text.len()).max(from);
		if from < to {
			spans.push(Span {
				key:   (*key).to_string(),
				range: from..to,
				text:  (*text).to_string(),
			});
		}
	}
	spans
}

fn extend_virtualized_drag(
	existing: &[Span],
	elements: &[(&str, &str)],
	head: (usize, usize),
	forward: bool,
) -> Option<Vec<Span>> {
	if forward {
		let (element_ix, span_ix) = elements.iter().enumerate().find_map(|(e_ix, (key, _))| {
			existing
				.iter()
				.position(|s| s.key == *key)
				.map(|s_ix| (e_ix, s_ix))
		})?;
		let start = existing[span_ix].range.start;
		let mut merged = existing[..span_ix].to_vec();
		merged.extend(resolve_spans(elements, (element_ix, start), head));
		Some(merged)
	} else {
		let (element_ix, span_ix) =
			elements
				.iter()
				.enumerate()
				.rev()
				.find_map(|(e_ix, (key, _))| {
					existing
						.iter()
						.position(|s| s.key == *key)
						.map(|s_ix| (e_ix, s_ix))
				})?;
		let end = existing[span_ix].range.end;
		let mut merged = resolve_spans(elements, head, (element_ix, end));
		merged.extend_from_slice(&existing[span_ix + 1..]);
		Some(merged)
	}
}
