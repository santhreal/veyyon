//! Where an emphasis run closes. Underscores and stars differ: a star pairs
//! anywhere, an underscore only at a word boundary, which is what keeps
//! `snake_case_names` out of italics.

pub(super) fn find_closing_marker(text: &str, marker: &str) -> Option<usize> {
	let mut escaped = false;
	let marker_bytes = marker.as_bytes();
	let text_bytes = text.as_bytes();

	let mut i = 0;
	while i < text_bytes.len() {
		if escaped {
			escaped = false;
			i += 1;
			continue;
		}
		if text_bytes[i] == b'\\' {
			escaped = true;
			i += 1;
			continue;
		}
		if text_bytes[i..].starts_with(marker_bytes) {
			return Some(i);
		}
		i += 1;
	}
	None
}

pub(super) fn find_closing_star(text: &str) -> Option<usize> {
	let mut escaped = false;
	let text_bytes = text.as_bytes();

	let mut i = 0;
	while i < text_bytes.len() {
		if escaped {
			escaped = false;
			i += 1;
			continue;
		}
		if text_bytes[i] == b'\\' {
			escaped = true;
			i += 1;
			continue;
		}
		if text_bytes[i] == b'*' {
			let is_double = i + 1 < text_bytes.len() && text_bytes[i + 1] == b'*';
			if !is_double {
				return Some(i);
			}
		}
		i += 1;
	}
	None
}

pub(super) fn find_closing_underscore_run(text: &str, marker: &str) -> Option<usize> {
	let mut escaped = false;
	let marker_bytes = marker.as_bytes();
	let text_bytes = text.as_bytes();

	let mut i = 0;
	while i < text_bytes.len() {
		if escaped {
			escaped = false;
			i += 1;
			continue;
		}
		if text_bytes[i] == b'\\' {
			escaped = true;
			i += 1;
			continue;
		}
		if text_bytes[i..].starts_with(marker_bytes) {
			let after_marker = i + marker_bytes.len();
			let next_char = text[after_marker..].chars().next();
			if !next_char.is_some_and(|c| c.is_alphanumeric()) {
				return Some(i);
			}
		}
		i += 1;
	}
	None
}

pub(super) fn find_closing_single_underscore(text: &str) -> Option<usize> {
	let mut escaped = false;
	let text_bytes = text.as_bytes();

	let mut i = 0;
	while i < text_bytes.len() {
		if escaped {
			escaped = false;
			i += 1;
			continue;
		}
		if text_bytes[i] == b'\\' {
			escaped = true;
			i += 1;
			continue;
		}
		if text_bytes[i] == b'_' {
			let is_double = i + 1 < text_bytes.len() && text_bytes[i + 1] == b'_';
			if !is_double {
				let after_marker = i + 1;
				let next_char = text[after_marker..].chars().next();
				if !next_char.is_some_and(|c| c.is_alphanumeric()) {
					return Some(i);
				}
			}
		}
		i += 1;
	}
	None
}
