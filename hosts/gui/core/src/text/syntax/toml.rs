//! TOML. Section headers, bare and quoted keys, dates, and the multi-line
//! string forms.

use super::{
	Token,
	scan::{Scanner, SpanCollector, is_ident_continue, is_ident_start, scan_number_literal},
};

pub(super) fn scan_toml(body: &str, out: &mut SpanCollector) {
	let mut s = Scanner::new(body);

	while !s.is_eof() {
		let start = s.pos;

		if s.starts_with("#") {
			s.eat_while(|c| c != '\n');
			out.push(start..s.pos, Token::Comment);
			continue;
		}

		if s.starts_with("[") {
			s.eat_while(|c| c != ']' && c != '\n');
			if s.starts_with("]") {
				s.advance(1);
				if s.starts_with("]") {
					s.advance(1);
				}
			}
			out.push(start..s.pos, Token::Type);
			continue;
		}

		if s.starts_with("\"\"\"") || s.starts_with("'''") {
			let delim = if s.starts_with("\"\"\"") {
				"\"\"\""
			} else {
				"'''"
			};
			s.advance(3);
			while !s.is_eof() {
				if s.starts_with("\\") && delim == "\"\"\"" {
					s.advance(2.min(s.rest().len()));
				} else if s.starts_with(delim) {
					s.advance(3);
					break;
				} else {
					s.bump();
				}
			}
			out.push(start..s.pos, Token::Str);
			continue;
		}

		if s.starts_with("\"") || s.starts_with("'") {
			let q = s.bump().unwrap_or('"');
			while !s.is_eof() {
				if s.starts_with("\\") && q == '"' {
					s.advance(2.min(s.rest().len()));
				} else if s.peek() == Some(q) {
					s.bump();
					break;
				} else {
					s.bump();
				}
			}
			let str_range = start..s.pos;
			let mut look = Scanner::new(&body[s.pos..]);
			look.skip_inline_whitespace();
			if look.starts_with("=") && !look.starts_with("==") {
				out.push(str_range, Token::Attribute);
			} else {
				out.push(str_range, Token::Str);
			}
			continue;
		}

		if let Some(c) = s.peek()
			&& (is_ident_start(c) || c == '-')
		{
			let ident_start = s.pos;
			s.eat_while(|c| is_ident_continue(c) || c == '-' || c == '.');
			let ident = &body[ident_start..s.pos];

			let mut look = Scanner::new(&body[s.pos..]);
			look.skip_inline_whitespace();
			if look.starts_with("=") && !look.starts_with("==") {
				out.push(ident_start..s.pos, Token::Attribute);
				continue;
			}

			if ident == "true"
				|| ident == "false"
				|| ident == "nan"
				|| ident == "inf"
				|| ident == "+inf"
				|| ident == "-inf"
			{
				out.push(ident_start..s.pos, Token::Constant);
				continue;
			}
			s.pos = ident_start;
		}

		if let Some(num_range) = scan_number_literal(&mut s) {
			let num_str = &body[num_range.clone()];
			let rest = s.rest();
			if (rest.starts_with('-') || rest.starts_with(':') || rest.starts_with('T'))
				&& num_str.chars().all(|c| c.is_ascii_digit())
			{
				s.eat_while(|c| {
					c.is_ascii_alphanumeric() || c == '-' || c == ':' || c == '.' || c == 'Z'
				});
				out.push(num_range.start..s.pos, Token::Number);
				continue;
			}
			out.push(num_range, Token::Number);
			continue;
		}

		s.bump();
	}
}
