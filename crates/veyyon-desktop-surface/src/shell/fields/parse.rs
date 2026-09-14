//! What a field's text states, read out of the line the operator typed.
//!
//! A field carries one line of prose the window has to turn into something the
//! host can answer: a list of chords, or an application and its arguments. Both
//! readers are total -- a line that states nothing usable yields nothing, and
//! the caller refuses it where it was typed.

use veyyon_gpui::Keystroke;

/// The chords a keybinding field's text states: the alternatives separated by
/// commas, each one token in the keymap grammar.
///
/// A chord is read by [`Keystroke::parse`], which is the grammar that binds
/// it, rather than by `KeyChord::parse`, which reads a chord for a chip to
/// draw and is deliberately lenient about one it cannot make sense of. The two
/// disagree: `ctrl-` is a hyphen with a modifier to the chip and a modifier
/// with no key to the binder, so validating with the reader that never binds
/// anything is how `ctrl-` was taken and bound to a press that cannot happen.
///
/// A part that is blank, one that carries whitespace inside it, and one whose
/// modifiers are followed by no key are all dropped, so a field that states
/// nothing bindable yields no chord and is refused rather than sent.
pub fn parse_chords(text: &str) -> Vec<String> {
	text
		.split(',')
		.map(str::trim)
		.filter(|chord| !chord.is_empty() && !chord.contains(char::is_whitespace))
		.filter(|chord| Keystroke::parse(chord).is_ok_and(|stroke| !stroke.key.is_empty()))
		.map(str::to_owned)
		.collect()
}

/// The application and arguments a command line states, or `None` when it
/// states no application.
///
/// The host spawns the application directly rather than through a shell, so a
/// line is split on whitespace outside quotes and each quoted run is one
/// argument: `bun run dev` is three tokens, and `git commit -m "one two"`
/// carries the message as one. A quote nobody closed ends at the end of the
/// line, which is what the operator meant by typing it.
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
