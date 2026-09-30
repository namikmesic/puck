# Puck Design Tokens

> Visual language only — architecture and contributor guidance live in
> `AGENTS.md` and the module header comments.

Puck's visual language: a cream canvas with deep emerald as the working
accent and gold reserved for "agent is doing something" signals. (The
palette's origin is a leftover luxury-goods design doc that shipped with the
repo's first commit — the colors earned their keep; the bag spa did not.)

## Color

| Token             | Value                  | Use                                     |
| ----------------- | ---------------------- | --------------------------------------- |
| `--cream`         | `#FFFDF7`              | App canvas                              |
| `--white`         | `#FFFFFF`              | Cards, composer, code blocks            |
| `--emerald`       | `#2E5E4E`              | Primary accent, agent avatars, actions  |
| `--emerald-light` | `#3A7A66`              | Hover states                            |
| `--emerald-dark`  | `#1E3E34`              | Active/emphasis text                    |
| `--emerald-tint`  | `rgba(46,94,78,0.07)`  | Hover fills, chips                      |
| `--emerald-edge`  | `rgba(46,94,78,0.18)`  | Signed-in harness chip border           |
| `--gold`          | `#D4AF37`              | Live activity: thinking dots, running   |
| `--gold-muted`    | `rgba(212,175,55,0.15)`| Gold chip fills, the waiting halo       |
| `--gold-ink`      | `#6F5716`              | Text on gold fills (gold is never text) |
| `--charcoal`      | `#1C1C1A`              | Body text                               |
| `--gray`          | `#5F5F59`              | Secondary text                          |
| `--gray-light`    | `#6F6F66`              | Timestamps, hints (AA on cream)         |
| `--red`           | `#A03C32`              | Errors, destructive, stop               |

Hairlines are emerald at low alpha (`--line`, `--line-soft`) rather than
neutral gray — everything on the page leans slightly emerald. Spacing sits
on a 4px grid (`--space-*`); radii (`--radius-*`), shadows (`--shadow-*`)
and the type scale (`--text-*`) are tokens in `shell.css` too.

## Type

- UI: system stack (`-apple-system`, SF Pro)
- Display (logo, avatar glyphs): `Playfair Display` / `Didot` / Georgia
- Mono (code, and identifiers in a code context: branches, SHAs, the
  commands and paths in tool calls): `ui-monospace` / SF Mono. Metadata,
  ids like `W-12`, counts and times are UI font with tabular figures.
- One clock ("8:42 PM"), one currency to the cent ("$0.27"), one duration
  style ("4.2s", "1m 05s"): `src/renderer/format.ts`.

## Layout

One window, one environment on screen: a 48px top bar (the environment
switcher and status on the left, the Chat | Board switch centered) over
one of two views. Chat is the orchestrator conversation in a centered
reading column (`--chat-col`, 760px) with the composer pinned under it;
it is Slack-shaped: 28px avatar-gutter message rows, day dividers,
grouped consecutive messages — never bubbles. Board is three columns,
Todo, In progress and Done; each column flexes, and the board scrolls
sideways when they do not fit. Done filters by outcome, and failed and
cancelled items stay in that column behind the filter. An item's detail
is a side sheet (`clamp(520px, 50vw, 780px)`) over either view.

## Signals

- Gold pulse = something is working: running work items, orchestrator turns
  (thinking dots, turn cards), and an environment provisioning.
- Emerald dot = ready or finished; red = error; gold halo = a question is
  waiting for an answer.
- Destructive actions arm on first click ("Confirm?") and never confirm via
  dialog.
