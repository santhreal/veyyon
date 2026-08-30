//! Markdown shown as code, which is what a fence saying `markdown` asks for.
//! Parsing markdown for the transcript is `text::markdown`.

use super::{
	Token,
	scan::{Scanner, SpanCollector},
};

pub(super) fn scan_markdown(body: &str, out: &mut SpanCollector) {
	let mut s = Scanner::new(body);
	let mut at_line_start = true;

	while !s.is_eof() {
		let start = s.pos;

		if at_line_start {
			let mut look = Scanner::new(&body[s.pos..]);
			look.skip_inline_whitespace();
			if look.starts_with("#") {
				let hashes = look.eat_while(|c| c == '#');
				if hashes <= 6 && (look.starts_with(" ") || look.starts_with("\n") || look.is_eof()) {
					s.eat_while(|c| c != '\n');
					out.push(start..s.pos, Token::Keyword);
					at_line_start = true;
					if s.starts_with("\n") {
						s.advance(1);
					}
					continue;
				}
			}

			let mut list_look = Scanner::new(&body[s.pos..]);
			let ws = list_look.eat_while(|c| c == ' ' || c == '\t');
			if list_look.starts_with("- ")
				|| list_look.starts_with("* ")
				|| list_look.starts_with("+ ")
			{
				s.advance(ws);
				let marker_start = s.pos;
				s.advance(1);
				out.push(marker_start..s.pos, Token::Punct);
				at_line_start = false;
				continue;
			} else {
				let digits = list_look.eat_while(|c| c.is_ascii_digit());
				if digits > 0 && (list_look.starts_with(". ") || list_look.starts_with(") ")) {
					s.advance(ws);
					let marker_start = s.pos;
					s.advance(digits + 1);
					out.push(marker_start..s.pos, Token::Punct);
					at_line_start = false;
					continue;
				}
			}
		}

		if s.starts_with("`") {
			s.advance(1);
			while !s.is_eof() {
				if s.starts_with("`") {
					s.advance(1);
					break;
				} else if s.starts_with("\n") {
					break;
				} else {
					s.bump();
				}
			}
			out.push(start..s.pos, Token::Str);
			at_line_start = false;
			continue;
		}

		if s.starts_with("**") || s.starts_with("__") {
			let delim = if s.starts_with("**") { "**" } else { "__" };
			s.advance(2);
			while !s.is_eof() {
				if s.starts_with(delim) {
					s.advance(2);
					break;
				} else if s.starts_with("\n") {
					break;
				} else {
					s.bump();
				}
			}
			out.push(start..s.pos, Token::Type);
			at_line_start = false;
			continue;
		}

		if s.starts_with("[") {
			s.advance(1);
			let mut link_text_closed = false;
			while !s.is_eof() {
				if s.starts_with("]") {
					s.advance(1);
					link_text_closed = true;
					break;
				} else if s.starts_with("\n") {
					break;
				} else {
					s.bump();
				}
			}
			if link_text_closed && s.starts_with("(") {
				let target_start = s.pos;
				s.advance(1);
				while !s.is_eof() {
					if s.starts_with(")") {
						s.advance(1);
						break;
					} else if s.starts_with("\n") {
						break;
					} else {
						s.bump();
					}
				}
				out.push(target_start..s.pos, Token::Attribute);
				at_line_start = false;
				continue;
			}
			at_line_start = false;
			continue;
		}

		if let Some(c) = s.peek() {
			at_line_start = c == '\n';
		}

		s.bump();
	}
}
