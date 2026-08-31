//! Byte-stream terminal parser handling C0, ESC, CSI, OSC, and chunked UTF-8.

pub const MAX_CSI_PARAMS: usize = 64;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
enum State {
	#[default]
	Ground,
	Escape,
	EscapeHash,
	Charset,
	Csi,
	Osc,
	OscEscape,
}

/// A parsed CSI sequence packet passed to the terminal handler.
#[derive(Debug, Clone, Copy)]
pub struct CsiSequence<'a> {
	pub prefix:        Option<u8>,
	pub params:        &'a [Option<u32>],
	pub intermediates: &'a [u8],
	pub final_byte:    u8,
}

impl<'a> CsiSequence<'a> {
	pub fn param(&self, index: usize, default: u32) -> u32 {
		self.params.get(index).copied().flatten().unwrap_or(default)
	}

	pub fn param_opt(&self, index: usize) -> Option<u32> {
		self.params.get(index).copied().flatten()
	}
}

/// Handler trait receiving parsed terminal events.
pub trait ParserHandler {
	fn print(&mut self, ch: char);
	fn execute_c0(&mut self, byte: u8);
	fn csi(&mut self, seq: CsiSequence<'_>);
	fn esc(&mut self, byte: u8);
	fn esc_hash(&mut self, byte: u8);
	fn osc(&mut self, code: u32, data: &str);
}

/// State machine parsing a terminal byte stream.
#[derive(Debug, Clone)]
pub struct ByteParser {
	state:             State,
	utf8_buf:          [u8; 4],
	utf8_len:          usize,
	utf8_expected:     usize,
	csi_prefix:        Option<u8>,
	csi_params:        [Option<u32>; MAX_CSI_PARAMS],
	csi_param_count:   usize,
	csi_current_param: Option<u32>,
	csi_intermediates: [u8; 4],
	csi_inter_count:   usize,
	osc_code:          u32,
	osc_buf:           String,
}

impl Default for ByteParser {
	fn default() -> Self {
		Self::new()
	}
}

impl ByteParser {
	pub fn new() -> Self {
		Self {
			state:             State::Ground,
			utf8_buf:          [0; 4],
			utf8_len:          0,
			utf8_expected:     0,
			csi_prefix:        None,
			csi_params:        [None; MAX_CSI_PARAMS],
			csi_param_count:   0,
			csi_current_param: None,
			csi_intermediates: [0; 4],
			csi_inter_count:   0,
			osc_code:          0,
			osc_buf:           String::new(),
		}
	}

	pub fn advance<H: ParserHandler>(&mut self, bytes: &[u8], handler: &mut H) {
		for &b in bytes {
			self.process_byte(b, handler);
		}
	}

	fn process_byte<H: ParserHandler>(&mut self, b: u8, handler: &mut H) {
		// ESC always aborts the current sequence and starts a new Escape state
		if b == 0x1b && self.state != State::Osc {
			self.reset_utf8();
			self.state = State::Escape;
			return;
		}

		match self.state {
			State::Ground => self.process_ground(b, handler),
			State::Escape => self.process_escape(b, handler),
			State::EscapeHash => {
				self.state = State::Ground;
				handler.esc_hash(b);
			},
			State::Charset => {
				self.state = State::Ground;
			},
			State::Csi => self.process_csi(b, handler),
			State::Osc => self.process_osc(b, handler),
			State::OscEscape => {
				if b == b'\\' {
					self.finish_osc(handler);
				}
				self.state = State::Ground;
			},
		}
	}

	fn reset_utf8(&mut self) {
		self.utf8_len = 0;
		self.utf8_expected = 0;
	}

