//! ANSI syntax highlighting over syntect, reduced to eleven semantic colours.
//!
//! A caller supplies eleven ANSI escape strings and gets back the source with
//! those strings around the runs each one applies to. The crate holds no theme:
//! [`scope_map`] collapses every scope any bundled syntax can emit into one of
//! the eleven slots, so a theme is entirely the caller's business.

pub mod scope_map;
pub mod syntaxes;

use syntect::parsing::{ParseState, ScopeStack, ScopeStackOp};

pub use crate::syntaxes::{is_known_alias, syntax_set};
use crate::{
	scope_map::{SLOTS, scope_to_color_index},
	syntaxes::find_syntax,
};

/// The eleven ANSI strings a highlight pass can emit, one per semantic
/// category. An empty string means "emit this category's text uncoloured",
/// which is how a caller opts a category out.
#[derive(Debug, Clone, Copy, Default)]
pub struct Palette<'a> {
	pub comment:     &'a str,
	pub keyword:     &'a str,
	pub function:    &'a str,
	pub variable:    &'a str,
	pub string:      &'a str,
	pub number:      &'a str,
	pub type_name:   &'a str,
	pub operator:    &'a str,
	pub punctuation: &'a str,
	/// Diff added lines. Empty when the caller is not rendering a diff.
	pub inserted:    &'a str,
	/// Diff removed lines. Empty when the caller is not rendering a diff.
	pub deleted:     &'a str,
}

impl<'a> Palette<'a> {
	/// Slot-indexed view, ordered to match the `scope_map` slot constants.
	#[inline]
	const fn slots(&self) -> [&'a str; SLOTS] {
		[
			self.comment,
			self.keyword,
			self.function,
			self.variable,
			self.string,
			self.number,
			self.type_name,
			self.operator,
			self.punctuation,
			self.inserted,
			self.deleted,
		]
	}
}

/// Reset to the terminal's default foreground. Emitted after every coloured
/// run rather than tracking the previous colour, so a run is self-contained and
/// a caller can cut the output at any line boundary.
const RESET: &str = "\x1b[39m";

/// Highlight `code` as `lang`, or as plain text when `lang` is absent or names
/// nothing this crate can resolve.
///
/// A line syntect declines to parse is emitted verbatim and parsing continues
/// on the next one: one malformed line costs its own colours, not the rest of
/// the file's.
pub fn highlight(code: &str, lang: Option<&str>, palette: &Palette<'_>) -> String {
	let slots = palette.slots();
	let ss = syntax_set();
	let syntax = lang
		.and_then(|l| find_syntax(ss, l))
		.unwrap_or_else(|| ss.find_syntax_plain_text());

	let mut parse_state = ParseState::new(syntax);
	let mut scope_stack = ScopeStack::new();
	let mut result = String::with_capacity(code.len() * 2);

	for line in syntect::util::LinesWithEndings::from(code) {
		let Ok(ops) = parse_state.parse_line(line, ss) else {
			result.push_str(line);
			continue;
		};

		let mut prev_end = 0;
		for (offset, op) in ops {
			let offset = offset.min(line.len());

			// Text before this operation belongs to the scope stack as it
			// stands, so it is emitted before the stack moves.
			if offset > prev_end {
				push_run(&mut result, &line[prev_end..offset], &scope_stack, &slots);
			}
			prev_end = offset;

			match op {
				ScopeStackOp::Push(scope) => scope_stack.push(scope),
				ScopeStackOp::Pop(count) => {
					for _ in 0..count {
						scope_stack.pop();
					}
				},
				ScopeStackOp::Restore | ScopeStackOp::Clear(_) | ScopeStackOp::Noop => {},
			}
		}

		if prev_end < line.len() {
			push_run(&mut result, &line[prev_end..], &scope_stack, &slots);
		}
	}

	result
}

/// Append one run of text, wrapped in its slot's colour when it has one.
#[inline]
fn push_run(out: &mut String, text: &str, stack: &ScopeStack, slots: &[&str; SLOTS]) {
	let slot = scope_to_color_index(stack);
	match slots.get(slot) {
		Some(color) if !color.is_empty() => {
			out.push_str(color);
			out.push_str(text);
			out.push_str(RESET);
		},
		// Either the scope mapped to nothing, or the caller left this slot
		// empty. Both mean uncoloured text.
		_ => out.push_str(text),
	}
}

/// Whether `lang` resolves to a syntax, directly or through the alias table.
pub fn supports_language(lang: &str) -> bool {
	is_known_alias(lang) || find_syntax(syntax_set(), lang).is_some()
}

/// Every syntax name in the set, in set order.
pub fn supported_languages() -> Vec<String> {
	syntax_set()
		.syntaxes()
		.iter()
		.map(|s| s.name.clone())
		.collect()
}
