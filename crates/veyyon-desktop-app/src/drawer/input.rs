//! What a keystroke writes to a terminal, in the encoding xterm uses.

use veyyon_gpui::Keystroke;

/// The bytes `keystroke` writes to a terminal; `None` for one the terminal
/// does not take, which the window keeps for its own bindings.
pub fn keystroke_bytes(keystroke: &Keystroke) -> Option<Vec<u8>> {
	let modifiers = &keystroke.modifiers;
	if modifiers.platform || modifiers.function {
		return None;
	}
	let key = keystroke.key.as_str();
	// xterm's modifier parameter: 1 plus shift 1, alt 2, control 4.
	let param =
		1 + u8::from(modifiers.shift) + 2 * u8::from(modifiers.alt) + 4 * u8::from(modifiers.control);
	if let Some(bytes) = named(key, param, modifiers.shift) {
		return Some(bytes);
	}
	if modifiers.control {
		return control(key).map(|byte| meta(modifiers.alt, vec![byte]));
	}
	let text = if modifiers.alt {
		key
	} else {
		keystroke.key_char.as_deref().unwrap_or(key)
	};
	(text.chars().count() == 1).then(|| meta(modifiers.alt, text.as_bytes().to_vec()))
}

/// `bytes` behind an escape when alt is held, as a terminal's meta key.
fn meta(alt: bool, bytes: Vec<u8>) -> Vec<u8> {
	if alt {
		let mut escaped = Vec::with_capacity(bytes.len() + 1);
		escaped.push(0x1b);
		escaped.extend(bytes);
		escaped
	} else {
		bytes
	}
}

/// The sequence of a key that is not text: movement, editing and function
/// keys, carrying `param` when a modifier is held.
fn named(key: &str, param: u8, shift: bool) -> Option<Vec<u8>> {
	let bare = param == 1;
	let alt = matches!(param, 3 | 4 | 7 | 8);
	let csi = |end: &str| -> Vec<u8> {
		if bare {
			format!("\x1b[{end}")
		} else {
			format!("\x1b[1;{param}{end}")
		}
		.into_bytes()
	};
	let tilde = |code: u8| -> Vec<u8> {
		if bare {
			format!("\x1b[{code}~")
		} else {
			format!("\x1b[{code};{param}~")
		}
		.into_bytes()
	};
	let ss3 = |end: char| -> Vec<u8> {
		if bare {
			format!("\x1bO{end}")
		} else {
			format!("\x1b[1;{param}{end}")
		}
		.into_bytes()
	};
	Some(match key {
		"enter" => meta(alt, b"\r".to_vec()),
		"tab" if shift => b"\x1b[Z".to_vec(),
		"tab" => meta(alt, b"\t".to_vec()),
		"escape" => meta(alt, vec![0x1b]),
		"backspace" if param == 5 => vec![0x08],
		"backspace" => meta(alt, vec![0x7f]),
		"up" => csi("A"),
		"down" => csi("B"),
		"right" => csi("C"),
		"left" => csi("D"),
		"home" => csi("H"),
		"end" => csi("F"),
		"insert" => tilde(2),
		"delete" => tilde(3),
		"pageup" => tilde(5),
		"pagedown" => tilde(6),
		"f1" => ss3('P'),
		"f2" => ss3('Q'),
		"f3" => ss3('R'),
		"f4" => ss3('S'),
		"f5" => tilde(15),
		"f6" => tilde(17),
		"f7" => tilde(18),
		"f8" => tilde(19),
		"f9" => tilde(20),
		"f10" => tilde(21),
		"f11" => tilde(23),
		"f12" => tilde(24),
		_ => return None,
	})
}

/// The control character a control chord writes: a letter's position in
/// the alphabet, and the ASCII control codes of the punctuation around it.
fn control(key: &str) -> Option<u8> {
	let mut chars = key.chars();
	let (Some(c), None) = (chars.next(), chars.next()) else {
		return (key == "space").then_some(0);
	};
	match c.to_ascii_lowercase() {
		c @ 'a'..='z' => Some(c as u8 - b'a' + 1),
		'@' | '2' | ' ' => Some(0),
		'[' | '3' => Some(0x1b),
		'\\' | '4' => Some(0x1c),
		']' | '5' => Some(0x1d),
		'^' | '6' => Some(0x1e),
		'_' | '-' | '7' => Some(0x1f),
		'?' | '8' => Some(0x7f),
		_ => None,
	}
}

/// What pasting `text` writes: the text with newlines as carriage returns,
/// bracketed when the program asked for it.
pub fn paste_bytes(text: &str, bracketed: bool) -> Vec<u8> {
	let body = text.replace("\r\n", "\r").replace('\n', "\r");
	if bracketed {
		// A pasted end marker would end the bracket early and run the rest as
		// typed keys.
		let body = body.replace("\x1b[201~", "");
		format!("\x1b[200~{body}\x1b[201~").into_bytes()
	} else {
		body.into_bytes()
	}
}
