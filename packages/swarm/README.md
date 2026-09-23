> **Origin.** This package is gimbal, imported into puck as `packages/swarm`.
> Source: https://github.com/namikmesic/gimbal at commit `291c825c152aabc442afdb5f127d52f410c0da6f` (2026-03-27).
> See the root `NOTICE.md` for the license note. The text below is the original gimbal README.

# gimbal

Multi-agent proxy for peer-to-peer Claude communication. A CLI tool that orchestrates a team of AI agents to collaboratively analyze codebases, propose improvements, and implement changes.

## What is gimbal?

gimbal is a command-line tool that runs a multi-agent system where specialized AI agents work together to understand and improve your codebase. The agents communicate through channels (similar to Slack/Discord), discuss approaches, and collaborate to complete tasks—all transparently so you can follow along.

**Key benefits:**

- **Separation of concerns**: Each agent has a specialized role (architecture, implementation, quality)
- **Built-in quality gates**: Changes require approval before implementation
- **Transparent collaboration**: Watch agents discuss and refine solutions in real-time
- **Human oversight**: Provide direction and feedback at any point

## Installation

### Global Installation (Recommended)

Install globally to use `gimbal` from anywhere:

```bash
npm install -g gimbal
```

### One-Off Usage

Run without installation using npx:

```bash
npx gimbal
```

### Building from Source

```bash
git clone <repository-url>
cd gimbal
npm install
npm run build
```

## Quick Start

### Interactive Mode

Simply run the command and respond to the prompt:

```bash
gimbal
```

You'll see:

```
[Direction] What should the agents focus on? (Enter for default):
```

Type your task (e.g., "Add user authentication" or "Optimize database queries") and press Enter. The agents will collaborate to complete your request.

### Direct Command

Skip the interactive prompt by providing a direction directly:

```bash
gimbal --direction "Refactor the authentication module"
```

### Custom Working Directory

Run agents in a specific directory:

```bash
gimbal --dir /path/to/your/project --direction "Review error handling"
```

## CLI Reference

### `--dir <path>`

Specify the working directory for the agents. Defaults to the current directory.

**Examples:**

```bash
gimbal --dir ~/my-project
gimbal --dir ./packages/api
gimbal --dir /absolute/path/to/code
```

You can also set the working directory via environment variable:

```bash
export GIMBAL_WORKDIR=/path/to/project
gimbal
```

### `--direction <text>`

Provide the initial task direction for the agents, bypassing the interactive prompt.

**Examples:**

```bash
gimbal --direction "Add comprehensive logging"
gimbal --direction "Fix the bug in user registration"
gimbal --direction "Refactor the database layer to use connection pooling"
```

### `--help` / `-h`

Display help information and usage examples.

```bash
gimbal --help
```

### `--version` / `-v`

Show the current version of gimbal.

```bash
gimbal --version
```

## How It Works

### The Agent Team

gimbal orchestrates four specialized agents, each with distinct responsibilities:

**Architect** (Claude Sonnet)

- Explores and understands the codebase structure
- Identifies problems and proposes solutions
- Defines acceptance criteria for changes
- Tools: Read, Glob, Grep (exploration only, no modifications)

**Developer** (Claude Sonnet)

- Writes test plans to verify acceptance criteria
- Implements approved changes
- Runs tests and reports results
- Tools: Read, Edit, Write, Bash, Glob, Grep (full code access)

**Staff Engineer** (Claude Opus)

- Reviews and approves/rejects proposals
- Reviews and approves/rejects test plans
- Verifies implementation meets criteria
- Updates CHANGELOG and facilitates retrospectives
- Tools: Read, Write, Bash, Glob, Grep (documentation and git)

**Knowledge Coordinator** (Claude Sonnet)

- Builds understanding of the entire codebase
- Answers questions from other agents about code structure
- Provides file locations, line numbers, and code snippets
- Tools: Read, Glob, Grep (exploration only)

### Communication Channels

Agents communicate through pub/sub channels:

**#planning**

- Proposals and architectural discussions
- Acceptance criteria negotiations
- Approval/rejection decisions
- Retrospective discussions

**#implementation**

- Code change discussions
- Test plan details
- Test results and evidence
- Implementation questions

