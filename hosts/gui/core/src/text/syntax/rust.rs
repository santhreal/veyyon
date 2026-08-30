//! Rust. Keywords, primitive types, lifetimes, attributes, nested block
//! comments, raw and byte strings, and character literals.

use super::{
	Token,
	scan::{
		Scanner, SpanCollector, is_ident_continue, is_ident_start, is_screaming_case,
		scan_number_literal,
	},
};

pub(super) fn scan_rust(body: &str, out: &mut SpanCollector) {
	let mut s = Scanner::new(body);

	while !s.is_eof() {
		let start = s.pos;

		if s.starts_with("//") {
			s.eat_while(|c| c != '\n');
			out.push(start..s.pos, Token::Comment);
			continue;
		}

		if s.starts_with("/*") {
			s.advance(2);
			let mut depth = 1usize;
			while !s.is_eof() && depth > 0 {
				if s.starts_with("/*") {
					depth += 1;
					s.advance(2);
				} else if s.starts_with("*/") {
					depth -= 1;
					s.advance(2);
				} else {
					s.bump();
				}
			}
			out.push(start..s.pos, Token::Comment);
			continue;
		}

		if s.starts_with("#[") || s.starts_with("#![") {
			let prefix_len = if s.starts_with("#![") { 3 } else { 2 };
			s.advance(prefix_len);
			let mut bracket_depth = 1usize;
			while !s.is_eof() && bracket_depth > 0 {
				if s.starts_with("[") {
					bracket_depth += 1;
					s.advance(1);
				} else if s.starts_with("]") {
					bracket_depth -= 1;
					s.advance(1);
				} else if s.starts_with("\"") {
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
				} else {
					s.bump();
				}
			}
			out.push(start..s.pos, Token::Attribute);
			continue;
		}

		if s.starts_with("r#\"")
			|| s.starts_with("r\"")
			|| s.starts_with("br#\"")
			|| s.starts_with("br\"")
			|| s.starts_with("cr#\"")
			|| s.starts_with("cr\"")
		{
			let offset = if s.starts_with("br") || s.starts_with("cr") {
				2
			} else {
				1
			};
			s.advance(offset);
			let hashes = s.eat_while(|c| c == '#');
			if s.starts_with("\"") {
				s.advance(1);
				let mut close_pat = String::with_capacity(hashes + 1);
				close_pat.push('"');
				for _ in 0..hashes {
					close_pat.push('#');
				}
				while !s.is_eof() {
					if s.starts_with(&close_pat) {
						s.advance(close_pat.len());
						break;
					}
					s.bump();
				}
				out.push(start..s.pos, Token::Str);
				continue;
			}
		}

		if s.starts_with("\"") || s.starts_with("b\"") || s.starts_with("c\"") {
			if s.starts_with("b\"") || s.starts_with("c\"") {
				s.advance(1);
			}
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
			out.push(start..s.pos, Token::Str);
			continue;
		}

		if s.starts_with("b'") {
			s.advance(2);
			while !s.is_eof() {
				if s.starts_with("\\") {
					s.advance(2.min(s.rest().len()));
				} else if s.starts_with("'") {
					s.advance(1);
					break;
				} else if s.starts_with("\n") {
					break;
				} else {
					s.bump();
				}
			}
			out.push(start..s.pos, Token::Str);
			continue;
		}

		if s.starts_with("'") {
			let rest = s.rest();
			let chars: Vec<char> = rest.chars().take(6).collect();
			// A lifetime and a character literal open the same way. The quote is a
			// literal only when a closing quote follows within the four characters
			// an escape can take.
			let plain = chars.len() >= 3 && chars[1] != '\\' && chars[2] == '\'';
			let escaped = chars.len() >= 4 && chars[1] == '\\' && chars[3] == '\'';
			let is_char_lit = if plain || escaped {
				true
			} else if chars.len() >= 3 && chars[1] == '\\' {
				chars.iter().skip(2).any(|&c| c == '\'')
			} else {
				false
			};

			if is_char_lit {
				s.advance(1);
				while !s.is_eof() {
					if s.starts_with("\\") {
						s.advance(2.min(s.rest().len()));
					} else if s.starts_with("'") {
						s.advance(1);
						break;
					} else if s.starts_with("\n") {
						break;
					} else {
						s.bump();
					}
				}
				out.push(start..s.pos, Token::Str);
				continue;
			}

			s.advance(1);
			let ident_len = s.eat_while(is_ident_continue);
			if ident_len > 0 {
				out.push(start..s.pos, Token::Type);
				continue;
			}
			continue;
		}

		if let Some(num_range) = scan_number_literal(&mut s) {
			out.push(num_range, Token::Number);
			continue;
		}

		let is_raw_kw = s.starts_with("r#");
		if is_raw_kw {
			s.advance(2);
		}

		if let Some(c) = s.peek()
			&& is_ident_start(c)
		{
			let ident_start = if is_raw_kw { start } else { s.pos };
			s.eat_while(is_ident_continue);
			let ident = &body[if is_raw_kw { start + 2 } else { ident_start }..s.pos];

			if s.starts_with("!") && !s.starts_with("!=") {
				s.advance(1);
				out.push(ident_start..s.pos, Token::Function);
				continue;
			}

			let after = s.rest().trim_start();
			let is_call = after.starts_with('(') || after.starts_with("::<");

			let token = if is_call && !is_rust_keyword(ident) {
				Token::Function
			} else if is_rust_keyword(ident) {
				Token::Keyword
			} else if is_rust_primitive_type(ident) {
				Token::Type
			} else if ident == "true" || ident == "false" || is_screaming_case(ident) {
				Token::Constant
			} else if ident.starts_with(|c: char| c.is_uppercase()) {
				Token::Type
			} else {
				s.bump();
				continue;
			};

			out.push(ident_start..s.pos, token);
			continue;
		}

		s.bump();
	}
}

fn is_rust_keyword(s: &str) -> bool {
	matches!(
		s,
		"as"
			| "async"
			| "await"
			| "break"
			| "const"
			| "continue"
			| "crate"
			| "dyn"
			| "else"
			| "enum"
			| "extern"
			| "fn" | "for"
			| "if" | "impl"
			| "in" | "let"
			| "loop"
			| "match"
			| "mod"
			| "move"
			| "mut"
			| "pub"
			| "ref"
			| "return"
			| "self"
			| "static"
			| "struct"
			| "super"
			| "trait"
			| "type"
			| "unsafe"
			| "use"
			| "where"
			| "while"
			| "yield"
			| "try"
	)
}

fn is_rust_primitive_type(s: &str) -> bool {
	matches!(
		s,
		"bool"
			| "char"
			| "str"
			| "u8" | "u16"
			| "u32"
			| "u64"
			| "u128"
			| "usize"
			| "i8" | "i16"
			| "i32"
			| "i64"
			| "i128"
			| "isize"
			| "f32"
			| "f64"
			| "Self"
	)
}
