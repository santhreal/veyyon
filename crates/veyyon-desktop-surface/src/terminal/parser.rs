//! ECMA-48 ANSI terminal control sequence parser and emulator.
//!
//! Implements a state machine decoding UTF-8 stream bytes, SGR styling, cursor
//! addressing, erase commands, scrolling regions, OSC titles, and DEC private
//! modes.

use super::{csi::dispatch_csi, grid::TerminalGrid};

/// Internal state of the ECMA-48 sequence parser.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
enum State {
	#[default]
	Ground,
	Escape,
	CsiEntry,
	CsiParam,
	CsiIntermediate,
	CsiIgnore,
	OscString,
	OscEscape,
	Dcs,
	DcsEscape,
	SosPmApc,
	SosPmApcEscape,
}

/// The complete terminal emulator owning grid state and stream parser.
#[derive(Debug, Clone)]
pub struct TerminalEmulator {
	pub grid:      TerminalGrid,
	state:         State,
	params:        Vec<u16>,
	current_param: u16,
	has_param:     bool,
	private_flag:  bool,
	osc_buf:       String,
	utf8_buf:      [u8; 4],
	utf8_len:      usize,
}

impl TerminalEmulator {
	/// Constructs a new terminal emulator with initial grid dimensions.
	#[must_use]
	pub fn new(cols: usize, rows: usize) -> Self {
		Self {
			grid:          TerminalGrid::new(cols, rows),
			state:         State::Ground,
			params:        Vec::with_capacity(16),
			current_param: 0,
			has_param:     false,
			private_flag:  false,
			osc_buf:       String::with_capacity(128),
			utf8_buf:      [0; 4],
			utf8_len:      0,
		}
	}

	/// Returns a reference to the underlying grid.
	#[must_use]
	pub const fn grid(&self) -> &TerminalGrid {
		&self.grid
	}

	/// Returns a mutable reference to the underlying grid.
	pub const fn grid_mut(&mut self) -> &mut TerminalGrid {
		&mut self.grid
	}

	/// Resizes the emulator's grid.
	pub fn resize(&mut self, cols: usize, rows: usize) {
		self.grid.resize(cols, rows);
	}

	/// Resets the emulator and grid back to blank default state.
	pub fn reset(&mut self) {
		let (cols, rows) = (self.grid.cols, self.grid.rows);
		*self = Self::new(cols, rows);
	}

	/// Feeds a byte slice of terminal output into the parser and grid.
	pub fn feed(&mut self, bytes: &[u8]) {
		let mut i = 0;
		while i < bytes.len() {
			if self.state == State::Ground && self.utf8_len == 0 && bytes[i] < 0x80 {
				self.process_byte(bytes[i]);
				i += 1;
				continue;
			}

			if self.state == State::Ground {
				let b = bytes[i];
				if b == 0x1b {
					self.utf8_len = 0;
					self.state = State::Escape;
					i += 1;
					continue;
				}
				self.utf8_buf[self.utf8_len] = b;
				self.utf8_len += 1;
				match std::str::from_utf8(&self.utf8_buf[..self.utf8_len]) {
					Ok(s) => {
						for c in s.chars() {
							self.grid.print_char(c);
						}
						self.utf8_len = 0;
					},
					Err(e) => {
						if e.error_len().is_some() || self.utf8_len == 4 {
							self.utf8_len = 0;
						}
					},
				}
			} else {
				self.process_byte(bytes[i]);
			}
			i += 1;
		}
	}

	fn process_byte(&mut self, byte: u8) {
		match self.state {
			State::Ground => self.handle_ground(byte),
			State::Escape => self.handle_escape(byte),
			State::CsiEntry => self.handle_csi_entry(byte),
			State::CsiParam => self.handle_csi_param(byte),
			State::CsiIntermediate => self.handle_csi_intermediate(byte),
			State::CsiIgnore => self.handle_csi_ignore(byte),
			State::OscString => self.handle_osc_string(byte),
			State::OscEscape => self.handle_osc_escape(byte),
			State::Dcs => self.handle_dcs(byte),
			State::DcsEscape => self.handle_dcs_escape(byte),
			State::SosPmApc => self.handle_sos_pm_apc(byte),
			State::SosPmApcEscape => self.handle_sos_pm_apc_escape(byte),
		}
	}

	fn handle_ground(&mut self, byte: u8) {
		match byte {
			0x1b => self.state = State::Escape,
			0x07 => {},
			0x08 => self.grid.backspace(),
			0x09 => self.grid.tab(),
			0x0a..=0x0c => self.grid.linefeed(),
			0x0d => self.grid.carriage_return(),
			0x20..=0x7e => self.grid.print_char(byte as char),
			_ => {},
		}
	}

