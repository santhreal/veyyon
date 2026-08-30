//! C and C++. Preprocessor directives, keywords, builtin and library types,
//! and character literals.

use super::{
	Token,
	scan::{Scanner, SpanCollector, is_ident_continue, is_ident_start, scan_number_literal},
};

pub(super) fn scan_c(body: &str, out: &mut SpanCollector) {
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

		if s.starts_with("#") {
			s.advance(1);
			s.skip_inline_whitespace();
			let dir_start = s.pos;
			s.eat_while(|c| c.is_alphabetic());
			let directive = &body[dir_start..s.pos];
			if is_c_preprocessor(directive) {
				s.eat_while(|c| c != '\n');
				out.push(start..s.pos, Token::Attribute);
				continue;
			}
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

			let token = if is_c_keyword(ident) {
				Token::Keyword
			} else if is_c_constant(ident) {
				Token::Constant
			} else if is_c_type(ident) {
				Token::Type
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

fn is_c_preprocessor(s: &str) -> bool {
	matches!(
		s,
		"include"
			| "define"
			| "undef"
			| "ifdef"
			| "ifndef"
			| "if" | "elif"
			| "else"
			| "endif"
			| "pragma"
			| "error"
			| "warning"
			| "line"
	)
}

fn is_c_keyword(s: &str) -> bool {
	matches!(
		s,
		"auto"
			| "break"
			| "case"
			| "char"
			| "const"
			| "continue"
			| "default"
			| "do" | "double"
			| "else"
			| "enum"
			| "extern"
			| "float"
			| "for"
			| "goto"
			| "if" | "inline"
			| "int"
			| "long"
			| "register"
			| "restrict"
			| "return"
			| "short"
			| "signed"
			| "sizeof"
			| "static"
			| "struct"
			| "switch"
			| "typedef"
			| "union"
			| "unsigned"
			| "void"
			| "volatile"
			| "while"
			| "_Alignas"
			| "_Alignof"
			| "_Atomic"
			| "_Bool"
			| "_Complex"
			| "_Generic"
			| "_Imaginary"
			| "_Noreturn"
			| "_Static_assert"
			| "_Thread_local"
			| "class"
			| "namespace"
			| "public"
			| "private"
			| "protected"
			| "template"
			| "typename"
			| "virtual"
			| "override"
			| "constexpr"
			| "decltype"
			| "noexcept"
			| "new"
			| "delete"
			| "this"
			| "throw"
			| "try"
			| "catch"
			| "using"
			| "concept"
			| "requires"
	)
}

fn is_c_constant(s: &str) -> bool {
	matches!(s, "NULL" | "true" | "false" | "nullptr")
}

fn is_c_type(s: &str) -> bool {
	if s.starts_with("t_") || s.ends_with("_t") {
		return true;
	}
	if s.starts_with(|c: char| c.is_uppercase()) && s.len() > 1 {
		return true;
	}
	matches!(
		s,
		"size_t"
			| "ssize_t"
			| "int8_t"
			| "uint8_t"
			| "int16_t"
			| "uint16_t"
			| "int32_t"
			| "uint32_t"
			| "int64_t"
			| "uint64_t"
			| "intptr_t"
			| "uintptr_t"
			| "ptrdiff_t"
			| "FILE"
			| "bool"
			| "char16_t"
			| "char32_t"
			| "wchar_t"
	)
}
