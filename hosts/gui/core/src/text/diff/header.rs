//! The header lines around a file: the `diff --git` pair, the `---`/`+++`
//! paths, the binary notice, and the `@@` ranges.

pub(super) fn parse_diff_git_paths(line: &str) -> (Option<String>, Option<String>) {
	let rest = match line.strip_prefix("diff --git ") {
		Some(r) => r.trim_start(),
		None => return (None, None),
	};
	let (old_token, rest_after_first) = extract_git_path_token(rest);
	let (new_token, _) = extract_git_path_token(rest_after_first.trim_start());
	let old_path = old_token.map(|p| strip_git_prefix(&p));
	let new_path = new_token.map(|p| strip_git_prefix(&p));
	(old_path, new_path)
}

fn extract_git_path_token(s: &str) -> (Option<String>, &str) {
	if s.is_empty() {
		return (None, "");
	}
	if let Some(stripped) = s.strip_prefix('"') {
		let mut escaped = false;
		let mut end_idx = None;
		for (idx, ch) in stripped.char_indices() {
			if escaped {
				escaped = false;
			} else if ch == '\\' {
				escaped = true;
			} else if ch == '"' {
				end_idx = Some(idx);
				break;
			}
		}
		if let Some(end) = end_idx
			&& let Some(inside) = stripped.get(..end)
		{
			let unquoted = unescape_c_string(inside);
			let after = stripped.get(end + 1..).unwrap_or("");
			return (Some(unquoted), after);
		}
	}
	if let Some((token, after)) = s.split_once(' ') {
		(Some(token.to_string()), after)
	} else {
		(Some(s.to_string()), "")
	}
}

fn strip_git_prefix(path: &str) -> String {
	if path == "/dev/null" || path == "dev/null" {
		return "/dev/null".to_string();
	}
	if let Some(rest) = path.strip_prefix("a/") {
		return rest.to_string();
	}
	if let Some(rest) = path.strip_prefix("b/") {
		return rest.to_string();
	}
	path.to_string()
}

fn unescape_c_string(s: &str) -> String {
	let mut out = String::with_capacity(s.len());
	let mut chars = s.chars();
	while let Some(ch) = chars.next() {
		if ch == '\\' {
			if let Some(next) = chars.next() {
				match next {
					'n' => out.push('\n'),
					'r' => out.push('\r'),
					't' => out.push('\t'),
					'\\' => out.push('\\'),
					'"' => out.push('"'),
					'\'' => out.push('\''),
					other => {
						out.push('\\');
						out.push(other);
					},
				}
			} else {
				out.push('\\');
			}
		} else {
			out.push(ch);
		}
	}
	out
}

pub(super) fn parse_path_header(line: &str) -> String {
	let s = line.trim();
	if s.starts_with('"')
		&& let (Some(token), _) = extract_git_path_token(s)
	{
		return strip_git_prefix(&token);
	}
	let token = if let Some((before_tab, _)) = s.split_once('\t') {
		before_tab
	} else {
		s
	};
	strip_git_prefix(token.trim())
}

pub(super) fn parse_binary_paths(line: &str, old_path: &mut String, new_path: &mut String) {
	if let Some(rest) = line.strip_prefix("Binary files ")
		&& let Some(content) = rest.strip_suffix(" differ")
		&& let Some((left, right)) = content.split_once(" and ")
	{
		let parsed_left = parse_path_header(left);
		let parsed_right = parse_path_header(right);
		if old_path.is_empty() {
			*old_path = parsed_left;
		}
		if new_path.is_empty() {
			*new_path = parsed_right;
		}
	}
}

pub(super) fn parse_hunk_header(line: &str) -> Option<(u32, u32, u32, u32, String)> {
	let rest = line.strip_prefix("@@")?;
	let second_at = rest.find("@@")?;
	let middle = rest.get(..second_at)?;
	let after_second_at = rest.get(second_at + 2..)?;
	let section = after_second_at
		.strip_prefix(' ')
		.unwrap_or(after_second_at)
		.to_string();

	let mut old_range = None;
	let mut new_range = None;

	for part in middle.split_whitespace() {
		if let Some(stripped) = part.strip_prefix('-') {
			old_range = Some(parse_range(stripped)?);
		} else if let Some(stripped) = part.strip_prefix('+') {
			new_range = Some(parse_range(stripped)?);
		}
	}

	let (old_start, old_len) = old_range?;
	let (new_start, new_len) = new_range?;

	Some((old_start, old_len, new_start, new_len, section))
}

fn parse_range(s: &str) -> Option<(u32, u32)> {
	if let Some((start_str, len_str)) = s.split_once(',') {
		let start = start_str.parse::<u32>().ok()?;
		let len = len_str.parse::<u32>().ok()?;
		Some((start, len))
	} else {
		let start = s.parse::<u32>().ok()?;
		Some((start, 1))
	}
}
