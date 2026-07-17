# How to read this book

This handbook has three kinds of chapters. Knowing which is which keeps the record accurate.

## Chapter status labels

Every chapter opens with a status line:

- **Built & verified**, the feature is shipped and works end to end.
- **In progress**, partially built; the chapter says exactly what works and what does not yet.
- **Spec — not shipped**, a mechanism with a clear target shape, documented with the failure mode it
  fixes. Spec chapters do not claim the work is done.

## Conventions

- **Provenance.** When a technique is adapted from prior art, the source and its license are named
  briefly and collected in [Acknowledgements](../acknowledgements.md). Veyyon adapts MIT/Apache
  code with attribution and studies proprietary code clean-room.
- **Numbers have sources.** A quoted measurement names who measured it. Veyyon's own numbers are
  marked as such; cited third-party numbers are marked as theirs.
- **The lever.** Each optimization names which thesis lever it moves, *edit format*, *control flow*,
  or a supporting concern (*cost*, *robustness*, *coherence*). If it doesn't move a lever, it doesn't
  belong.
