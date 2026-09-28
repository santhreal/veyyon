"""The bench corpus: one deterministic set of projects, threads and messages.

Both seeders read this module, so veyyon and T3 Code open the same text in the
same order. The corpus is three projects of ten threads each. Every thread
alternates user and assistant messages; `LONG_THREAD_KEY` is the long thread,
with `LONG_THREAD_ENTRIES` messages, and every other thread
has `SHORT_THREAD_ENTRIES`. The text is generated from `SEED`, so a rerun
seeds byte-identical files.
"""

from __future__ import annotations

import random
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

SEED = 20260928
PROJECTS = ("alpha", "beta", "gamma")
THREADS_PER_PROJECT = 10
LONG_THREAD_ENTRIES = 10_000
SHORT_THREAD_ENTRIES = 40
BASE_TIME = datetime(2026, 9, 1, 9, 0, 0, tzinfo=timezone.utc)

_WORDS = (
	"parser arena span token buffer render frame layout glyph cursor window sidebar thread message "
	"stream socket commit branch review module crate struct method closure vector string format "
	"number column record schema entity region motion spring damping velocity theme palette border "
	"shadow margin padding gutter scroll viewport anchor offset cache revision snapshot reducer store "
	"action intent event queue drawer panel composer transcript session workspace project editor "
	"terminal process signal channel future executor runtime allocation lifetime borrow slice"
).split()

_CODE_LINES = (
	"let offset = viewport.anchor + delta;",
	"for entry in store.entries() {",
	"    frame.paint(entry.bounds, theme.surface);",
	"}",
	"fn measure(text: &str, width: f32) -> Size {",
	"    shaper.layout(text, width).size()",
	"match event {",
	"    Event::Appended(rows) => list.splice(range, rows),",
	"    Event::Reset => list.reset(0),",
	"const CACHE_LIMIT: usize = 4096;",
	"let revision = snapshot.revision.max(pending);",
	"if damage.is_empty() { return; }",
)


@dataclass(frozen=True)
class Message:
	role: str  # "user" | "assistant"
	text: str
	at: datetime


@dataclass(frozen=True)
class Thread:
	key: str  # stable identifier, e.g. "alpha-00"
	project: str
	index: int
	title: str
	messages: tuple[Message, ...]

	@property
	def created_at(self) -> datetime:
		return self.messages[0].at

	@property
	def updated_at(self) -> datetime:
		return self.messages[-1].at


def _sentence(rng: random.Random) -> str:
	words = [rng.choice(_WORDS) for _ in range(rng.randint(6, 16))]
	words[0] = words[0].capitalize()
	return " ".join(words) + "."


def _paragraph(rng: random.Random, low: int, high: int) -> str:
	return " ".join(_sentence(rng) for _ in range(rng.randint(low, high)))


def _user_text(rng: random.Random) -> str:
	return _paragraph(rng, 1, 3)


def _assistant_text(rng: random.Random) -> str:
	parts = [_paragraph(rng, 2, 5)]
	shape = rng.random()
	if shape < 0.25:
		start = rng.randrange(len(_CODE_LINES) - 4)
		code = "\n".join(_CODE_LINES[start : start + rng.randint(2, 4)])
		parts.append(f"```rust\n{code}\n```")
		parts.append(_paragraph(rng, 1, 2))
	elif shape < 0.45:
		parts.append("\n".join(f"- {_sentence(rng)}" for _ in range(rng.randint(2, 4))))
	return "\n\n".join(parts)


def _title(rng: random.Random, project: str, index: int) -> str:
	words = [rng.choice(_WORDS) for _ in range(3)]
	return f"{project} {index:02d} {' '.join(words)}"


def build() -> list[Thread]:
	"""Every thread of the corpus, project by project, oldest first."""
	rng = random.Random(SEED)
	threads: list[Thread] = []
	clock = BASE_TIME
	for project in PROJECTS:
		for index in range(THREADS_PER_PROJECT):
			long = f"{project}-{index:02d}" == LONG_THREAD_KEY
			count = LONG_THREAD_ENTRIES if long else SHORT_THREAD_ENTRIES
			title = "long thread" if long else _title(rng, project, index)
			messages = []
			for n in range(count):
				role = "user" if n % 2 == 0 else "assistant"
				text = _user_text(rng) if role == "user" else _assistant_text(rng)
				messages.append(Message(role=role, text=text, at=clock))
				clock += timedelta(seconds=1)
			threads.append(
				Thread(
					key=f"{project}-{index:02d}",
					project=project,
					index=index,
					title=title,
					messages=tuple(messages),
				)
			)
			clock += timedelta(minutes=5)
	return threads


def iso_ms(at: datetime) -> str:
	"""`2026-09-01T09:00:00.000Z`, the timestamp spelling both apps write."""
	return at.strftime("%Y-%m-%dT%H:%M:%S.") + f"{at.microsecond // 1000:03d}Z"


def epoch_ms(at: datetime) -> int:
	return int(at.timestamp() * 1000)


# Both apps list threads newest first, so the probed threads are the three
# newest: the two short threads the switch probe alternates between are the
# first two rows, the long thread the third. None of them is below the fold.
LONG_THREAD_KEY = f"{PROJECTS[-1]}-{THREADS_PER_PROJECT - 3:02d}"
SWITCH_THREAD_KEYS = (f"{PROJECTS[-1]}-{THREADS_PER_PROJECT - 1:02d}", f"{PROJECTS[-1]}-{THREADS_PER_PROJECT - 2:02d}")
