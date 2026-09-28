//! The application and arguments a start field's line states.

/// The application and arguments `line` states, or `None` when it states no
/// application.
///
/// The supervisor spawns the application directly rather than through a
/// shell, so the line is split on whitespace outside quotes and each quoted
/// run is one argument: `bun run dev` is three tokens, and
/// `git commit -m "one two"` passes the message as one. A quote left open
/// ends at the end of the line.
pub fn split_command_line(line: &str) -> Option<(String, Vec<String>)> {
	let mut tokens: Vec<String> = Vec::new();
	let mut token = String::new();
	let mut started = false;
	let mut quote: Option<char> = None;
	for ch in line.chars() {
		match quote {
			Some(open) if ch == open => quote = None,
			Some(_) => token.push(ch),
			None if ch == '"' || ch == '\'' => {
				quote = Some(ch);
				started = true;
			},
			None if ch.is_whitespace() => {
				if started {
					tokens.push(std::mem::take(&mut token));
					started = false;
				}
			},
			None => {
				token.push(ch);
				started = true;
			},
		}
	}
	if started {
		tokens.push(token);
	}
	let mut tokens = tokens.into_iter();
	let command = tokens.next().filter(|token| !token.is_empty())?;
	Some((command, tokens.collect()))
}
