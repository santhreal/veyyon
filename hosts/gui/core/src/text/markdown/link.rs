//! Links, images and bare URLs.

pub(super) fn parse_link_or_image(text: &str) -> Option<(String, String, usize)> {
	if !text.starts_with('[') {
		return None;
	}

	let mut depth = 0;
	let mut close_bracket = None;
	let mut escaped = false;

	for (idx, ch) in text.char_indices() {
		if escaped {
			escaped = false;
			continue;
		}
		if ch == '\\' {
			escaped = true;
			continue;
		}
		if ch == '[' {
			depth += 1;
		} else if ch == ']' {
			depth -= 1;
			if depth == 0 {
				close_bracket = Some(idx);
				break;
			}
		}
	}

	let close_bracket = close_bracket?;
	let after_bracket = &text[close_bracket + 1..];
	if !after_bracket.starts_with('(') {
		return None;
	}

	let paren_content_start = close_bracket + 2;
	let mut paren_depth = 1;
	let mut close_paren = None;
	escaped = false;

	for (idx, ch) in text[paren_content_start..].char_indices() {
		let abs_idx = paren_content_start + idx;
		if escaped {
			escaped = false;
			continue;
		}
		if ch == '\\' {
			escaped = true;
			continue;
		}
		if ch == '(' {
			if paren_depth < 2 {
				paren_depth += 1;
			}
		} else if ch == ')' {
			paren_depth -= 1;
			if paren_depth == 0 {
				close_paren = Some(abs_idx);
				break;
			}
		}
	}

	let close_paren = close_paren?;
	let link_text = text[1..close_bracket].to_string();
	let href = text[paren_content_start..close_paren].trim().to_string();
	Some((link_text, href, close_paren + 1))
}

pub(super) fn parse_bare_url(text: &str) -> (&str, usize) {
	let mut end = 0;
	for (idx, ch) in text.char_indices() {
		if ch.is_whitespace() {
			break;
		}
		end = idx + ch.len_utf8();
	}

	let mut url = &text[..end];
	while url.ends_with(['.', ',', ';', ':', ')', ']']) {
		url = &url[..url.len() - 1];
	}

	if url == "http://" || url == "https://" {
		("", 0)
	} else {
		(url, url.len())
	}
}
