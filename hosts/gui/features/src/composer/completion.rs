//! Slash-command and skill trigger detection at the retained caret.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CompletionKind {
	SlashCommand,
	Skill,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Completion<'a> {
	pub kind:         CompletionKind,
	pub query:        &'a str,
	pub replace_from: usize,
}

/// Return a completion only when the caret is inside a leading token. Tokens in
/// prose and escaped markers remain ordinary draft text.
pub fn at_caret(text: &str, caret: usize) -> Option<Completion<'_>> {
	if caret > text.len() || !text.is_char_boundary(caret) {
		return None;
	}
	let before = &text[..caret];
	let start = before
		.char_indices()
		.rev()
		.find_map(|(offset, character)| {
			character
				.is_whitespace()
				.then_some(offset + character.len_utf8())
		})
		.unwrap_or(0);
	let token = &before[start..];
	let (kind, query) = match token.as_bytes().first().copied()? {
		b'/' => (CompletionKind::SlashCommand, &token[1..]),
		b'$' => (CompletionKind::Skill, &token[1..]),
		_ => return None,
	};
	if query.contains(['/', '$']) {
		return None;
	}
	Some(Completion { kind, query, replace_from: start })
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn triggers_follow_the_retained_caret() {
		assert_eq!(
			at_caret("explain /com", 12),
			Some(Completion {
				kind:         CompletionKind::SlashCommand,
				query:        "com",
				replace_from: 8,
			}),
		);
		assert_eq!(
			at_caret("$review later", 7),
			Some(Completion {
				kind:         CompletionKind::Skill,
				query:        "review",
				replace_from: 0,
			}),
		);
		assert_eq!(at_caret("path/to/file", 12), None);
	}

	#[test]
	fn invalid_caret_never_slices_utf8() {
		assert_eq!(at_caret("é/", 1), None);
	}
}