**#knowledge**

- Codebase questions from any agent
- Quick answers about file locations and code structure

### The Workflow

gimbal follows a structured 6-phase workflow with quality gates:

```
1. PROPOSAL
   └─ Architect explores codebase, proposes improvement
   └─ Defines: Problem, Solution, Acceptance Criteria

2. PROPOSAL REVIEW
   └─ Staff Engineer reviews proposal
   └─ Approves, rejects, or requests changes

3. TEST PLANNING
   └─ Developer writes test plan
   └─ Specifies how to verify each acceptance criterion

4. TEST REVIEW
   └─ Staff Engineer reviews test plan
   └─ Ensures coverage of acceptance criteria

5. IMPLEMENTATION
   └─ Developer implements changes
   └─ Runs tests, reports results with evidence

6. DOCUMENTATION
   └─ Staff verifies tests passed
   └─ Updates CHANGELOG.md
   └─ Facilitates retrospective in #planning
   └─ Documents learnings in RETROSPECTIVE.md
```

**Quality Gates**: Each review phase is a checkpoint. Work cannot proceed until the Staff Engineer approves. This prevents half-baked solutions from being implemented.

### Providing Direction

You can provide direction at any time during execution:

- **Initial direction**: Given at startup (interactive or via `--direction`)
- **Mid-session direction**: Type new guidance while agents are working
- **After sign-off**: When all agents complete their work, you're prompted for next steps

When all agents sign off, you can:

- Enter new direction to continue with existing context
- Type `fresh` to reset all agent contexts and start over
- Type `q` to quit

## Example Session

```
$ gimbal --dir ./my-api --direction "Add request validation"

=== Self-Improving Agent Demo ===

Agents: architect, developer, staff, knowledge
Working directory: /Users/me/my-api
All agents subscribed to #planning and #implementation channels

[Demo] Initializing knowledge agent...
[Knowledge agent initialized]

[Demo] Starting self-improvement session with Architect...

────────────────────────────────────────────────────────────
[architect -> #planning]
I've analyzed the codebase. Here's my proposal:

## Problem
API endpoints accept unvalidated input, risking malformed data...

## Solution
Add Zod schema validation middleware...

## Acceptance Criteria
1. All POST/PUT endpoints validate request bodies
2. Invalid requests return 400 with error details
3. Existing tests continue to pass
────────────────────────────────────────────────────────────

────────────────────────────────────────────────────────────
[staff -> #planning]
Good proposal. The acceptance criteria are clear and testable.
APPROVED. Developer, please proceed with test planning.
────────────────────────────────────────────────────────────

... (agents continue collaborating) ...
```

## Configuration

### Agent Tool Permissions

Each agent has specific tools available, configured in `src/index.ts`:

| Agent     | Read | Edit | Write | Bash | Glob | Grep |
|-----------|------|------|-------|------|------|------|
| architect |  ✓   |      |       |      |  ✓   |  ✓   |
| developer |  ✓   |  ✓   |   ✓   |  ✓   |  ✓   |  ✓   |
| staff     |  ✓   |      |   ✓   |  ✓   |  ✓   |  ✓   |
| knowledge |  ✓   |      |       |      |  ✓   |  ✓   |

### Model Selection

Agents use different Claude models based on their needs:

- **Architect, Developer, Knowledge**: Claude Sonnet (fast, capable)
- **Staff Engineer**: Claude Opus (senior review decisions)

## Development

### Build from Source

```bash
git clone <repository-url>
cd gimbal
npm install
npm run build
```

### Run in Development Mode

```bash
npm run dev
```

### Type Checking

Verify TypeScript compiles without errors:

```bash
npx tsc --noEmit
```

### Testing

Run the test suite:

```bash
npm test
```

For comprehensive verification steps, see RETROSPECTIVE.md.

## Documentation

- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** - Technical architecture and implementation details
- **[CLAUDE.md](CLAUDE.md)** - AI development guide for contributing with Claude Code
- **[CHANGELOG.md](CHANGELOG.md)** - Version history and release notes
- **[RETROSPECTIVE.md](RETROSPECTIVE.md)** - Team learnings and process improvements

## License

MIT
