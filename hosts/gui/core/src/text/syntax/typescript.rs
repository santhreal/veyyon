//! TypeScript and JavaScript, including JSX bodies, template literals with
//! nested interpolation, and the regex-versus-division ambiguity.

use super::{
	Token,
	scan::{Scanner, SpanCollector, is_ident_continue, is_ident_start, scan_number_literal},
};

pub(super) fn scan_typescript(body: &str, out: &mut SpanCollector) {
	let mut s = Scanner::new(body);
	let mut prev_token_kind = "";

	while !s.is_eof() {
		let start = s.pos;

		if s.starts_with("//") {
			s.eat_while(|c| c != '\n');
			out.push(start..s.pos, Token::Comment);
			prev_token_kind = "comment";
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
			prev_token_kind = "comment";
			continue;
		}

		if s.starts_with("`") {
			s.advance(1);
			scan_ts_template_body(&mut s, out, start);
			prev_token_kind = "str";
			continue;
		}

		if s.starts_with("\"") || s.starts_with("'") {
			let quote = s.bump().unwrap_or('"');
			while !s.is_eof() {
				if s.starts_with("\\") {
					s.advance(2.min(s.rest().len()));
				} else if s.peek() == Some(quote) {
					s.bump();
					break;
				} else if s.starts_with("\n") {
					break;
				} else {
					s.bump();
				}
			}
			out.push(start..s.pos, Token::Str);
			prev_token_kind = "str";
			continue;
		}

		if s.starts_with("/") && !s.starts_with("//") && !s.starts_with("/*") {
			let is_regex_context = matches!(
				prev_token_kind,
				"" | "punct" | "kw_return" | "kw_yield" | "kw_await" | "kw_throw" | "kw_case"
			);
			if is_regex_context {
				s.advance(1);
				let mut in_class = false;
				while !s.is_eof() {
					if s.starts_with("\\") {
						s.advance(2.min(s.rest().len()));
					} else if s.starts_with("[") {
						in_class = true;
						s.advance(1);
					} else if s.starts_with("]") && in_class {
						in_class = false;
						s.advance(1);
					} else if s.starts_with("/") && !in_class {
						s.advance(1);
						s.eat_while(|c| c.is_alphabetic());
						break;
					} else if s.starts_with("\n") {
						break;
					} else {
						s.bump();
					}
				}
				out.push(start..s.pos, Token::Str);
				prev_token_kind = "str";
				continue;
			}
		}

		if s.starts_with("@") {
			s.advance(1);
			let ident_len = s.eat_while(|c| is_ident_continue(c) || c == '$');
			if ident_len > 0 {
				out.push(start..s.pos, Token::Attribute);
				prev_token_kind = "attr";
				continue;
			}
		}

		if let Some(num_range) = scan_number_literal(&mut s) {
			out.push(num_range, Token::Number);
			prev_token_kind = "num";
			continue;
		}

		if let Some(c) = s.peek()
			&& (is_ident_start(c) || c == '$')
		{
			s.eat_while(|c| is_ident_continue(c) || c == '$');
			let ident = &body[start..s.pos];

			let after = s.rest().trim_start();
			let is_call = after.starts_with('(');

			let token = if is_call && !is_ts_keyword(ident) {
				Token::Function
			} else if is_ts_keyword(ident) {
				Token::Keyword
			} else if is_ts_constant(ident) {
				Token::Constant
			} else if is_ts_builtin_type(ident) || ident.starts_with(|c: char| c.is_uppercase()) {
				Token::Type
			} else {
				prev_token_kind = "ident";
				s.bump();
				continue;
			};

			if ident == "return" {
				prev_token_kind = "kw_return";
			} else if ident == "yield" {
				prev_token_kind = "kw_yield";
			} else if ident == "await" {
				prev_token_kind = "kw_await";
			} else if ident == "throw" {
				prev_token_kind = "kw_throw";
			} else if ident == "case" {
				prev_token_kind = "kw_case";
			} else {
				prev_token_kind = match token {
					Token::Keyword => "kw",
					Token::Constant => "const",
					Token::Type => "type",
					Token::Function => "func",
					_ => "other",
				};
			}

			out.push(start..s.pos, token);
			continue;
		}

		if let Some(c) = s.peek() {
			if "=([{:!&|?+-*,;".contains(c) {
				prev_token_kind = "punct";
			} else if !c.is_whitespace() {
				prev_token_kind = "other";
			}
		}

		s.bump();
	}
}

