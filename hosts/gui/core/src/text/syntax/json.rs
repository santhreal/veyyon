//! JSON. Keys apart from values, escapes inside strings, numbers, and the
//! three bare constants.

use super::{
	Token,
	scan::{Scanner, SpanCollector, is_ident_continue, is_ident_start, scan_number_literal},
};

pub(super) fn scan_json(body: &str, out: &mut SpanCollector) {
	let mut s = Scanner::new(body);

	while !s.is_eof() {
		let start = s.pos;

		if s.starts_with("\"") {
			s.advance(1);
			while !s.is_eof() {
				if s.starts_with("\\") {
					s.advance(2.min(s.rest().len()));
				} else if s.starts_with("\"") {
					s.advance(1);
					break;
				} else {
					s.bump();
				}
			}
			let str_range = start..s.pos;
			let mut lookahead = Scanner::new(&body[s.pos..]);
			lookahead.skip_whitespace();
			if lookahead.starts_with(":") {
				out.push(str_range, Token::Attribute);
			} else {
				out.push(str_range, Token::Str);
			}
			continue;
		}

		if let Some(c) = s.peek()
			&& "{}[],:".contains(c)
		{
			s.bump();
			out.push(start..s.pos, Token::Punct);
			continue;
		}

		if let Some(num_range) = scan_number_literal(&mut s) {
			out.push(num_range, Token::Number);
			continue;
		}

		if let Some(c) = s.peek()
			&& is_ident_start(c)
		{
			s.eat_while(is_ident_continue);
			let ident = &body[start..s.pos];
			if ident == "true" || ident == "false" || ident == "null" {
				out.push(start..s.pos, Token::Constant);
				continue;
			}
			s.bump();
			continue;
		}

		s.bump();
	}
}
