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

One window, one environment on screen: a 48px top bar (the environment
switcher and status) over a three-pane grid — the backlog on the left
(`--bl-w`, 220–420px, default 280), the orchestrator chat or a work item's
detail in the center, and work in progress on the right (`--wp-w`,
240–460px, default 300). Side panes resize on their handles and collapse
(⌘[ and ⌘]); below 1,100px the right pane becomes a drawer over the center.
`--content-col` (940px max) still caps the chat column inside the center
pane, and `--content-pad` scales gutters with the window. Chat is
Slack-shaped: avatar-gutter message rows, day dividers, grouped consecutive
messages — never bubbles.

## Signals

- Gold pulse = something is working: running work items, orchestrator turns
  (thinking dots, turn cards), and an environment provisioning.
- Emerald dot = ready or finished; red = error; gold halo = a question is
  waiting for an answer.
- Destructive actions arm on first click ("Confirm?") and never confirm via
  dialog.
