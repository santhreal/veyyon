//! One tab's screen: the emulator its output is fed into, how far into the
//! output it has read, and how far the operator scrolled back.
//!
//! The store keeps a bounded tail of each stream and the app counts every
//! unit the host sent (a [`StreamMark`]), so a screen feeds only what arrived
//! since it last read, and replays the retained tail after a reset or when
//! it is first built.

use veyyon_desktop_model::text::terminal::{Cell, TerminalEmulator, TerminalSelection};

use crate::state::StreamMark;

/// The grid a screen opens at before the drawer has measured its box.
pub const DEFAULT_CELLS: (u16, u16) = (80, 24);

/// The fewest columns and rows the drawer asks a terminal to take.
pub const MIN_CELLS: (u16, u16) = (20, 4);

/// One tab's emulator and what it has read.
pub struct Screen {
	emulator: TerminalEmulator,
	/// The mark of the output the emulator holds.
	fed:      StreamMark,
	/// Rows scrolled back from the newest; 0 follows the output.
	scroll:   usize,
}

impl Screen {
	/// An empty screen of `cells` columns and rows.
	pub fn new(cells: (u16, u16)) -> Self {
		Self {
			emulator: TerminalEmulator::new(usize::from(cells.0), usize::from(cells.1)),
			fed:      StreamMark::default(),
			scroll:   0,
		}
	}

	/// The emulator, whose grid the drawer draws.
	pub const fn emulator(&self) -> &TerminalEmulator {
		&self.emulator
	}

	/// Feeds the bytes of a terminal's retained tail `data` the screen has not
	/// read, `mark` counting everything the host sent. Returns whether the
	/// screen changed.
	pub fn catch_up_bytes(&mut self, data: &[u8], mark: StreamMark) -> bool {
		let Some(fresh) = self.fresh(mark, data.len()) else {
			return false;
		};
		self.emulator.feed(&data[data.len() - fresh..]);
		self.settle(mark);
		true
	}

	/// Feeds the lines of a process's retained tail `lines` the screen has not
	/// read, `mark` counting every line the host sent. Returns whether the
	/// screen changed.
	pub fn catch_up_lines(&mut self, lines: &[String], mark: StreamMark) -> bool {
		let Some(fresh) = self.fresh(mark, lines.len()) else {
			return false;
		};
		for line in &lines[lines.len() - fresh..] {
			self.emulator.feed(line.as_bytes());
			self.emulator.feed(b"\r\n");
		}
		self.settle(mark);
		true
	}

	/// How many units at the end of a `held`-long tail are new under `mark`,
	/// resetting the emulator when the stream restarted; `None` when nothing
	/// is.
	fn fresh(&mut self, mark: StreamMark, held: usize) -> Option<usize> {
		if mark == self.fed {
			return None;
		}
		let unread = if mark.generation == self.fed.generation && mark.total >= self.fed.total {
			mark.total - self.fed.total
		} else {
			self.emulator.reset();
			mark.total
		};
		Some(usize::try_from(unread).map_or(held, |unread| unread.min(held)))
	}

	/// Records `mark` as read and keeps the scroll inside the history.
	fn settle(&mut self, mark: StreamMark) {
		self.fed = mark;
		self.scroll = self.scroll.min(self.emulator.grid().scrollback_len());
	}

	/// Re-breaks the screen at `cells`. Returns whether its size changed.
	pub fn resize(&mut self, cells: (u16, u16)) -> bool {
		let grid = self.emulator.grid();
		let (cols, rows) = (usize::from(cells.0), usize::from(cells.1));
		if (grid.cols, grid.rows) == (cols, rows) {
			return false;
		}
		self.emulator.resize(cols, rows);
		self.emulator.grid_mut().selection = None;
		self.scroll = self.scroll.min(self.emulator.grid().scrollback_len());
		true
	}

	/// Rows scrolled back from the newest.
	pub const fn scroll(&self) -> usize {
		self.scroll
	}

	/// Scrolls `rows` further back (positive) or forward (negative), inside
	/// the history. Returns whether the view moved.
	pub fn scroll_by(&mut self, rows: isize) -> bool {
		let limit = self.emulator.grid().scrollback_len();
		let next = self.scroll.saturating_add_signed(rows).min(limit);
		let moved = next != self.scroll;
		if moved {
			self.scroll = next;
			self.emulator.grid_mut().selection = None;
		}
		moved
	}

	/// Returns to the newest output. Returns whether the view moved.
	pub fn follow(&mut self) -> bool {
		self.scroll_by(-isize::try_from(self.scroll).unwrap_or(isize::MAX))
	}

	/// The rows on screen, newest last, `scroll` rows back from the newest.
	pub fn view(&self) -> impl Iterator<Item = &[Cell]> {
		let grid = self.emulator.grid();
		let back = if grid.alternate_screen {
			0
		} else {
			self.scroll
		};
		let first = grid.primary_lines.len().saturating_sub(grid.rows + back);
		(0..grid.rows).filter_map(move |row| {
			if grid.alternate_screen {
				grid.visible_row(row)
			} else {
				grid
					.primary_lines
					.get(first + row)
					.map(|line| line.cells.as_slice())
			}
		})
	}

	/// The selection, in the coordinates of [`Screen::view`].
	pub const fn selection(&self) -> Option<TerminalSelection> {
		self.emulator.grid().selection
	}

	/// Replaces the selection.
	pub const fn select(&mut self, selection: Option<TerminalSelection>) {
		self.emulator.grid_mut().selection = selection;
	}

	/// The selected text, rows joined by newlines and trailing blanks cut.
	pub fn selected_text(&self) -> Option<String> {
		let selection = self.selection()?;
		let rows: Vec<Vec<Cell>> = self.view().map(<[Cell]>::to_vec).collect();
		Some(selection.extract_text(&rows)).filter(|text| !text.is_empty())
	}

	/// Whether the program in the terminal asked for pasted text to be
	/// bracketed.
	pub const fn bracketed_paste(&self) -> bool {
		self.emulator.grid().bracketed_paste
	}

	/// Whether the program draws on the alternate screen, which keeps no
	/// history to scroll.
	pub const fn alternate(&self) -> bool {
		self.emulator.grid().alternate_screen
	}

	/// The title the program last set, empty when it set none.
	pub fn title(&self) -> &str {
		&self.emulator.grid().title
	}
}
