//! The classes of control sequence the emulator reads.
//!
//! Every sequence the parser recognises is named here, and the parser reaches
//! its behaviour only by resolving a byte to one of these. The table is what
//! the dispatch matches on, so the set a sweep reads at run time is the set
//! the emulator actually handles: a class nothing routes to has no arm, and a
//! byte with no class is left alone rather than half-handled.

/// A control character read in the ground state.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ControlChar {
	/// BEL: the host asked for a noise the window does not make.
	Bell,
	/// BS: back one column.
	Backspace,
	/// HT: on to the next tab stop.
	Tab,
	/// LF, VT and FF: down one line, scrolling at the margin.
	LineFeed,
	/// CR: back to the first column.
	CarriageReturn,
}

/// A sequence introduced by ESC and ended by its own byte.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum EscapeSeq {
	/// IND: down one line.
	Index,
	/// RI: up one line, scrolling at the top margin.
	ReverseIndex,
	/// NEL: to the first column of the next line.
	NextLine,
	/// DECSC: remember where the cursor is and how it is drawn.
	SaveCursor,
	/// DECRC: put the cursor back where it was remembered.
	RestoreCursor,
	/// RIS: back to a terminal that has printed nothing.
	Reset,
}

/// A sequence introduced by CSI and ended by a final byte.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum CsiSeq {
	/// ICH: open blank columns at the cursor.
	InsertCharacters,
	/// CUU: up.
	CursorUp,
	/// CUD: down.
	CursorDown,
	/// CUF: forward.
	CursorForward,
	/// CUB: back.
	CursorBack,
	/// CNL: to the first column, lines down.
	CursorNextLine,
	/// CPL: to the first column, lines up.
	CursorPreviousLine,
	/// CHA: to a column of this line.
	CursorColumn,
	/// CUP and HVP: to a row and a column.
	CursorPosition,
	/// ED: erase the screen, before or after the cursor or all of it.
	EraseInDisplay,
	/// EL: erase the line, before or after the cursor or all of it.
	EraseInLine,
	/// IL: open blank lines at the cursor.
	InsertLines,
	/// DL: take lines out at the cursor.
	DeleteLines,
	/// DCH: take characters out at the cursor.
	DeleteCharacters,
	/// SU: scroll the region up.
	ScrollUp,
	/// SD: scroll the region down.
	ScrollDown,
	/// ECH: blank characters at the cursor without moving anything.
	EraseCharacters,
	/// VPA: to a row of this column.
	LinePosition,
	/// SGR: how what is printed next is drawn.
	SelectGraphicRendition,
	/// DECSTBM: the rows scrolling happens between.
	SetScrollRegion,
	/// SCP: remember the cursor.
	SaveCursor,
	/// RCP: put it back.
	RestoreCursor,
	/// DECSET: turn a private mode on.
	SetPrivateMode,
	/// DECRST: turn a private mode off.
	ResetPrivateMode,
}

/// A sequence introduced by OSC and ended by BEL or ST.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum OscSeq {
	/// OSC 0 and OSC 2: the window title.
	WindowTitle,
}

/// One class of sequence, whichever introducer carries it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SequenceClass {
	/// A control character in the ground state.
	Control(ControlChar),
	/// A sequence introduced by ESC.
	Escape(EscapeSeq),
	/// A sequence introduced by CSI.
	Csi(CsiSeq),
	/// A sequence introduced by OSC.
	Osc(OscSeq),
}

impl ControlChar {
	/// Every control character the ground state reads.
	pub const ALL: &'static [Self] =
		&[Self::Bell, Self::Backspace, Self::Tab, Self::LineFeed, Self::CarriageReturn];

	/// The class `byte` selects in the ground state, if it selects one.
	#[must_use]
	pub const fn of(byte: u8) -> Option<Self> {
		match byte {
			0x07 => Some(Self::Bell),
			0x08 => Some(Self::Backspace),
			0x09 => Some(Self::Tab),
			0x0a..=0x0c => Some(Self::LineFeed),
			0x0d => Some(Self::CarriageReturn),
			_ => None,
		}
	}
}

