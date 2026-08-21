//! Terminal input injection encoding.
//!
//! Produces the exact byte sequences a real VT100/xterm terminal sends for
//! named keys, modifier combinations, bracketed paste, mouse events (SGR 1006),
//! and signal keys (`Ctrl+C`, `Ctrl+D`).

/// Modifier keys bitflags / representation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Hash)]
pub struct Modifiers {
	/// Shift key held.
	pub shift: bool,
	/// Alt / Option / Meta key held.
	pub alt:   bool,
	/// Ctrl key held.
	pub ctrl:  bool,
}

impl Modifiers {
	/// No modifiers.
	#[must_use]
	pub const fn none() -> Self {
		Self { shift: false, alt: false, ctrl: false }
	}

	/// Shift only.
	#[must_use]
	pub const fn shift() -> Self {
		Self { shift: true, alt: false, ctrl: false }
	}

	/// Alt only.
	#[must_use]
	pub const fn alt() -> Self {
		Self { shift: false, alt: true, ctrl: false }
	}

	/// Ctrl only.
	#[must_use]
	pub const fn ctrl() -> Self {
		Self { shift: false, alt: false, ctrl: true }
	}

	/// Computes xterm modifier parameter (1 + shift*1 + alt*2 + ctrl*4).
	#[must_use]
	pub const fn xterm_param(&self) -> u8 {
		let mut param = 1;
		if self.shift {
			param += 1;
		}
		if self.alt {
			param += 2;
		}
		if self.ctrl {
			param += 4;
		}
		param
	}
}

/// Named special keys.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Key {
	/// Enter / Return key (`\r`).
	Enter,
	/// Tab key (`\t`).
	Tab,
	/// Backspace key (`\x7f` or `\x08`).
	Backspace,
	/// Escape key (`\x1b`).
	Escape,
	/// Up arrow.
	Up,
	/// Down arrow.
	Down,
	/// Right arrow.
	Right,
	/// Left arrow.
	Left,
	/// Home key.
	Home,
	/// End key.
	End,
	/// Page Up.
	PageUp,
	/// Page Down.
	PageDown,
	/// Insert key.
	Insert,
	/// Delete key.
	Delete,
	/// Function key F1..=F12.
	F(u8),
	/// Character key (Unicode char).
	Char(char),
}

/// Mouse button for SGR mouse tracking.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum MouseButton {
	/// Left mouse button.
	Left,
	/// Middle mouse button (wheel click).
	Middle,
	/// Right mouse button.
	Right,
	/// Mouse wheel scrolled up.
	WheelUp,
	/// Mouse wheel scrolled down.
	WheelDown,
}

/// Mouse action event.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum MouseEventKind {
	/// Button press.
	Press(MouseButton),
	/// Button release.
	Release(MouseButton),
	/// Drag with button held.
	Drag(MouseButton),
	/// Move without button pressed.
	Move,
}

/// Mouse event payload for SGR 1006 encoding.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MouseEvent {
	/// Event type (Press, Release, Drag, Move).
	pub kind:      MouseEventKind,
	/// 0-indexed column coordinate.
	pub col:       usize,
	/// 0-indexed row coordinate.
	pub row:       usize,
	/// Active modifiers.
	pub modifiers: Modifiers,
}

/// Input encoder producing real terminal byte sequences.
pub struct Input;

