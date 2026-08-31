//! Inline delimiter scanner for half-streamed markdown spans.

use super::mend::{PENDING_LINK_URL, RepairKind};

struct OpenDelim {
	ch:  char,
	len: usize,
	pos: usize,
}

/// Mends unclosed inline delimiters (code, strong, emphasis, links).
pub(super) fn mend_inline(text: &str) -> (String, Vec<RepairKind>) {
	let cs: Vec<(usize, char)> = text.char_indices().collect();
	let n = cs.len();
	let at = |i: usize| cs.get(i).map(|&(_, c)| c);

	let mut delims: Vec<OpenDelim> = Vec::new();
	let mut brackets: Vec<usize> = Vec::new();
	let mut code: Option<(usize, usize)> = None;
	let mut last_content: Option<usize> = None;
	let mut pending_url: Option<usize> = None;

	let mut i = 0;
	while i < n {
		let c = cs[i].1;
		if code.is_none() && c == '\\' {
			if i + 1 < n {
				last_content = Some(i + 1);
			}
			i += 2;
			continue;
		}
		if c == '`' {
			let run = run_len(&cs, i);
			match code {
				Some((open, _)) if run == open => code = None,
				Some(_) => last_content = Some(i + run - 1),
				None => code = Some((run, i + run)),
			}
			i += run;
			continue;
		}
		if code.is_some() {
			last_content = Some(i);
			i += 1;
			continue;
		}
		match c {
			'*' | '_' => {
				let run = run_len(&cs, i);
				scan_delim(&mut delims, &cs, c, run, i, &mut last_content);
				i += run;
			},
			'[' => {
				brackets.push(i);
				i += 1;
			},
			']' => {
				if let Some(open) = brackets.pop() {
					delims.retain(|d| d.pos < open);
					if at(i + 1) == Some('(') {
						let mut j = i + 2;
						let mut depth = 0usize;
						loop {
							match at(j) {
								Some('(') => depth += 1,
								Some(')') if depth == 0 => break,
								Some(')') => depth -= 1,
								Some(_) => {},
								None => {
									pending_url = Some(i);
									break;
								},
							}
							j += 1;
						}
						if pending_url.is_some() {
							break;
						}
						last_content = Some(j);
						i = j + 1;
						continue;
					}
				}
				last_content = Some(i);
				i += 1;
			},
			c if c.is_whitespace() => i += 1,
			_ => {
				last_content = Some(i);
				i += 1;
			},
		}
	}

	let mut suffix = String::new();
	let mut repairs = Vec::new();

	if pending_url.is_some() {
		suffix.push(')');
		repairs.push(RepairKind::Link);
		return (suffix, repairs);
	}

	let mut pending: Vec<(usize, String, RepairKind)> = Vec::new();
	if let Some((ticks, cpos)) = code
		&& last_content.is_some_and(|lc| lc >= cpos)
	{
		pending.push((cpos, "`".repeat(ticks), RepairKind::InlineCode));
	}
	for d in &delims {
		if last_content.is_some_and(|lc| lc >= d.pos) {
			let kind = if d.len >= 2 {
				RepairKind::Strong
			} else {
				RepairKind::Emphasis
			};
			pending.push((d.pos, d.ch.to_string().repeat(d.len), kind));
		}
	}
	if let Some(&open) = brackets.last()
		&& last_content.is_some_and(|lc| lc > open)
	{
		pending.push((open, format!("]({PENDING_LINK_URL})"), RepairKind::Link));
	}

	pending.sort_by_key(|a| std::cmp::Reverse(a.0));
	for (_, s, r) in pending {
		suffix.push_str(&s);
		repairs.push(r);
	}

	(suffix, repairs)
}

fn run_len(cs: &[(usize, char)], i: usize) -> usize {
	let c = cs[i].1;
	cs[i..].iter().take_while(|&&(_, x)| x == c).count()
}

fn scan_delim(
	delims: &mut Vec<OpenDelim>,
	cs: &[(usize, char)],
	c: char,
	run: usize,
	i: usize,
	last_content: &mut Option<usize>,
) {
	let end = i + run;
	let prev = i.checked_sub(1).map(|p| cs[p].1);
	let next = cs.get(end).map(|&(_, ch)| ch);
	let word = |ch: Option<char>| ch.is_some_and(char::is_alphanumeric);

	if word(prev) && word(next) && (c == '_' || (c == '*' && run == 1)) {
		*last_content = Some(end - 1);
		return;
	}

	let can_close = prev.is_some_and(|ch| !ch.is_whitespace());
	let can_open = next.is_some_and(|ch| !ch.is_whitespace());
	let mut rest = run;

	if can_close && let Some(k) = delims.iter().rposition(|d| d.ch == c) {
		let take = rest.min(delims[k].len);
		delims[k].len -= take;
		rest -= take;
		let keep = if delims[k].len == 0 { k } else { k + 1 };
		delims.truncate(keep);
	}

	if rest > 0 {
		if can_open {
			delims.push(OpenDelim { ch: c, len: rest, pos: end });
		} else {
			*last_content = Some(end - 1);
		}
	}
}
