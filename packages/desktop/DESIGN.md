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
| `--gold`          | `#D4AF37`              | Live activity: thinking dots, running   |
| `--charcoal`      | `#1C1C1A`              | Body text                               |
| `--gray`          | `#6B6B66`              | Secondary text                          |
| `--gray-light`    | `#78786F`              | Timestamps, hints (AA on cream)         |
| `--red`           | `#A03C32`              | Errors, destructive, stop               |

Hairlines are emerald at low alpha (`--line`, `--line-soft`) rather than
neutral gray — everything on the page leans slightly emerald.

## Type

- UI: system stack (`-apple-system`, SF Pro)
- Display (logo, avatar glyphs): `Playfair Display` / `Didot` / Georgia
- Mono (tool summaries, stats, timestamps): `ui-monospace` / SF Mono

## Layout

One shared column variable (`--content-col`, 940px max) aligns the thread,
composer, and settings pages; `--content-pad` scales gutters with the
window. Chat is Slack-shaped: avatar-gutter message rows, day dividers,
grouped consecutive messages — never bubbles.

## Signals

- Gold pulse = an agent is working (thinking dots, turn cards, sidebar).
- Emerald dot = finished; red = error; gold halo = waiting on your answer.
- Destructive actions arm on first click ("Confirm?") and never confirm via
  dialog.
