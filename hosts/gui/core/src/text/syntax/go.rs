//! Go. Keywords, builtin types, raw strings in backticks and rune literals.

use super::{
	Token,
	scan::{Scanner, SpanCollector, is_ident_continue, is_ident_start, scan_number_literal},
};

pub(super) fn scan_go(body: &str, out: &mut SpanCollector) {
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
			while !s.is_eof() {
				if s.starts_with("*/") {
					s.advance(2);
					break;
				}
				s.bump();
			}
			out.push(start..s.pos, Token::Comment);
			continue;
		}

		if s.starts_with("\"") {
			s.advance(1);
			while !s.is_eof() {
				if s.starts_with("\\") {
					s.advance(2.min(s.rest().len()));
				} else if s.starts_with("\"") {
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

		if s.starts_with("`") {
			s.advance(1);
			while !s.is_eof() {
				if s.starts_with("`") {
					s.advance(1);
					break;
				}
				s.bump();
			}
			out.push(start..s.pos, Token::Str);
			continue;
		}

		if s.starts_with("'") {
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

		if let Some(num_range) = scan_number_literal(&mut s) {
			out.push(num_range, Token::Number);
			continue;
		}

		if let Some(c) = s.peek()
			&& is_ident_start(c)
		{
			s.eat_while(is_ident_continue);
			let ident = &body[start..s.pos];

			let after = s.rest().trim_start();
			let is_call = after.starts_with('(');

			let token = if is_go_keyword(ident) {
				Token::Keyword
			} else if is_go_builtin_type(ident) {
				Token::Type
			} else if is_go_constant(ident) {
				Token::Constant
			} else if is_call {
				Token::Function
			} else {
				s.bump();
				continue;
			};

			out.push(start..s.pos, token);
			continue;
		}

		s.bump();
	}
}

fn is_go_keyword(s: &str) -> bool {
	matches!(
		s,
		"break"
			| "case"
			| "chan"
			| "const"
			| "continue"
			| "default"
			| "defer"
			| "else"
			| "fallthrough"
			| "for"
			| "func"
			| "go" | "goto"
			| "if" | "import"
			| "interface"
			| "map"
			| "package"
			| "range"
			| "return"
			| "select"
			| "struct"
			| "switch"
			| "type"
			| "var"
	)
}

fn is_go_builtin_type(s: &str) -> bool {
	matches!(
		s,
		"int"
			| "int8"
			| "int16"
			| "int32"
			| "int64"
			| "uint"
			| "uint8"
			| "uint16"
			| "uint32"
			| "uint64"
			| "uintptr"
			| "float32"
			| "float64"
			| "complex64"
			| "complex128"
			| "string"
			| "error"
			| "bool"
			| "byte"
			| "rune"
			| "any"
			| "comparable"
	)
}

fn is_go_constant(s: &str) -> bool {
	matches!(s, "nil" | "true" | "false" | "iota")
}
