//! Inline spans: the runs inside one block.

use super::{
	Span,
	emphasis::{
		find_closing_marker, find_closing_single_underscore, find_closing_star,
		find_closing_underscore_run,
	},
	link::{parse_bare_url, parse_link_or_image},
};

/// Split one line into inline spans.
pub fn inline(text: &str) -> Vec<Span> {
	let mut spans = Vec::new();
	let mut pos = 0;
	let bytes = text.as_bytes();
	let len = bytes.len();

	while pos < len {
		if bytes[pos] == b'\\' {
			if pos + 1 < len {
				let next_byte = bytes[pos + 1];
				if matches!(
					next_byte,
					b'\\' | b'`' | b'*' | b'_' | b'[' | b']' | b'(' | b')' | b'~' | b'|' | b'#'
				) {
					let esc_char = text[pos + 1..].chars().next().unwrap_or('\\');
					push_plain_char(&mut spans, esc_char);
					pos += 1 + esc_char.len_utf8();
					continue;
				}
			}
			push_plain_char(&mut spans, '\\');
			pos += 1;
			continue;
		}

		if bytes[pos] == b'`' {
			let fence_count = bytes[pos..].iter().take_while(|&&b| b == b'`').count();
			if let Some(close_offset) = find_closing_backticks(&text[pos + fence_count..], fence_count)
			{
				let raw_code = &text[pos + fence_count..pos + fence_count + close_offset];
				let code = strip_code_surrounding_spaces(raw_code);
				push_span(&mut spans, Span::Code(code.to_string()));
				pos += fence_count + close_offset + fence_count;
				continue;
			}
			for _ in 0..fence_count {
				push_plain_char(&mut spans, '`');
			}
			pos += fence_count;
			continue;
		}

		if bytes[pos] == b'!' && pos + 1 < len && bytes[pos + 1] == b'[' {
			if let Some((alt, href, advance)) = parse_link_or_image(&text[pos + 1..]) {
				push_span(&mut spans, Span::Link { text: alt, href });
				pos += 1 + advance;
				continue;
			}
			push_plain_char(&mut spans, '!');
			pos += 1;
			continue;
		}

		if bytes[pos] == b'[' {
			if let Some((link_text, href, advance)) = parse_link_or_image(&text[pos..]) {
				push_span(&mut spans, Span::Link { text: link_text, href });
				pos += advance;
				continue;
			}
			push_plain_char(&mut spans, '[');
			pos += 1;
			continue;
		}

		if text[pos..].starts_with("http://") || text[pos..].starts_with("https://") {
			let (url, advance) = parse_bare_url(&text[pos..]);
			if !url.is_empty() {
				push_span(&mut spans, Span::Link { text: url.to_string(), href: url.to_string() });
				pos += advance;
				continue;
			}
		}

		if bytes[pos] == b'*' {
			let star_count = bytes[pos..].iter().take_while(|&&b| b == b'*').count();
			if star_count >= 3
				&& let Some(close_idx) = find_closing_marker(&text[pos + 3..], "***")
			{
				let content = &text[pos + 3..pos + 3 + close_idx];
				if !content.is_empty() {
					push_span(&mut spans, Span::Strong(content.to_string()));
					pos += 3 + close_idx + 3;
					continue;
				}
			}
			if star_count >= 2
				&& let Some(close_idx) = find_closing_marker(&text[pos + 2..], "**")
			{
				let content = &text[pos + 2..pos + 2 + close_idx];
				if !content.is_empty() {
					push_span(&mut spans, Span::Strong(content.to_string()));
					pos += 2 + close_idx + 2;
					continue;
				}
			}
			if star_count >= 1
				&& let Some(close_idx) = find_closing_star(&text[pos + 1..])
			{
				let content = &text[pos + 1..pos + 1 + close_idx];
				if !content.is_empty() {
					push_span(&mut spans, Span::Emphasis(content.to_string()));
					pos += 1 + close_idx + 1;
					continue;
				}
			}
			push_plain_char(&mut spans, '*');
			pos += 1;
			continue;
		}

		if bytes[pos] == b'_' {
			let prev_char = text[..pos].chars().last();
			let is_inside_word = prev_char.is_some_and(|c| c.is_alphanumeric());

			if !is_inside_word {
				let underscore_count = bytes[pos..].iter().take_while(|&&b| b == b'_').count();
				if underscore_count >= 3
					&& let Some(close_idx) = find_closing_underscore_run(&text[pos + 3..], "___")
				{
					let content = &text[pos + 3..pos + 3 + close_idx];
					if !content.is_empty() {
						push_span(&mut spans, Span::Strong(content.to_string()));
						pos += 3 + close_idx + 3;
						continue;
					}
				}
				if underscore_count >= 2
					&& let Some(close_idx) = find_closing_underscore_run(&text[pos + 2..], "__")
				{
					let content = &text[pos + 2..pos + 2 + close_idx];
					if !content.is_empty() {
						push_span(&mut spans, Span::Strong(content.to_string()));
						pos += 2 + close_idx + 2;
						continue;
					}
				}
				if underscore_count >= 1
					&& let Some(close_idx) = find_closing_single_underscore(&text[pos + 1..])
				{
					let content = &text[pos + 1..pos + 1 + close_idx];
					if !content.is_empty() {
						push_span(&mut spans, Span::Emphasis(content.to_string()));
						pos += 1 + close_idx + 1;
						continue;
					}
				}
			}
			push_plain_char(&mut spans, '_');
			pos += 1;
			continue;
		}

		let cur_char = text[pos..].chars().next().unwrap_or(' ');
		push_plain_char(&mut spans, cur_char);
		pos += cur_char.len_utf8();
	}

	spans
}

/// The plain text of a run of spans, for a preview line or a search.
pub fn flatten(spans: &[Span]) -> String {
	let mut out = String::new();
	for span in spans {
		match span {
			Span::Plain(s) | Span::Strong(s) | Span::Emphasis(s) | Span::Code(s) => {
				out.push_str(s);
			},
			Span::Link { text, .. } => {
				out.push_str(text);
			},
		}
	}
	out
}

fn push_span(spans: &mut Vec<Span>, span: Span) {
	if let Span::Plain(s) = &span {
		if s.is_empty() {
			return;
		}
		if let Some(Span::Plain(last)) = spans.last_mut() {
			last.push_str(s);
			return;
		}
	}
	spans.push(span);
}

fn push_plain_char(spans: &mut Vec<Span>, ch: char) {
	if let Some(Span::Plain(last)) = spans.last_mut() {
		last.push(ch);
	} else {
		spans.push(Span::Plain(ch.to_string()));
	}
}

fn find_closing_backticks(text: &str, count: usize) -> Option<usize> {
	let bytes = text.as_bytes();
	let mut i = 0;
	while i < bytes.len() {
		if bytes[i] == b'`' {
			let run = bytes[i..].iter().take_while(|&&b| b == b'`').count();
			if run == count {
				return Some(i);
			}
			i += run;
		} else {
			i += 1;
		}
	}
	None
}

fn strip_code_surrounding_spaces(code: &str) -> &str {
	if code.len() >= 2 && code.starts_with(' ') && code.ends_with(' ') {
		&code[1..code.len() - 1]
	} else {
		code
	}
}
