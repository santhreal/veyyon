//! POSIX shell. The first word of a command, variables in three spellings,
//! flags, single and double quotes, and comments that start mid-line.

use super::{
	Token,
	scan::{Scanner, SpanCollector, is_ident_continue, is_ident_start, scan_number_literal},
};

pub(super) fn scan_shell(body: &str, out: &mut SpanCollector) {
	let mut s = Scanner::new(body);
	let mut at_command_pos = true;

	while !s.is_eof() {
		let start = s.pos;

		if s.starts_with("#") {
			s.eat_while(|c| c != '\n');
			out.push(start..s.pos, Token::Comment);
			at_command_pos = true;
			continue;
		}

		if s.starts_with("'") {
			s.advance(1);
			while !s.is_eof() {
				if s.starts_with("'") {
					s.advance(1);
					break;
				}
				s.bump();
			}
			out.push(start..s.pos, Token::Str);
			at_command_pos = false;
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
				} else {
					s.bump();
				}
			}
			out.push(start..s.pos, Token::Str);
			at_command_pos = false;
			continue;
		}

		if s.starts_with("$") {
			s.advance(1);
			if s.starts_with("{") {
				s.advance(1);
				s.eat_while(|c| c != '}' && c != '\n');
				if s.starts_with("}") {
					s.advance(1);
				}
				out.push(start..s.pos, Token::Constant);
				at_command_pos = false;
				continue;
			} else if s.starts_with("(") {
				s.advance(1);
				let mut depth = 1usize;
				while !s.is_eof() && depth > 0 {
					if s.starts_with("(") {
						depth += 1;
						s.advance(1);
					} else if s.starts_with(")") {
						depth -= 1;
						s.advance(1);
					} else {
						s.bump();
					}
				}
				out.push(start..s.pos, Token::Constant);
				at_command_pos = false;
				continue;
			} else if let Some(c) = s.peek()
				&& (is_ident_start(c) || "?$#*@!0123456789".contains(c))
			{
				s.bump();
				s.eat_while(is_ident_continue);
				out.push(start..s.pos, Token::Constant);
				at_command_pos = false;
				continue;
			}
		}

		if s.starts_with("-") {
			let rest = &s.rest()[1..];
			if rest.starts_with(|c: char| c.is_alphabetic() || c == '-') {
				s.advance(1);
				s.eat_while(|c| is_ident_continue(c) || c == '-' || c == '=');
				out.push(start..s.pos, Token::Attribute);
				at_command_pos = false;
				continue;
			}
		}

		if let Some(num_range) = scan_number_literal(&mut s) {
			out.push(num_range, Token::Number);
			at_command_pos = false;
			continue;
		}

		if let Some(c) = s.peek()
			&& is_ident_start(c)
		{
			s.eat_while(is_ident_continue);
			let ident = &body[start..s.pos];

			if is_shell_keyword(ident) {
				out.push(start..s.pos, Token::Keyword);
				at_command_pos =
					matches!(ident, "then" | "do" | "else" | "elif" | "if" | "while" | "until");
				continue;
			} else if at_command_pos {
				out.push(start..s.pos, Token::Function);
				at_command_pos = false;
				continue;
			}

			s.bump();
			continue;
		}

		if let Some(c) = s.peek() {
			if c == '\n' || c == ';' || c == '|' || c == '&' || c == '(' || c == ')' {
				at_command_pos = true;
			} else if !c.is_whitespace() {
				at_command_pos = false;
			}
		}

		s.bump();
	}
}

fn is_shell_keyword(s: &str) -> bool {
	matches!(
		s,
		"if"
			| "then"
			| "else"
			| "elif"
			| "fi" | "for"
			| "while"
			| "until"
			| "do" | "done"
			| "case"
			| "esac"
			| "function"
			| "in" | "return"
			| "local"
			| "export"
			| "set"
			| "unset"
			| "readonly"
			| "shift"
			| "exit"
			| "select"
			| "time"
			| "eval"
			| "exec"
	)
}