	fn process_ground<H: ParserHandler>(&mut self, b: u8, handler: &mut H) {
		if b < 0x20 || b == 0x7f {
			self.reset_utf8();
			handler.execute_c0(b);
			return;
		}

		if self.utf8_len > 0 {
			if (0x80..=0xbf).contains(&b) {
				self.utf8_buf[self.utf8_len] = b;
				self.utf8_len += 1;
				if self.utf8_len == self.utf8_expected {
					if let Ok(s) = std::str::from_utf8(&self.utf8_buf[..self.utf8_len]) {
						for ch in s.chars() {
							handler.print(ch);
						}
					}
					self.reset_utf8();
				}
			} else {
				self.reset_utf8();
				self.process_ground(b, handler);
			}
		} else if b < 0x80 {
			handler.print(b as char);
		} else if (0xc2..=0xdf).contains(&b) {
			self.utf8_buf[0] = b;
			self.utf8_len = 1;
			self.utf8_expected = 2;
		} else if (0xe0..=0xef).contains(&b) {
			self.utf8_buf[0] = b;
			self.utf8_len = 1;
			self.utf8_expected = 3;
		} else if (0xf0..=0xf4).contains(&b) {
			self.utf8_buf[0] = b;
			self.utf8_len = 1;
			self.utf8_expected = 4;
		}
	}

	fn process_escape<H: ParserHandler>(&mut self, b: u8, handler: &mut H) {
		match b {
			b'[' => {
				self.state = State::Csi;
				self.csi_prefix = None;
				self.csi_param_count = 0;
				self.csi_current_param = None;
				self.csi_inter_count = 0;
				self.csi_params.fill(None);
			},
			b']' => {
				self.state = State::Osc;
				self.osc_code = 0;
				self.osc_buf.clear();
			},
			b'#' => {
				self.state = State::EscapeHash;
			},
			b'(' | b')' | b'*' | b'+' => {
				self.state = State::Charset;
			},
			_ => {
				self.state = State::Ground;
				handler.esc(b);
			},
		}
	}

	fn process_csi<H: ParserHandler>(&mut self, b: u8, handler: &mut H) {
		match b {
			b'0'..=b'9' => {
				let digit = (b - b'0') as u32;
				let curr = self.csi_current_param.unwrap_or(0);
				self.csi_current_param = Some(curr.saturating_mul(10).saturating_add(digit));
			},
			b';' | b':' => {
				if self.csi_param_count < MAX_CSI_PARAMS {
					self.csi_params[self.csi_param_count] = self.csi_current_param;
					self.csi_param_count += 1;
				}
				self.csi_current_param = None;
			},
			b'?' | b'>' | b'=' | b'<' => {
				if self.csi_prefix.is_none()
					&& self.csi_param_count == 0
					&& self.csi_current_param.is_none()
				{
					self.csi_prefix = Some(b);
				}
			},
			0x20..=0x2f => {
				if self.csi_inter_count < 4 {
					self.csi_intermediates[self.csi_inter_count] = b;
					self.csi_inter_count += 1;
				}
			},
			0x40..=0x7e => {
				if self.csi_param_count < MAX_CSI_PARAMS {
					self.csi_params[self.csi_param_count] = self.csi_current_param;
					self.csi_param_count += 1;
				}
				let seq = CsiSequence {
					prefix:        self.csi_prefix,
					params:        &self.csi_params[..self.csi_param_count],
					intermediates: &self.csi_intermediates[..self.csi_inter_count],
					final_byte:    b,
				};
				self.state = State::Ground;
				handler.csi(seq);
			},
			_ => {
				self.state = State::Ground;
			},
		}
	}

	fn process_osc<H: ParserHandler>(&mut self, b: u8, handler: &mut H) {
		match b {
			0x07 => {
				self.finish_osc(handler);
				self.state = State::Ground;
			},
			0x1b => {
				self.state = State::OscEscape;
			},
			_ => {
				if self.osc_buf.len() < 4096 {
					self.osc_buf.push(b as char);
				}
			},
		}
	}

	fn finish_osc<H: ParserHandler>(&mut self, handler: &mut H) {
		if let Some((code, data)) = self
			.osc_buf
			.split_once(';')
			.and_then(|(c, d)| c.parse::<u32>().ok().map(|code| (code, d)))
		{
			handler.osc(code, data);
		}
		self.osc_buf.clear();
	}
}
