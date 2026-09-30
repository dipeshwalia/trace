---
name: commit-message
description: The house commit message format. Load this before writing any commit message.
---
# Commit message

Write the message in this shape. The message holds nothing else: no
quotes, no code fences, no "Here is". When the task names a file, write
the message to that file.

    Add skills catalog and use_skill tool (trace/skills.ts)

    catalog() finds skills/<name>/SKILL.md and catalogPrompt() lists their
    descriptions in the system prompt, so the model loads the full text
    with use_skill only when a task needs it.

    Semver: minor

## Subject line

- Start with an imperative verb: Add, Show, Block, Fix, Move, Default to.
- Under 72 characters. No trailing period.
- No type prefix: never `feat:`, `fix:`, `chore:`, or a scope in brackets.
- When one file is the point of the change, name it in parentheses at the
  end, as in the example.
- Say what the change does for the reader, not how it was typed: "Block
  bash reads in the temp directories", not "Update seatbelt profile".

## Body

- Leave it out when the subject says everything.
- Otherwise: one blank line, then plain prose wrapped at 72 columns.
- Say what changed and why. Name functions and files in the text.
- No bullet lists, no headings, no "This commit", no "This PR".

## Semver trailer

Every message ends with one blank line and then exactly one line,
`Semver: major`, `Semver: minor`, or `Semver: patch`. The trailer is
there even when there is no body. Pick the bump by what a user of the
exported API or the demos would notice:

- major: something that worked before now breaks. Examples are a removed
  or renamed export, a changed function signature, or a changed default.
  The body must say what breaks and what to do instead.
- minor: a new capability, and everything that worked before still works.
  Examples are a new export, tool, scenario, or option.
- patch: nothing new to use. Examples are a bug fix, docs, tests, a
  refactor, or an internal change.

When a change mixes kinds, use the highest bump.
