//! One file's worth of a patch: the headers that open it, and the hunks
//! until the next file begins.

use super::{
	Change, DiffLine, FileDiff, Hunk, LineKind,
	header::{parse_binary_paths, parse_diff_git_paths, parse_hunk_header, parse_path_header},
};

pub(super) fn parse_file(lines: &[&str], start_i: usize) -> (FileDiff, usize) {
	let n = lines.len();
	let mut i = start_i;

	let mut old_path = String::new();
	let mut new_path = String::new();
	let mut change = Change::Modified;
	let mut hunks = Vec::new();
	let mut binary = false;
	let mut mode = None;

	if let Some(line) = lines.get(i)
		&& line.starts_with("diff --git ")
	{
		let (git_old, git_new) = parse_diff_git_paths(line);
		if let Some(o) = git_old {
			old_path = o;
		}
		if let Some(n_path) = git_new {
			new_path = n_path;
		}
		i += 1;
	}

	while i < n {
		let line = match lines.get(i) {
			Some(l) => *l,
			None => break,
		};

		if line.starts_with("diff --git ") {
			break;
		}
		if line.starts_with("--- ")
			&& lines.get(i + 1).is_some_and(|l| l.starts_with("+++ "))
			&& !hunks.is_empty()
		{
			break;
		}
		if line.starts_with("@@") && parse_hunk_header(line).is_some() {
			break;
		}

		if let Some(rest) = line.strip_prefix("old mode ") {
			mode = rest.split_whitespace().last().map(|s| s.to_string());
			i += 1;
		} else if let Some(rest) = line.strip_prefix("new mode ") {
			mode = rest.split_whitespace().last().map(|s| s.to_string());
			i += 1;
		} else if let Some(rest) = line.strip_prefix("new file mode ") {
			mode = rest.split_whitespace().last().map(|s| s.to_string());
			change = Change::Added;
			i += 1;
		} else if let Some(rest) = line.strip_prefix("deleted file mode ") {
			mode = rest.split_whitespace().last().map(|s| s.to_string());
			change = Change::Removed;
			i += 1;
		} else if line.starts_with("similarity index ") || line.starts_with("dissimilarity index ") {
			i += 1;
		} else if let Some(rest) = line.strip_prefix("rename from ") {
			change = Change::Renamed;
			old_path = parse_path_header(rest);
			i += 1;
		} else if let Some(rest) = line.strip_prefix("rename to ") {
			change = Change::Renamed;
			new_path = parse_path_header(rest);
			i += 1;
		} else if let Some(rest) = line.strip_prefix("copy from ") {
			old_path = parse_path_header(rest);
			i += 1;
		} else if let Some(rest) = line.strip_prefix("copy to ") {
			new_path = parse_path_header(rest);
			i += 1;
		} else if line.starts_with("index ") {
			i += 1;
		} else if line.starts_with("Binary files ") && line.ends_with(" differ") {
			binary = true;
			parse_binary_paths(line, &mut old_path, &mut new_path);
			i += 1;
		} else if line.starts_with("GIT binary patch") {
			binary = true;
			i += 1;
			while i < n {
				if let Some(l) = lines.get(i) {
					if l.starts_with("diff --git ") || l.starts_with("--- ") || l.starts_with("@@") {
						break;
					}
					i += 1;
				} else {
					break;
				}
			}
			break;
		} else if let Some(rest) = line.strip_prefix("--- ") {
			let p = parse_path_header(rest);
			if p == "/dev/null" {
				old_path = "/dev/null".to_string();
				change = Change::Added;
			} else {
				old_path = p;
			}
			i += 1;
			if let Some(next_line) = lines.get(i)
				&& let Some(plus_rest) = next_line.strip_prefix("+++ ")
			{
				let p2 = parse_path_header(plus_rest);
				if p2 == "/dev/null" {
					new_path = "/dev/null".to_string();
					change = Change::Removed;
				} else {
					new_path = p2;
				}
				i += 1;
			}
		} else if let Some(rest) = line.strip_prefix("+++ ") {
			let p2 = parse_path_header(rest);
			if p2 == "/dev/null" {
				new_path = "/dev/null".to_string();
				change = Change::Removed;
			} else {
				new_path = p2;
			}
			i += 1;
		} else {
			// A hunk, or anything else: the headers are over either way, and the
			// hunk loop below reads the line again.
			break;
		}
	}

	while i < n {
		let line = match lines.get(i) {
			Some(l) => *l,
			None => break,
		};

		if line.starts_with("diff --git ") {
			break;
		}
		if line.starts_with("--- ") && lines.get(i + 1).is_some_and(|l| l.starts_with("+++ ")) {
			break;
		}

		if line.starts_with("@@") {
			if let Some((old_start, old_len, new_start, new_len, section)) = parse_hunk_header(line) {
				i += 1;
				let mut hunk =
					Hunk { old_start, old_len, new_start, new_len, section, lines: Vec::new() };
				let mut current_old = old_start;
				let mut current_new = new_start;

				while i < n {
					let hline = match lines.get(i) {
						Some(l) => *l,
						None => break,
					};

					if hline.starts_with("diff --git ") {
						break;
					}
					if hline.starts_with("--- ")
						&& lines.get(i + 1).is_some_and(|l| l.starts_with("+++ "))
					{
						break;
					}
					if hline.starts_with("@@") {
						break;
					}

					if let Some(rest) = hline.strip_prefix(' ') {
						hunk.lines.push(DiffLine {
							kind:       LineKind::Context,
							text:       rest.to_string(),
							old_no:     Some(current_old),
							new_no:     Some(current_new),
							no_newline: false,
						});
						current_old = current_old.saturating_add(1);
						current_new = current_new.saturating_add(1);
						i += 1;
					} else if hline.is_empty() {
						hunk.lines.push(DiffLine {
							kind:       LineKind::Context,
							text:       String::new(),
							old_no:     Some(current_old),
							new_no:     Some(current_new),
							no_newline: false,
						});
						current_old = current_old.saturating_add(1);
						current_new = current_new.saturating_add(1);
						i += 1;
					} else if let Some(rest) = hline.strip_prefix('+') {
						hunk.lines.push(DiffLine {
							kind:       LineKind::Added,
							text:       rest.to_string(),
							old_no:     None,
							new_no:     Some(current_new),
							no_newline: false,
						});
						current_new = current_new.saturating_add(1);
						i += 1;
					} else if let Some(rest) = hline.strip_prefix('-') {
						hunk.lines.push(DiffLine {
							kind:       LineKind::Removed,
							text:       rest.to_string(),
							old_no:     Some(current_old),
							new_no:     None,
							no_newline: false,
						});
						current_old = current_old.saturating_add(1);
						i += 1;
					} else if hline.starts_with('\\') {
						if let Some(last) = hunk.lines.last_mut() {
							last.no_newline = true;
						}
						i += 1;
					} else {
						break;
					}
				}
				hunks.push(hunk);
			} else {
				i += 1;
			}
		} else {
			i += 1;
		}
	}

	if change == Change::Modified
		&& !old_path.is_empty()
		&& !new_path.is_empty()
		&& old_path != "/dev/null"
		&& new_path != "/dev/null"
		&& old_path != new_path
	{
		change = Change::Renamed;
	}

	(FileDiff { old_path, new_path, change, hunks, binary, mode }, i)
}