	fn handle_escape(&mut self, byte: u8) {
		match byte {
			b'[' => {
				self.params.clear();
				self.current_param = 0;
				self.has_param = false;
				self.private_flag = false;
				self.state = State::CsiEntry;
			},
			b']' => {
				self.osc_buf.clear();
				self.state = State::OscString;
			},
			b'P' => self.state = State::Dcs,
			b'X' | b'^' | b'_' => self.state = State::SosPmApc,
			b'D' => {
				self.grid.linefeed();
				self.state = State::Ground;
			},
			b'M' => {
				if self.grid.cursor_row == self.grid.scroll_top {
					self.grid.scroll_down_region(1);
				} else {
					self.grid.cursor_row = self.grid.cursor_row.saturating_sub(1);
				}
				self.state = State::Ground;
			},
			b'E' => {
				self.grid.carriage_return();
				self.grid.linefeed();
				self.state = State::Ground;
			},
			b'7' => {
				self.grid.save_cursor();
				self.state = State::Ground;
			},
			b'8' => {
				self.grid.restore_cursor();
				self.state = State::Ground;
			},
			b'c' => {
				self.reset();
				self.state = State::Ground;
			},
			0x1b => {},
			_ => self.state = State::Ground,
		}
	}

	fn handle_csi_entry(&mut self, byte: u8) {
		match byte {
			b'?' | b'>' | b'=' | b'<' => {
				self.private_flag = true;
				self.state = State::CsiParam;
			},
			b'0'..=b'9' => {
				self.current_param = (byte - b'0') as u16;
				self.has_param = true;
				self.state = State::CsiParam;
			},
			b';' => {
				self.params.push(0);
				self.current_param = 0;
				self.has_param = false;
				self.state = State::CsiParam;
			},
			0x20..=0x2f => self.state = State::CsiIntermediate,
			0x40..=0x7e => {
				self.dispatch_csi(byte);
				self.state = State::Ground;
			},
			0x1b => self.state = State::Escape,
			_ => self.state = State::CsiIgnore,
		}
	}

	fn handle_csi_param(&mut self, byte: u8) {
		match byte {
			b'0'..=b'9' => {
				self.current_param = self
					.current_param
					.saturating_mul(10)
					.saturating_add((byte - b'0') as u16);
				self.has_param = true;
			},
			b';' => {
				self.params.push(if self.has_param {
					self.current_param
				} else {
					0
				});
				self.current_param = 0;
				self.has_param = false;
			},
			0x20..=0x2f => {
				if self.has_param {
					self.params.push(self.current_param);
				}
				self.state = State::CsiIntermediate;
			},
			0x40..=0x7e => {
				if self.has_param {
					self.params.push(self.current_param);
				}
				self.dispatch_csi(byte);
				self.state = State::Ground;
			},
			0x1b => self.state = State::Escape,
			_ => self.state = State::CsiIgnore,
		}
	}

	fn handle_csi_intermediate(&mut self, byte: u8) {
		match byte {
			0x20..=0x2f => {},
			0x40..=0x7e => {
				self.dispatch_csi(byte);
				self.state = State::Ground;
			},
			0x1b => self.state = State::Escape,
			_ => self.state = State::CsiIgnore,
		}
	}

	const fn handle_csi_ignore(&mut self, byte: u8) {
		match byte {
			0x40..=0x7e => self.state = State::Ground,
			0x1b => self.state = State::Escape,
			_ => {},
		}
	}

	fn handle_osc_string(&mut self, byte: u8) {
		match byte {
			0x07 => {
				self.dispatch_osc();
				self.state = State::Ground;
			},
			0x1b => self.state = State::OscEscape,
			_ => {
				if self.osc_buf.len() < 1024 {
					self.osc_buf.push(byte as char);
				}
			},
		}
	}

	fn handle_osc_escape(&mut self, byte: u8) {
		if byte == b'\\' {
			self.dispatch_osc();
			self.state = State::Ground;
		} else {
			self.state = State::Escape;
			self.handle_escape(byte);
		}
	}

	const fn handle_dcs(&mut self, byte: u8) {
		match byte {
			0x07 => self.state = State::Ground,
			0x1b => self.state = State::DcsEscape,
			_ => {},
		}
	}

	fn handle_dcs_escape(&mut self, byte: u8) {
		if byte == b'\\' {
			self.state = State::Ground;
		} else {
			self.state = State::Escape;
			self.handle_escape(byte);
		}
	}

	const fn handle_sos_pm_apc(&mut self, byte: u8) {
		match byte {
			0x07 => self.state = State::Ground,
			0x1b => self.state = State::SosPmApcEscape,
			_ => {},
		}
	}

	fn handle_sos_pm_apc_escape(&mut self, byte: u8) {
		if byte == b'\\' {
			self.state = State::Ground;
		} else {
			self.state = State::Escape;
			self.handle_escape(byte);
		}
	}

	fn dispatch_csi(&mut self, cmd: u8) {
		dispatch_csi(cmd, &self.params, self.private_flag, &mut self.grid);
	}

	fn dispatch_osc(&mut self) {
		if let Some((kind, title)) = self.osc_buf.split_once(';')
			&& (kind == "0" || kind == "2")
		{
			self.grid.title = title.to_string();
		}
	}
}
