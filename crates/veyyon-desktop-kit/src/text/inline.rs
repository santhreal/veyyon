//! The inline markers markdown prose carries, and what each one is set in
//! (§8.25).
//!
//! WHY: the block reader drew a paragraph as one run of text, so `**Cut** the
//! tag`, `` `read` `` and `[the plan](docs/plan.md)` reached the frame with
//! their markers in them -- in every agent reply the transcript draws, not only
//! in a card. The markers are read here into spans, and each span is set in
//! what its marker means rather than drawn with the marker in it.
//!
//! What is NOT read here: a marker that is not one. A run followed by a space
//! opens nothing, `_` inside a word is a name's own byte, and an unpaired
//! marker is text. A code span's interior is literal, so nothing inside it is
//! read as a marker either.

use veyyon_gpui::{
	AnyElement, FontStyle, FontWeight, HighlightStyle, IntoElement, Pixels, SharedString,
	StyledText, UnderlineStyle, div, prelude::*, px,
};

use crate::token_set::{ColorRole, TokenSet};

/// What one span of prose is set in. A span carries every emphasis enclosing
/// it, so the `b` of `**a _b_**` is both strong and italic.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Emphasis {
	/// `**a**` or `__a__`.
	pub strong: bool,
	/// `*a*` or `_a_`.
	pub italic: bool,
	/// `` `a` ``: set in the mono family on the inset ground.
	pub code:   bool,
	/// The text of `[a](b)`.
	pub link:   bool,
	/// The target of `[a](b)`. No click reaches a link on this surface yet, so
	/// the target is drawn rather than hidden behind the text.
	pub muted:  bool,
}

impl Emphasis {
	/// Whether this span is set in anything other than the surrounding prose.
	const fn is_plain(self) -> bool {
		!self.strong && !self.italic && !self.code && !self.link && !self.muted
	}
}

/// One span of prose: the text drawn, and what it is set in.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Span {
	pub text:     String,
	pub emphasis: Emphasis,
}

/// What one byte of the source becomes on the frame.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Fate {
	/// Drawn.
	Keep,
	/// A marker: not drawn.
	Drop,
	/// A marker that parts what it joined: drawn as one space.
	Space,
	/// Inside a code span: drawn, and no marker is read in it.
	Literal,
}

/// The spans one line of markdown prose draws as, in the order it draws them.
#[must_use]
pub fn spans(text: &str) -> Vec<Span> {
	let bytes = text.as_bytes();
	let mut fate = vec![Fate::Keep; bytes.len()];
	let mut emphasis = vec![Emphasis::default(); bytes.len()];
	mark_code_spans(bytes, &mut fate, &mut emphasis);
	mark_emphasis(bytes, &mut fate, &mut emphasis);
	mark_links(bytes, &mut fate, &mut emphasis);

	let mut out: Vec<Span> = Vec::new();
	for (at, ch) in text.char_indices() {
		let (drawn, set) = match fate[at] {
			Fate::Drop => continue,
			Fate::Space => (' ', Emphasis::default()),
			Fate::Keep | Fate::Literal => (ch, emphasis[at]),
		};
		match out.last_mut() {
			Some(last) if last.emphasis == set => last.text.push(drawn),
			_ => out.push(Span { text: drawn.to_string(), emphasis: set }),
		}
	}
	out
}

/// The prose with its inline markers off, for a surface that draws one
/// unstyled line of it.
#[must_use]
pub fn plain(text: &str) -> String {
	spans(text).into_iter().map(|span| span.text).collect()
}

/// Prose set at `size`, with each marker drawn as what it means.
///
/// The element inherits the caller's ink, family and width, so a span that is
/// set in nothing is drawn exactly as the surrounding prose, and a row of
/// spans sizes to its content rather than to the row.
pub fn inline_prose(
	text: &str,
	tokens: &TokenSet,
	size: Pixels,
	line_height: Pixels,
) -> AnyElement {
	let read = spans(text);
	let mut drawn = String::with_capacity(text.len());
	let mut highlights = Vec::new();
	let mut mono = Vec::new();
	for span in &read {
		let start = drawn.len();
		drawn.push_str(&span.text);
		if span.emphasis.is_plain() {
			continue;
		}
		if span.emphasis.code {
			mono.push((start..drawn.len(), tokens.mono_family()));
		}
		highlights.push((start..drawn.len(), span_style(span.emphasis, tokens)));
	}

	let styled = StyledText::new(SharedString::from(drawn))
		.with_highlights(highlights)
		.with_font_family_overrides(mono);
	div()
		.text_size(size)
		.line_height(line_height)
		.child(styled)
		.into_any_element()
}