impl EscapeSeq {
	/// Every sequence ESC introduces on its own.
	pub const ALL: &'static [Self] = &[
		Self::Index,
		Self::ReverseIndex,
		Self::NextLine,
		Self::SaveCursor,
		Self::RestoreCursor,
		Self::Reset,
	];

	/// The class the byte after ESC selects, if it selects one.
	#[must_use]
	pub const fn of(byte: u8) -> Option<Self> {
		match byte {
			b'D' => Some(Self::Index),
			b'M' => Some(Self::ReverseIndex),
			b'E' => Some(Self::NextLine),
			b'7' => Some(Self::SaveCursor),
			b'8' => Some(Self::RestoreCursor),
			b'c' => Some(Self::Reset),
			_ => None,
		}
	}
}

impl CsiSeq {
	/// Every sequence CSI introduces.
	pub const ALL: &'static [Self] = &[
		Self::InsertCharacters,
		Self::CursorUp,
		Self::CursorDown,
		Self::CursorForward,
		Self::CursorBack,
		Self::CursorNextLine,
		Self::CursorPreviousLine,
		Self::CursorColumn,
		Self::CursorPosition,
		Self::EraseInDisplay,
		Self::EraseInLine,
		Self::InsertLines,
		Self::DeleteLines,
		Self::DeleteCharacters,
		Self::ScrollUp,
		Self::ScrollDown,
		Self::EraseCharacters,
		Self::LinePosition,
		Self::SelectGraphicRendition,
		Self::SetScrollRegion,
		Self::SaveCursor,
		Self::RestoreCursor,
		Self::SetPrivateMode,
		Self::ResetPrivateMode,
	];

	/// The class a final byte selects, private introducer included.
	///
	/// `h` and `l` are a class only with the private introducer: the public
	/// modes they would otherwise set are not ones this emulator keeps, and
	/// handling them as though they were is how a mode nobody implements
	/// starts looking implemented.
	#[must_use]
	pub const fn of(final_byte: u8, private: bool) -> Option<Self> {
		match final_byte {
			b'@' => Some(Self::InsertCharacters),
			b'A' => Some(Self::CursorUp),
			b'B' => Some(Self::CursorDown),
			b'C' => Some(Self::CursorForward),
			b'D' => Some(Self::CursorBack),
			b'E' => Some(Self::CursorNextLine),
			b'F' => Some(Self::CursorPreviousLine),
			b'G' => Some(Self::CursorColumn),
			b'H' | b'f' => Some(Self::CursorPosition),
			b'J' => Some(Self::EraseInDisplay),
			b'K' => Some(Self::EraseInLine),
			b'L' => Some(Self::InsertLines),
			b'M' => Some(Self::DeleteLines),
			b'P' => Some(Self::DeleteCharacters),
			b'S' => Some(Self::ScrollUp),
			b'T' => Some(Self::ScrollDown),
			b'X' => Some(Self::EraseCharacters),
			b'd' => Some(Self::LinePosition),
			b'm' => Some(Self::SelectGraphicRendition),
			b'r' => Some(Self::SetScrollRegion),
			b's' => Some(Self::SaveCursor),
			b'u' => Some(Self::RestoreCursor),
			b'h' if private => Some(Self::SetPrivateMode),
			b'l' if private => Some(Self::ResetPrivateMode),
			_ => None,
		}
	}
}

impl OscSeq {
	/// Every sequence OSC introduces.
	pub const ALL: &'static [Self] = &[Self::WindowTitle];

	/// The class an OSC's leading number selects, if it selects one.
	#[must_use]
	pub fn of(kind: &str) -> Option<Self> {
		match kind {
			"0" | "2" => Some(Self::WindowTitle),
			_ => None,
		}
	}
}

impl SequenceClass {
	/// Every class the emulator reads, whichever introducer carries it.
	///
	/// Built from the per-introducer tables rather than restated, so a class
	/// added to one of them arrives here without being named twice.
	#[must_use]
	pub fn all() -> Vec<Self> {
		ControlChar::ALL
			.iter()
			.copied()
			.map(Self::Control)
			.chain(EscapeSeq::ALL.iter().copied().map(Self::Escape))
			.chain(CsiSeq::ALL.iter().copied().map(Self::Csi))
			.chain(OscSeq::ALL.iter().copied().map(Self::Osc))
			.collect()
	}
}