impl Input {
	/// Returns the byte sequence for `Ctrl+C` (`\x03`, `ETX`).
	#[must_use]
	pub const fn ctrl_c() -> &'static [u8] {
		b"\x03"
	}

	/// Returns the byte sequence for `Ctrl+D` (`\x04`, `EOT`).
	#[must_use]
	pub const fn ctrl_d() -> &'static [u8] {
		b"\x04"
	}

	/// Encodes a named key with modifiers.
	#[must_use]
	pub fn key(key: Key, mods: Modifiers) -> Vec<u8> {
		match key {
			Key::Char(c) => {
				if mods.ctrl {
					let code = (c.to_ascii_uppercase()) as u32;
					if (64..=95).contains(&code) {
						let ctrl_byte = (code - 64) as u8;
						if mods.alt {
							vec![0x1b, ctrl_byte]
						} else {
							vec![ctrl_byte]
						}
					} else {
						let mut bytes = Vec::new();
						if mods.alt {
							bytes.push(0x1b);
						}
						let mut buf = [0u8; 4];
						bytes.extend_from_slice(c.encode_utf8(&mut buf).as_bytes());
						bytes
					}
				} else if mods.alt {
					let mut bytes = vec![0x1b];
					let mut buf = [0u8; 4];
					bytes.extend_from_slice(c.encode_utf8(&mut buf).as_bytes());
					bytes
				} else {
					let mut buf = [0u8; 4];
					c.encode_utf8(&mut buf).as_bytes().to_vec()
				}
			},
			Key::Enter => {
				if mods.alt {
					vec![0x1b, b'\r']
				} else {
					vec![b'\r']
				}
			},
			Key::Tab => {
				if mods.shift {
					// Backtab (CSI Z)
					b"\x1b[Z".to_vec()
				} else if mods.alt {
					vec![0x1b, b'\t']
				} else {
					vec![b'\t']
				}
			},
			Key::Backspace => {
				if mods.alt {
					vec![0x1b, 0x7f]
				} else {
					vec![0x7f]
				}
			},
			Key::Escape => {
				if mods.alt {
					vec![0x1b, 0x1b]
				} else {
					vec![0x1b]
				}
			},
			Key::Up => Self::encode_csi_arrow('A', mods),
			Key::Down => Self::encode_csi_arrow('B', mods),
			Key::Right => Self::encode_csi_arrow('C', mods),
			Key::Left => Self::encode_csi_arrow('D', mods),
			Key::Home => {
				if mods.xterm_param() > 1 {
					format!("\x1b[1;{}H", mods.xterm_param()).into_bytes()
				} else {
					b"\x1b[H".to_vec()
				}
			},
			Key::End => {
				if mods.xterm_param() > 1 {
					format!("\x1b[1;{}F", mods.xterm_param()).into_bytes()
				} else {
					b"\x1b[F".to_vec()
				}
			},
			Key::PageUp => {
				if mods.xterm_param() > 1 {
					format!("\x1b[5;{}~", mods.xterm_param()).into_bytes()
				} else {
					b"\x1b[5~".to_vec()
				}
			},
			Key::PageDown => {
				if mods.xterm_param() > 1 {
					format!("\x1b[6;{}~", mods.xterm_param()).into_bytes()
				} else {
					b"\x1b[6~".to_vec()
				}
			},
			Key::Insert => {
				if mods.xterm_param() > 1 {
					format!("\x1b[2;{}~", mods.xterm_param()).into_bytes()
				} else {
					b"\x1b[2~".to_vec()
				}
			},
			Key::Delete => {
				if mods.xterm_param() > 1 {
					format!("\x1b[3;{}~", mods.xterm_param()).into_bytes()
				} else {
					b"\x1b[3~".to_vec()
				}
			},
			Key::F(n) => {
				let param = match n {
					1 => 11,
					2 => 12,
					3 => 13,
					4 => 14,
					5 => 15,
					6 => 17,
					7 => 18,
					8 => 19,
					9 => 20,
					10 => 21,
					11 => 23,
					12 => 24,
					_ => 11,
				};
				if mods.xterm_param() > 1 {
					format!("\x1b[{param};{}~", mods.xterm_param()).into_bytes()
				} else if n <= 4 {
					let ch = (b'P' + (n - 1)) as char;
					format!("\x1bO{ch}").into_bytes()
				} else {
					format!("\x1b[{param}~").into_bytes()
				}
			},
		}
	}

	fn encode_csi_arrow(final_ch: char, mods: Modifiers) -> Vec<u8> {
		if mods.xterm_param() > 1 {
			format!("\x1b[1;{}{final_ch}", mods.xterm_param()).into_bytes()
		} else {
			format!("\x1b[{final_ch}").into_bytes()
		}
	}

	/// Wraps a text payload in bracketed paste escape sequences (`\x1b[200~` and
	/// `\x1b[201~`). The pasted body is delivered verbatim as raw bytes without
	/// interpretation.
	#[must_use]
	pub fn bracketed_paste(content: &str) -> Vec<u8> {
		let mut bytes = Vec::with_capacity(content.len() + 16);
		bytes.extend_from_slice(b"\x1b[200~");
		bytes.extend_from_slice(content.as_bytes());
		bytes.extend_from_slice(b"\x1b[201~");
		bytes
	}

	/// Encodes a mouse event in SGR 1006 format (`\x1b[<b;x;yM` or
	/// `\x1b[<b;x;ym`). Terminal coordinates in SGR 1006 are 1-indexed.
	#[must_use]
	pub fn mouse(event: MouseEvent) -> Vec<u8> {
		let mut button_code: u32 = match event.kind {
			MouseEventKind::Press(btn) | MouseEventKind::Release(btn) => match btn {
				MouseButton::Left => 0,
				MouseButton::Middle => 1,
				MouseButton::Right => 2,
				MouseButton::WheelUp => 64,
				MouseButton::WheelDown => 65,
			},
			MouseEventKind::Drag(btn) => {
				let base = match btn {
					MouseButton::Left => 0,
					MouseButton::Middle => 1,
					MouseButton::Right => 2,
					MouseButton::WheelUp => 64,
					MouseButton::WheelDown => 65,
				};
				base + 32
			},
			MouseEventKind::Move => 35,
		};

		if event.modifiers.shift {
			button_code += 4;
		}
		if event.modifiers.alt {
			button_code += 8;
		}
		if event.modifiers.ctrl {
			button_code += 16;
		}

		let is_release = matches!(event.kind, MouseEventKind::Release(_));
		let suffix = if is_release { 'm' } else { 'M' };

		// 1-indexed coordinates
		let x = event.col + 1;
		let y = event.row + 1;

		format!("\x1b[<{button_code};{x};{y}{suffix}").into_bytes()
	}
}