/// The style one span's emphasis is set in. A caller that shapes prose itself
/// reads the mapping here rather than restating it.
#[must_use]
pub fn span_style(emphasis: Emphasis, tokens: &TokenSet) -> HighlightStyle {
	let mut style = HighlightStyle::default();
	if emphasis.strong {
		style.font_weight = Some(FontWeight::BOLD);
	}
	if emphasis.italic {
		style.font_style = Some(FontStyle::Italic);
	}
	if emphasis.code {
		style.background_color = Some(tokens.color(ColorRole::Inset));
	}
	if emphasis.link {
		let accent = tokens.color(ColorRole::Accent);
		style.color = Some(accent);
		style.underline =
			Some(UnderlineStyle { thickness: px(1.0), color: Some(accent), wavy: false });
	}
	if emphasis.muted {
		style.color = Some(tokens.color(ColorRole::Muted));
	}
	style
}

/// A pair of backticks: the delimiters go, and the interior is literal, so no
/// marker is read inside a command.
fn mark_code_spans(bytes: &[u8], fate: &mut [Fate], emphasis: &mut [Emphasis]) {
	let mut at = 0;
	while at < bytes.len() {
		if bytes[at] == b'`'
			&& let Some(close) = (at + 1..bytes.len()).find(|&j| bytes[j] == b'`')
			&& close > at + 1
		{
			fate[at] = Fate::Drop;
			fate[close] = Fate::Drop;
			for byte in &mut fate[at + 1..close] {
				*byte = Fate::Literal;
			}
			for span in &mut emphasis[at + 1..close] {
				span.code = true;
			}
			at = close + 1;
			continue;
		}
		at += 1;
	}
}

/// The `*` and `_` runs that open and close emphasis, and only those.
fn mark_emphasis(bytes: &[u8], fate: &mut [Fate], emphasis: &mut [Emphasis]) {
	let mut at = 0;
	while at < bytes.len() {
		let delimiter = bytes[at];
		if fate[at] != Fate::Keep || !matches!(delimiter, b'*' | b'_') {
			at += 1;
			continue;
		}
		let width = run_len(bytes, at, delimiter).min(2);
		let opens = bytes
			.get(at + width)
			.is_some_and(|b| !b.is_ascii_whitespace())
			&& !(delimiter == b'_' && at > 0 && bytes[at - 1].is_ascii_alphanumeric());
		if !opens {
			at += width;
			continue;
		}
		if let Some(close) = closer(bytes, fate, at + width, delimiter, width) {
			for byte in &mut fate[at..at + width] {
				*byte = Fate::Drop;
			}
			for byte in &mut fate[close..close + width] {
				*byte = Fate::Drop;
			}
			for span in &mut emphasis[at + width..close] {
				if width == 2 {
					span.strong = true;
				} else {
					span.italic = true;
				}
			}
		}
		at += width;
	}
}

/// The closing run for an emphasis opener: `width` bytes of `delimiter`, with
/// text before it, not preceded by a space, and not inside a word for `_`.
fn closer(bytes: &[u8], fate: &[Fate], from: usize, delimiter: u8, width: usize) -> Option<usize> {
	let mut at = from;
	while at < bytes.len() {
		if fate[at] == Fate::Keep
			&& bytes[at] == delimiter
			&& at > from
			&& run_len(bytes, at, delimiter) >= width
			&& !bytes[at - 1].is_ascii_whitespace()
			&& !(delimiter == b'_' && bytes.get(at + width).is_some_and(u8::is_ascii_alphanumeric))
		{
			return Some(at);
		}
		at += 1;
	}
	None
}

/// The bytes of one run of `delimiter` starting at `at`.
fn run_len(bytes: &[u8], at: usize, delimiter: u8) -> usize {
	bytes[at..].iter().take_while(|b| **b == delimiter).count()
}

/// A `[text](target)` link: the brackets go, the closing one leaving the space
/// that parts the text from the target it names. An image is read the same
/// way, its `!` going with the bracket it opens, because no picture is drawn
/// from prose here: the alt text and the source are what there is to state.
fn mark_links(bytes: &[u8], fate: &mut [Fate], emphasis: &mut [Emphasis]) {
	let mut at = 0;
	while at < bytes.len() {
		if fate[at] != Fate::Keep || bytes[at] != b'[' {
			at += 1;
			continue;
		}
		let Some(close) = (at + 1..bytes.len()).find(|&j| fate[j] == Fate::Keep && bytes[j] == b']')
		else {
			at += 1;
			continue;
		};
		let target_end = if bytes.get(close + 1) == Some(&b'(') {
			(close + 2..bytes.len()).find(|&j| bytes[j] == b')')
		} else {
			None
		};
		let Some(end) = target_end else {
			at = close + 1;
			continue;
		};
		if at > 0 && bytes[at - 1] == b'!' && fate[at - 1] == Fate::Keep {
			fate[at - 1] = Fate::Drop;
		}
		fate[at] = Fate::Drop;
		fate[close] = Fate::Space;
		for span in &mut emphasis[at + 1..close] {
			span.link = true;
		}
		for span in &mut emphasis[close + 1..=end] {
			span.muted = true;
		}
		at = end + 1;
	}
}