fn scan_ts_template_body(s: &mut Scanner, out: &mut SpanCollector, seg_start: usize) {
	while !s.is_eof() {
		if s.starts_with("\\") {
			s.advance(2.min(s.rest().len()));
		} else if s.starts_with("${") {
			let str_end = s.pos;
			out.push(seg_start..str_end, Token::Str);
			s.advance(2);
			out.push(str_end..s.pos, Token::Punct);

			let mut brace_depth = 1usize;
			while !s.is_eof() && brace_depth > 0 {
				let expr_start = s.pos;
				if s.starts_with("{") {
					brace_depth += 1;
					s.advance(1);
				} else if s.starts_with("}") {
					brace_depth -= 1;
					if brace_depth == 0 {
						out.push(s.pos..s.pos + 1, Token::Punct);
						s.advance(1);
						break;
					}
					s.advance(1);
				} else if s.starts_with("\"") || s.starts_with("'") {
					let q = s.bump().unwrap_or('"');
					while !s.is_eof() {
						if s.starts_with("\\") {
							s.advance(2.min(s.rest().len()));
						} else if s.peek() == Some(q) {
							s.bump();
							break;
						} else {
							s.bump();
						}
					}
					out.push(expr_start..s.pos, Token::Str);
				} else if let Some(num_r) = scan_number_literal(s) {
					out.push(num_r, Token::Number);
				} else if let Some(c) = s.peek() {
					if is_ident_start(c) || c == '$' {
						s.eat_while(|c| is_ident_continue(c) || c == '$');
						let id = &s.source[expr_start..s.pos];
						if is_ts_keyword(id) {
							out.push(expr_start..s.pos, Token::Keyword);
						} else if is_ts_constant(id) {
							out.push(expr_start..s.pos, Token::Constant);
						} else if is_ts_builtin_type(id) || id.starts_with(|c: char| c.is_uppercase()) {
							out.push(expr_start..s.pos, Token::Type);
						} else if s.rest().trim_start().starts_with('(') {
							out.push(expr_start..s.pos, Token::Function);
						}
					} else {
						s.bump();
					}
				} else {
					s.bump();
				}
			}
			let next_seg = s.pos;
			scan_ts_template_body(s, out, next_seg);
			return;
		} else if s.starts_with("`") {
			s.advance(1);
			out.push(seg_start..s.pos, Token::Str);
			return;
		} else {
			s.bump();
		}
	}
	out.push(seg_start..s.pos, Token::Str);
}

fn is_ts_keyword(s: &str) -> bool {
	matches!(
		s,
		"abstract"
			| "as" | "async"
			| "await"
			| "break"
			| "case"
			| "catch"
			| "class"
			| "const"
			| "continue"
			| "debugger"
			| "declare"
			| "default"
			| "delete"
			| "do" | "else"
			| "enum"
			| "export"
			| "extends"
			| "finally"
			| "for"
			| "from"
			| "function"
			| "get"
			| "if" | "implements"
			| "import"
			| "in" | "instanceof"
			| "interface"
			| "let"
			| "module"
			| "namespace"
			| "new"
			| "of" | "override"
			| "readonly"
			| "return"
			| "satisfies"
			| "set"
			| "static"
			| "super"
			| "switch"
			| "this"
			| "throw"
			| "try"
			| "type"
			| "typeof"
			| "var"
			| "void"
			| "while"
			| "with"
			| "yield"
	)
}

fn is_ts_constant(s: &str) -> bool {
	matches!(s, "true" | "false" | "null" | "undefined" | "NaN" | "Infinity")
}

fn is_ts_builtin_type(s: &str) -> bool {
	matches!(
		s,
		"any"
			| "boolean"
			| "number"
			| "string"
			| "symbol"
			| "unknown"
			| "never"
			| "void"
			| "bigint"
			| "object"
	)
}
