//! The shared machinery every language scanner is built from: a cursor over the
//! body, and a collector that keeps the output ordered and non-overlapping.
//!
//! A scanner never trusts its own arithmetic to land on a character boundary,
//! because a body is arbitrary text from a message and a slice off a boundary
//! is a panic in a draw path.

use std::ops::Range;

use super::Token;

pub(super) struct SpanCollector {
	pub(super) spans: Vec<(Range<usize>, Token)>,
}

impl SpanCollector {
	pub(super) fn new() -> Self {
		Self { spans: Vec::new() }
	}

	pub(super) fn push(&mut self, range: Range<usize>, token: Token) {
		if range.start >= range.end {
			return;
		}
		if let Some(last) = self.spans.last()
			&& range.start < last.0.end
		{
			return;
		}
		self.spans.push((range, token));
	}

	pub(super) fn finish(mut self, max_len: usize) -> Vec<(Range<usize>, Token)> {
		self
			.spans
			.retain(|(r, _)| r.start < r.end && r.end <= max_len);
		self.spans
	}
}

pub(super) struct Scanner<'a> {
	pub(super) source: &'a str,
	pub(super) pos:    usize,
}

impl<'a> Scanner<'a> {
	pub(super) fn new(source: &'a str) -> Self {
		Self { source, pos: 0 }
	}

	pub(super) fn is_eof(&self) -> bool {
		self.pos >= self.source.len()
	}

	pub(super) fn rest(&self) -> &'a str {
		if self.pos >= self.source.len() {
			""
		} else {
			&self.source[self.pos..]
		}
	}

	pub(super) fn peek(&self) -> Option<char> {
		self.rest().chars().next()
	}

	pub(super) fn peek_at(&self, offset: usize) -> Option<char> {
		self.rest().chars().nth(offset)
	}

	pub(super) fn starts_with(&self, s: &str) -> bool {
		self.rest().starts_with(s)
	}

	pub(super) fn bump(&mut self) -> Option<char> {
		if let Some(c) = self.peek() {
			self.pos += c.len_utf8();
			Some(c)
		} else {
			None
		}
	}

	pub(super) fn advance(&mut self, bytes: usize) {
		self.pos = (self.pos + bytes).min(self.source.len());
		while !self.source.is_char_boundary(self.pos) && self.pos < self.source.len() {
			self.pos += 1;
		}
	}

	pub(super) fn eat_while<F: Fn(char) -> bool>(&mut self, pred: F) -> usize {
		let start = self.pos;
		while let Some(c) = self.peek() {
			if pred(c) {
				self.bump();
			} else {
				break;
			}
		}
		self.pos - start
	}

	pub(super) fn skip_whitespace(&mut self) {
		self.eat_while(|c| c.is_whitespace());
	}

	pub(super) fn skip_inline_whitespace(&mut self) {
		self.eat_while(|c| c == ' ' || c == '\t');
	}
}

pub(super) fn is_ident_start(c: char) -> bool {
	c.is_alphabetic() || c == '_'
}

pub(super) fn is_ident_continue(c: char) -> bool {
	c.is_alphanumeric() || c == '_'
}

pub(super) fn is_screaming_case(s: &str) -> bool {
	let mut has_upper = false;
	for c in s.chars() {
		if c.is_lowercase() {
			return false;
		}
		if c.is_uppercase() {
			has_upper = true;
		}
	}
	has_upper && (s.contains('_') || s.len() >= 2)
}

pub(super) fn scan_number_literal(s: &mut Scanner) -> Option<Range<usize>> {
	let start = s.pos;
	let rest = s.rest();

	if rest.starts_with("0x") || rest.starts_with("0X") {
		s.advance(2);
		s.eat_while(|c| c.is_ascii_hexdigit() || c == '_');
		s.eat_while(is_ident_continue);
		return Some(start..s.pos);
	}
	if rest.starts_with("0b") || rest.starts_with("0B") {
		s.advance(2);
		s.eat_while(|c| c == '0' || c == '1' || c == '_');
		s.eat_while(is_ident_continue);
		return Some(start..s.pos);
	}
	if rest.starts_with("0o") || rest.starts_with("0O") {
		s.advance(2);
		s.eat_while(|c| ('0'..='7').contains(&c) || c == '_');
		s.eat_while(is_ident_continue);
		return Some(start..s.pos);
	}

	if let Some(c) = s.peek()
		&& c.is_ascii_digit()
	{
		s.bump();
		s.eat_while(|c| c.is_ascii_digit() || c == '_');

		if s.starts_with(".")
			&& !s.starts_with("..")
			&& let Some(next_c) = s.peek_at(1)
			&& next_c.is_ascii_digit()
		{
			s.bump();
			s.eat_while(|c| c.is_ascii_digit() || c == '_');
		}

		if s.starts_with("e") || s.starts_with("E") {
			let after_e = &s.rest()[1..];
			if after_e.starts_with('+') || after_e.starts_with('-') {
				if after_e[1..]
					.chars()
					.next()
					.is_some_and(|c| c.is_ascii_digit())
				{
					s.advance(2);
					s.eat_while(|c| c.is_ascii_digit() || c == '_');
				}
			} else if after_e.chars().next().is_some_and(|c| c.is_ascii_digit()) {
				s.advance(1);
				s.eat_while(|c| c.is_ascii_digit() || c == '_');
			}
		}

		s.eat_while(is_ident_continue);
		return Some(start..s.pos);
	}
	None
}
