//! A diff body shown as code. This colours the lines of a patch; parsing a
//! patch into files and hunks is `text::diff`, which is a different job.

use super::{
	Token,
	scan::{Scanner, SpanCollector},
};

pub(super) fn scan_diff(body: &str, out: &mut SpanCollector) {
	let mut s = Scanner::new(body);

	while !s.is_eof() {
		let line_start = s.pos;
		s.eat_while(|c| c != '\n');
		let line_end = s.pos;
		let line = &body[line_start..line_end];

		if line.starts_with("+++") || line.starts_with("---") {
			out.push(line_start..line_end, Token::Comment);
		} else if line.starts_with('+') {
			out.push(line_start..line_end, Token::Function);
		} else if line.starts_with('-') {
			out.push(line_start..line_end, Token::Keyword);
		} else if line.starts_with("@@") {
			out.push(line_start..line_end, Token::Attribute);
		} else if line.starts_with("diff ")
			|| line.starts_with("index ")
			|| line.starts_with("commit ")
			|| line.starts_with("Author: ")
			|| line.starts_with("Date: ")
		{
			out.push(line_start..line_end, Token::Comment);
		}

		if s.starts_with("\n") {
			s.advance(1);
		}
	}
}
