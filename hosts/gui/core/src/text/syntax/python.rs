//! Python. Decorators, triple-quoted strings, f-string prefixes and the
//! constants a reader expects to see coloured as constants.

use super::{
	Token,
	scan::{Scanner, SpanCollector, is_ident_continue, is_ident_start, scan_number_literal},
};

pub(super) fn scan_python(body: &str, out: &mut SpanCollector) {
	let mut s = Scanner::new(body);
	let mut prev_word = "";

	while !s.is_eof() {
		let start = s.pos;

		if s.starts_with("#") {
			s.eat_while(|c| c != '\n');
			out.push(start..s.pos, Token::Comment);
			prev_word = "";
			continue;
		}

		if s.starts_with("@") {
			s.advance(1);
			let ident_len = s.eat_while(|c| is_ident_continue(c) || c == '.');
			if ident_len > 0 {
				out.push(start..s.pos, Token::Attribute);
				prev_word = "";
				continue;
			}
		}

		let rest = s.rest();
		let mut prefix_len = 0;
		if rest.starts_with("f")
			|| rest.starts_with("r")
			|| rest.starts_with("b")
			|| rest.starts_with("u")
			|| rest.starts_with("F")
			|| rest.starts_with("R")
			|| rest.starts_with("B")
			|| rest.starts_with("U")
		{
			prefix_len = 1;
			let two = &rest[..2.min(rest.len())].to_ascii_lowercase();
			if two == "fr" || two == "rf" || two == "br" || two == "rb" {
				prefix_len = 2;
			}
		}

		let after_prefix = &rest[prefix_len..];
		if after_prefix.starts_with("\"\"\"")
			|| after_prefix.starts_with("'''")
			|| after_prefix.starts_with("\"")
			|| after_prefix.starts_with("'")
		{
			s.advance(prefix_len);
			let quote_delim = if s.starts_with("\"\"\"") {
				"\"\"\""
			} else if s.starts_with("'''") {
				"'''"
			} else if s.starts_with("\"") {
				"\""
			} else {
				"'"
			};
			s.advance(quote_delim.len());
			while !s.is_eof() {
				if s.starts_with("\\") {
					s.advance(2.min(s.rest().len()));
				} else if s.starts_with(quote_delim) {
					s.advance(quote_delim.len());
					break;
				} else {
					s.bump();
				}
			}
			out.push(start..s.pos, Token::Str);
			prev_word = "";
			continue;
		}

		if let Some(num_range) = scan_number_literal(&mut s) {
			out.push(num_range, Token::Number);
			prev_word = "";
			continue;
		}

		if let Some(c) = s.peek()
			&& is_ident_start(c)
		{
			s.eat_while(is_ident_continue);
			let ident = &body[start..s.pos];

			let after = s.rest().trim_start();
			let is_call = after.starts_with('(');

			let token = if prev_word == "def" {
				Token::Function
			} else if prev_word == "class" {
				Token::Type
			} else if is_py_constant(ident) {
				Token::Constant
			} else if is_py_keyword(ident) {
				Token::Keyword
			} else if is_call {
				Token::Function
			} else if ident.starts_with(|c: char| c.is_uppercase()) {
				Token::Type
			} else {
				prev_word = ident;
				s.bump();
				continue;
			};

			prev_word = ident;
			out.push(start..s.pos, token);
			continue;
		}

		if let Some(c) = s.peek()
			&& !c.is_whitespace()
		{
			prev_word = "";
		}

		s.bump();
	}
}

fn is_py_keyword(s: &str) -> bool {
	matches!(
		s,
		"and"
			| "as" | "assert"
			| "async"
			| "await"
			| "break"
			| "case"
			| "class"
			| "continue"
			| "def"
			| "del"
			| "elif"
			| "else"
			| "except"
			| "finally"
			| "for"
			| "from"
			| "global"
			| "if" | "import"
			| "in" | "is"
			| "lambda"
			| "match"
			| "nonlocal"
			| "not"
			| "or" | "pass"
			| "raise"
			| "return"
			| "try"
			| "while"
			| "with"
			| "yield"
	)
}

fn is_py_constant(s: &str) -> bool {
	matches!(s, "self" | "cls" | "True" | "False" | "None" | "Ellipsis")
}
