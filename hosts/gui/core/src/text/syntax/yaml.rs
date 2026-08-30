//! YAML. Keys, list markers, anchors, block scalar introducers and the
//! constants a reader expects coloured.

use super::{
	Token,
	scan::{Scanner, SpanCollector, is_ident_continue, is_ident_start, scan_number_literal},
};

pub(super) fn scan_yaml(body: &str, out: &mut SpanCollector) {
	let mut s = Scanner::new(body);

	while !s.is_eof() {
		let start = s.pos;

		if s.starts_with("#") {
			s.eat_while(|c| c != '\n');
			out.push(start..s.pos, Token::Comment);
			continue;
		}

		let is_dash_marker =
			s.starts_with("- ") || s.starts_with("-\n") || (s.starts_with("-") && s.rest().len() == 1);
		if is_dash_marker {
			s.advance(1);
			out.push(start..s.pos, Token::Punct);
			continue;
		}

		if s.starts_with("&") || s.starts_with("*") {
			s.advance(1);
			let ident_len = s.eat_while(is_ident_continue);
			if ident_len > 0 {
				out.push(start..s.pos, Token::Type);
				continue;
			}
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
			if look.starts_with(":") {
				out.push(str_range, Token::Attribute);
			} else {
				out.push(str_range, Token::Str);
			}
			continue;
		}

		if s.starts_with("|") || s.starts_with(">") {
			s.advance(1);
			s.eat_while(|c| c != '\n');
			let block_start = s.pos;
			while !s.is_eof() {
				if s.starts_with("\n") {
					s.advance(1);
					let indent = s.eat_while(|c| c == ' ' || c == '\t');
					if indent == 0 && !s.starts_with("\n") && !s.is_eof() {
						s.pos -= indent;
						break;
					}
					s.eat_while(|c| c != '\n');
				} else {
					s.bump();
				}
			}
			out.push(block_start..s.pos, Token::Str);
			continue;
		}

		if let Some(c) = s.peek()
			&& is_ident_start(c)
		{
			let ident_start = s.pos;
			s.eat_while(|c| is_ident_continue(c) || c == '-' || c == '_');
			let ident = &body[ident_start..s.pos];

			let mut look = Scanner::new(&body[s.pos..]);
			look.skip_inline_whitespace();
			if look.starts_with(":") {
				out.push(ident_start..s.pos, Token::Attribute);
				continue;
			}

			if is_yaml_constant(ident) {
				out.push(ident_start..s.pos, Token::Constant);
				continue;
			}
			s.pos = ident_start;
		}

		if let Some(num_range) = scan_number_literal(&mut s) {
			out.push(num_range, Token::Number);
			continue;
		}

		s.bump();
	}
}

fn is_yaml_constant(s: &str) -> bool {
	matches!(
		s.to_ascii_lowercase().as_str(),
		"true" | "false" | "null" | "~" | "yes" | "no" | "on" | "off"
	)
}
