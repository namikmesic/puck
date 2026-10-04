# Puck

Puck runs coding-agent harnesses inside containers on machines the user controls, and drives them to deliver tickets as merged pull requests. This glossary is the one vocabulary for the product, the code, and the docs.

## Language

### The platform

**Puck**:
The desktop app the user runs. Not the GitHub App, which is "the Puck GitHub App".
_Avoid_: the app (when the daemon or the runner could be meant), Puck app (ambiguous with the GitHub App)

**Puck server**:
The hosted service that holds the user's Puck session, the GitHub App identity, and the runner registry.

**Runner**:
A machine's installed Puck host process that creates and hosts environments. "This Mac" is the runner on the user's own machine.
_Avoid_: host, node, environment provider

**Runner release**:
A signed, versioned package of the runner that a runner can install itself from.
_Avoid_: runner package

**Daemon**:
The process that runs as an environment's main process, owns all of that environment's work and state, and drives its harnesses. Its program is `puckd`.
_Avoid_: agent (the daemon is not an agent), server (reserved for the Puck server)

**Harness**:
A coding-agent runtime that Puck can run: Claude Code or Codex. A harness is one kind of provider.
_Avoid_: CLI, SDK, model (a model is one of a harness's choices)

**Provider**:
Something the user signs in to or installs so Puck can use it. Provider kinds are harnesses, runners, and integrations such as GitHub.

**Adapter**:
The daemon's driver for one harness, translating that harness's output into harness events.
_Avoid_: harness (when the driver is meant), plugin

### Definitions

**Puck home**:
The user's Git repository of agent and environment definitions. Puck reads it at a pin.
_Avoid_: config repo, configuration repository, definition library (that is the code that reads a home)

**Pin**:
A fixed point in the Puck home: a tag, a branch, or a commit, resolved to one commit. The UI shows it as a version.
_Avoid_: ref (a ref is a listable tag or branch before it is chosen), version (in code and docs; UI copy only)

**Agent definition**:
A definition of one agent: its harness, model, effort, instructions, and options.

**Agent**:
A named role an environment can run: an agent definition as assigned in an environment definition. An agent is not a session; a session runs as an agent.
_Avoid_: bot, assistant, worker (a worker is a session kind)

**Environment definition**:
A definition of one environment: its image, repositories, orchestrator, agent assignments with their parallel limits, policies, and definition of done.

**Options**:
An agent's sparse overrides of its harness's schema-defined settings. Only overrides are written; the harness supplies the defaults.
_Avoid_: settings (reserved for Puck's own Settings window), config

**Effort**:
How hard an agent's model is asked to think, chosen from the harness's levels.
_Avoid_: thinking level, reasoning effort (harness-specific names for the same thing)

**Policy**:
A rule in an environment definition that decides what the orchestrator may do alone and what is reserved to the user: asks, publishing, merging, follow-ups.

### Environments

**Environment**:
One running container and its two volumes, created from an environment definition at a pin on a runner. Its state is the daemon's, not Docker's.
_Avoid_: instance, env, container (a container is the Docker object inside an environment), sandbox

**Attach**:
Puck's live connection to one environment's daemon, replayed from the last event Puck saw.

**Ready**:
The environment state in which its daemon reports it can take work. Not the same as the container running.

**Provisioning**:
The daemon's boot work that brings a fresh or updated environment to ready: packages at their pins, repositories, users, and permissions.

**Update**:
Applying a newer pin of the Puck home to a running environment. Its class says how much of the environment must be redone.

**Mirror**:
The environment's root-owned bare clone of a repository, through which commits leave the workspace. Only this meaning; credentials are *synced*, not mirrored.

**Workspace**:
The environment's writable volume where the working clone and the ticket worktrees live.

**Worktree**:
A ticket's own checkout in the workspace, on the ticket's branch.

**Publish**:
Moving a ticket's commits from its worktree through the mirror to GitHub and opening or updating its pull request.
_Avoid_: push (one part of publishing), ship

### Sessions

**Session**:
One harness conversation inside an environment, running as one agent. Its kinds are orchestrator and worker. Not the user's Puck session with the Puck server.
_Avoid_: conversation, thread, chat

**Orchestrator**:
The environment's one long-lived session. It files, plans, and assigns tickets, decides within the definition, and asks the user only what policy reserves.
_Avoid_: lead, manager, main agent

**Worker**:
A session bound to one ticket's implement step.
_Avoid_: agent (when the session is meant), implementer (an agent's name, not a kind)

**Reviewer**:
An agent on a ticket's panel, reading one commit in its own checkout as a user that cannot write the branch.

**Sub-agent**:
A child task a harness spawns inside one session. Not a worker, not a session.

**Turn**:
One run of a session from a prompt to the harness's turn end. An auto turn is one the daemon started without the user.
_Avoid_: kick (the act of starting a turn), run

**Notice**:
A line the daemon writes to the orchestrator, delivered in its next turn. A waking notice opens a wake window; the others ride along.

**Wake window**:
The short delay after a waking notice in which more notices are batched before the orchestrator's auto turn starts. Auto-wake is the environment setting that allows them.

**Ask**:
A question an agent raises mid-turn that must be answered before it continues. A worker's ask is routed to the orchestrator or the user by policy.
_Avoid_: question, prompt (reserved for what starts a turn), needs-input (a ticket state, caused by an ask)

**Escalate**:
The orchestrator passing a worker's ask, or a decision, to the user.

### Tickets

**Ticket**:
One unit of work on the board, with a human id `W-<n>`, a worktree, a branch, and a workflow. Its status is todo, in progress, or done.
_Avoid_: work item, item, task (a task is a step within a ticket), issue (a GitHub issue)

**Board**:
The three columns, Todo, In progress, and Done, that show every ticket of an environment.
_Avoid_: backlog (only the Todo column's contents, never the whole board or the ticket store)

**Card**:
The board's rendering of one ticket. A card is never a step, and a step never gets a card.

**Outcome**:
How a done ticket finished: merged, accepted, failed, or cancelled.

**Stage**:
The kind of a ticket's current step while it is in progress. Only this meaning for tickets; the runner's and the daemon's boot stages are "environment stages".

**Workflow**:
A ticket's append-only list of steps grouped in rounds, from the environment's definition of done or the ticket's override.

**Step**:
One stage of a ticket's workflow: decompose, implement, checks, review, publish, CI, or merge. A step is never a board card.
_Avoid_: task (reserved for an implement step planned by decomposition), job (a CI job)

**Round**:
One pass of a ticket's workflow over one commit. A fix round is the round opened when a gate is blocked.

**Attempt**:
One run of a logical step. A retry, rerun, or restart creates a new attempt of the same step.

**Definition of done**:
The environment's checks, panel, and merge policy that a ticket's workflow runs after implementation.
_Avoid_: pipeline (the actor name of the machinery that runs it), DoD

**Checks**:
The commands the definition of done runs on a ticket's commit before the panel.
_Avoid_: tests, CI (CI is GitHub's checks on the published pull request)

**Panel**:
The reviewers of a definition of done, each on the same commit, from different model families.
_Avoid_: review panel (redundant), reviewers (the people or agents; the panel is the configured set)

**Review**:
One reviewer's look at one commit of one ticket in one round, with a verdict. Checks and CI failures are recorded as reviews too. A review on GitHub is a "pull request review".

**Verdict**:
A review's conclusion: merge, block, or inconclusive.

**Finding**:
A first-class record of one thing a review observed, with severity, category, status, and evidence, and a lifecycle of its own.
_Avoid_: comment, issue, violation

**Gate**:
The settlement of a round: clear when no open blocking finding remains, blocked otherwise. A clear gate publishes, waits for CI, then merges.

**Decision**:
An ask with a closed set of options that policy reserves to the user or routes to the orchestrator, such as merge, security, or a failed publish.

**Merge policy**:
Whether a clear gate merges automatically or asks. Security-sensitive and destructive findings always ask.

**Follow-up**:
A ticket created at merge to hold the findings left open on the merged ticket.

**Slot**:
One unit of an agent's parallel limit, held by a running implement or review step. The UI shows slots as capacity.
_Avoid_: seat, worker count

### Records

**Journal**:
The daemon's append-only delivery log that every ticket, workflow, review, and finding change is written to first. Projections derive from it; it is never rewritten.
_Avoid_: ledger (its applier, not the log), write-ahead log

**Event log**:
The daemon's sequenced log of what Puck shows, replayed to Puck from a cursor on attach.

**Transcript**:
The append-only record of one session's turns, in Puck's own format.
_Avoid_: conversation, thread, chat log, history

**Harness event**:
One unit of a harness's output as the adapter reports it: text, thinking, a tool call, an ask. Always qualified; "event" alone is ambiguous across daemon, runner, journal, and server events.

**Cursor**:
Puck's position in an environment's event log, kept so an attach resumes without gaps.

**Snapshot**:
The daemon's full current state, fetched when a cursor cannot be resumed. Only this meaning; the policy a round was settled under is its "policy record".

### Credentials

**Credential**:
A harness's sign-in file, synced from Puck into an environment so the harness can run as the user.
_Avoid_: token (the value inside it), mirror

**OAuth account**:
Puck's host-side sign-in to one harness provider, whose sign-out fences every token exchange in flight.

**Grant**:
The GitHub installation token the daemon holds for one repository owner, scoped by the Puck GitHub App's permissions.
_Avoid_: GitHub credential, token

**Secret**:
A value an environment definition names that the user supplies and the daemon delivers into the container. Not a credential and not a grant.
