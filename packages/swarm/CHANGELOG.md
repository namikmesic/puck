# Changelog

All notable changes to the gimbal-experiment will be documented in this file.

## [Unreleased]

### Added - 2026-02-02

#### Interactive Permission Callback System
- Replaced `bypassPermissions` mode with user-controlled permission gates
- Agents now prompt for user approval before executing Bash, Edit, Write operations
- Auto-approves safe operations: messaging tools, Read, Glob, Grep, external MCP tools
- Permission prompts display tool name, formatted input (truncated at 500 chars), and reason
- Timeout behavior: denies after AbortSignal (fail-closed for security)
- Session persistence maintained across permission denials
- Commit: `f0fed9a`

**Technical Details:**
- Modified file: `src/agent-lifecycle.ts` (+121 lines)
- Changed `permissionMode` from `"bypassPermissions"` to `"default"`
- Added `canUseTool` callback to `query()` options
- New methods: `truncateInput()`, `formatToolInput()`, `promptForPermission()`
- Uses Node's built-in `readline` module for blocking prompts
- No new dependencies

**Auto-Approval Logic:**
- Messaging tools: `mcp__messaging__*` (8 tools)
- Read-only tools: `Read`, `Glob`, `Grep`
- External MCP tools: Pattern match `mcp__*` excluding `mcp__messaging__*`

**Permission Required:**
- `Bash` (shows command and description)
- `Edit` (shows file path, old/new strings)
- `Write` (shows file path, content preview)
- Other modification tools: `NotebookEdit`, `TodoWrite`, `Task`

**Prompt Format:**
```
⚠️  PERMISSION REQUEST
Tool: Bash
Command: git status
Description: Show working tree status
[A]llow / [D]eny: _
```

**Verification:**
- 19/19 auto-approval logic unit tests passed
- All 6 acceptance criteria verified via code review
- TypeScript compilation passes
- Build succeeds on committed code
- CLI works on committed code

**Problem Solved:**
The original `bypassPermissions` mode automatically approved all tool calls without user oversight. This was:
- Security risk: Agents could execute any command without user awareness
- Incompatible: Some Claude environments don't allow bypassing permissions
- Non-transparent: Users had no visibility into tool invocations

**Decision Rationale:**
- Auto-approve scope: Balance security with usability (read-only = safe)
- Timeout behavior: Fail-closed (deny on timeout) is the secure default
- Implementation: Inline in `agent-lifecycle.ts` vs. separate file (simpler for ~90 lines)
- Input truncation: 500 chars prevents overwhelming terminal prompts

**Collaborative Design Process:**
- Architect researched SDK interface and proposed comprehensive solution
- Staff challenged auto-approve scope and timeout behavior, gave conditional approval
- Knowledge provided technical references (line numbers, SDK signatures)
- Developer wrote 13-test functional test plan + 19 auto-approval unit tests
- Staff enforced scope (excluded package-lock.json changes)
- Post-commit verification by Staff confirmed code matches specification

**Key Principle Reinforced:**
> "Security defaults matter - fail-closed is safer than fail-open"

---

#### Agent Error Recovery and Visibility
- Added automatic error broadcasting to `#errors` channel when agents fail during message processing
- Staff Engineer now auto-subscribed to `#errors` channel for immediate visibility of agent failures
- Error messages include: agent ID, error message, and ISO timestamp for human readability
- Commit: `77cdb37`

**Technical Details:**
- Modified files: `src/agent-lifecycle.ts`, `src/index.ts`
- Total: 9 lines added (6 in agent-lifecycle.ts, 3 in index.ts)
- No new dependencies
- Uses existing `publishToChannel()` infrastructure

**Error Message Format:**
```
[ERROR from {agentId}] {error.message} (occurred at {ISO timestamp})
```
Example: `[ERROR from developer] timeout exceeded (occurred at 2026-02-02T15:30:45.123Z)`

**Implementation Details:**
- Error broadcast happens in catch block: `console.error → state="ready" → broadcast → throw`
- Existing error handling behavior fully preserved (console logging, state transition, re-throw)
- Broadcast is non-blocking; if it fails, error still propagates correctly
- Staff auto-subscription placed with other channel subscriptions in initialization

**Verification:**
- All 5 acceptance criteria verified in committed code
- Post-commit verification: `git show` confirmed changes, rebuild passed, smoke test passed
- Staff caught scope creep (vitest addition in package.json) - reverted before commit

**Problem Solved:**
Agent failures were invisible to the team, causing workflow deadlocks. When an agent encountered an error:
- Error was logged to console only
- Other agents had no visibility
- Workflows would hang waiting for the failed agent
- Human operators received no clear notification

**Decision Rationale:**
- Minimal solution: Uses existing channel infrastructure
- Staff auto-subscription: Quality gate (Staff) gets immediate error visibility
- ISO timestamp: Human-readable, includes timezone
- Broadcast after state change: Agent in stable state before I/O operation (safer)

**Collaborative Design Process:**
- Architect identified real pain point and proposed minimal solution
- Staff validated problem in code, pushed for clarity on implementation details
- Knowledge verified all code references and technical feasibility
- Developer wrote comprehensive test plan incorporating RETROSPECTIVE.md lessons
- Staff enforced scope discipline (caught unrelated package.json changes)
- Team aligned on broadcast timing through explicit discussion

**Key Principle Reinforced:**
> "Error visibility is critical for multi-agent coordination - silent failures cause deadlocks"

---

#### README.md User Documentation
- Created comprehensive README.md for user-facing documentation
- Installation instructions for both `npm install -g` and `npx` usage
- CLI reference documenting all flags: `--dir`, `--direction`, `--help`/`-h`, `--version`/`-v`
- Quick start guide with interactive mode walkthrough
- Brief agent system overview (kept minimal per team guidance)
- Links to CLAUDE.md, CHANGELOG.md, RETROSPECTIVE.md
- Commit: `948be96`

**Technical Details:**
- Single new file: README.md (135 lines)
- No code changes, documentation only
- Zero regression risk

**Verification:**
- All 8 acceptance criteria verified with evidence
- CLI flags cross-checked against src/cli.ts source
- Package.json metadata alignment confirmed
- All documentation links verified to exist
- Staff caught unrelated package.json changes in working directory; reverted before commit

**Decision Rationale:**
- Problem: CLI tool with zero user-facing documentation
- Solution: Minimal README covering install, usage, and CLI reference
- Staff enforced scope: Agent descriptions kept to ~300 chars, deferred troubleshooting section
- Team collaboration: Knowledge provided source references, Architect added interactive workflow section

**Key Principle Reinforced:**
> "User documentation is not optional for distributed tools"

---

#### CLI Interface for gimbal
- Converted gimbal into a proper CLI tool installable globally via `npm install -g`
- Added command-line flags: `--dir`, `--direction`, `--help`, `--version`
- Refactored `src/index.ts` to export `createAgentProxy()` function for programmatic use
- Created `src/cli.ts` as CLI entry point with argument parsing and validation
- Added `bin` field to `package.json` for global command registration
- Commits: `fcef2c1`, `b2c46fc` (fix)

**Technical Details:**
- Modified files: `src/index.ts`, `src/cli.ts` (new), `package.json`
- No new dependencies - uses built-in `process.argv` parsing
- Working directory precedence: CLI `--dir` flag → `AGENT_PROXY_WORKDIR` env var → `process.cwd()`
- Shebang preserved by TypeScript compiler (no build script hacks needed)
- Backward compatible: `npm run dev` still works

**CLI Usage:**
```bash
gimbal                              # Interactive mode
gimbal --dir ./my-project           # Specify working directory
gimbal --direction "Fix auth bug"   # Pre-set direction (skips prompt)
gimbal --help                       # Show usage
gimbal --version                    # Show version
```

**Verification:**
- TypeScript compilation passes (`npm run build`)
- Shebang preserved in `dist/cli.js`
- All CLI flags tested and working
- Error handling for invalid directories verified
- Global installation via `npm link` tested
- `npm run dev` backward compatibility confirmed

**Decision Rationale:**
- Problem: Running via `npm run dev` was awkward for a tool meant to be used repeatedly
- Solution: Proper CLI with standard conventions
- Staff challenged scope: Kept minimal (no `--quiet` flag, basic validation only)
- Team converged: Four flags with no external dependencies

**Collaborative Design Process:**
- Architect identified pain point and proposed CLI conversion
- Staff pushed for minimal scope
- Developer wrote comprehensive test plan before implementation
- Knowledge Coordinator provided technical guidance
- Staff verified tests independently before approving commit

**Key Principle Reinforced:**
> "Build the minimal thing first" - No CLI libraries (commander/yargs), just process.argv

---

#### Knowledge Coordinator Agent (Experimental)
- Added single knowledge coordinator agent for codebase Q&A
- Agent pre-reads all src/*.ts files on initialization
- Subscribes to #knowledge channel for queries from other agents
- Responds with file paths, line numbers, and code snippets
- Commit: `2070d75`

**Technical Details:**
- Modified files: `src/index.ts` only (50 lines added)
- New agent config: id="knowledge", tools=["Read", "Glob", "Grep"], model="sonnet"
- Initialization: Explicit prompt via `sendInitialPrompt()` to read all source files
- Channel: Auto-subscribed to #knowledge for query/response communication

**Verification:**
- TypeScript compilation passes (`npx tsc --noEmit`)
- Code review by Architect and Staff
- No breaking changes to existing agents (architect, developer, staff)
- Follows existing patterns (same config structure, same initialization approach)

**Known Limitations (Acceptable for MVP):**
- Stale knowledge: Agent reads files once on startup; restart required to refresh
- Startup latency: Adds ~5-10 seconds while agent reads files
- Context limits: May hit limits if codebase grows beyond ~20 files

**Decision Rationale:**
- Original proposal: Per-file agent spawning with dynamic lifecycle management
- Staff challenged: "Is this solving a REAL pain point for 5 files?"
- Team converged: Simplified to single knowledge agent MVP
- Experiment mindset: Evaluate usefulness after 1 week; remove if not valuable

**Collaborative Design Process:**
- Architect proposed ambitious per-file agent architecture
- Staff pushed back on complexity for a 5-file codebase
- Developer supported simpler approach with concrete use case (parallelization)
- Architect accepted feedback and revised to minimal MVP
- Staff approved with explicit conditions: experiment, sunset clause, easy removal
- Result: 50 lines of code instead of 300+ lines of infrastructure

**Key Principle Reinforced:**
> "Build the minimal thing first, add complexity only when proven necessary"

**Expected Benefits:**
- Parallelization: Other agents can query codebase without interrupting implementation
- Separation of concerns: Knowledge agent holds "codebase state", Developer holds "task state"
- Proof of concept: Validates knowledge agent pattern before building for scale

**Evaluation Criteria (1 week):**
- Was #knowledge channel used?
- Did it save time/context switches?
- Were answers accurate?
- If no value demonstrated, remove the feature.

---

### Changed - 2026-02-02

#### Tool Permissions Extraction
- Extracted hardcoded tool permissions from `agent-session.ts` to declarative agent configuration
- Added `ToolName` union type for compile-time validation of tool names
- Added optional `tools` field to `AgentConfig` interface
- Simplified permission logic from 8 lines of nested conditionals to 1 line: `this.config.tools || []`
- Made agent capabilities explicit and visible at configuration level
- Commit: `c3e95ca`

**Technical Details:**
- Modified files: `src/types.ts`, `src/agent-session.ts`, `src/index.ts`
- Code reduction: 38 deletions, 111 insertions (net: +73 lines, but removed conditional complexity)
- Type safety: `ToolName = "Read" | "Edit" | "Write" | "Bash" | "Glob" | "Grep"` provides autocomplete and compile-time validation
- Default behavior: `tools || []` treats undefined and empty array identically (safe default)
- **Zero behavior changes:** Pure refactoring - all agents maintain exact same tool access

**Decision Rationale:**
- Original problem: Tool permissions hardcoded in runtime logic made system less modular
- Architect proposed extracting to config for better separation of concerns
- Team discussion addressed validation strategy and type safety
- Consensus: Add compile-time type safety, skip runtime validation (trust config)
- Staff enforced scope discipline: "One thing at a time - no validation infrastructure"

**Collaborative Design Process:**
- Architect proposed extraction with detailed benefits analysis
- Staff raised questions about validation and default behavior
- Developer confirmed feasibility and suggested type safety approach
- Critic validated quality and approved with suggestions
- Staff made final call: type safety yes, runtime validation no (scope control)
- Result: Simple refactoring with compile-time safety, no scope creep

**Key Principle Reinforced:**
> "Configuration over code - make system capabilities explicit and declarative"

**Benefits Achieved:**
- ✅ More intuitive: Tool access visible in config, not buried in conditionals
- ✅ More modular: Adding new agents requires no code changes
- ✅ Better separation: Configuration vs. runtime logic cleanly separated
- ✅ Type-safe: Compile-time validation prevents typos

This refactoring demonstrates how proper separation of concerns improves both code clarity and system extensibility.

---

### Added - 2026-02-01

#### Message Threading - Phase 1
- Added reply context display in message formatter
- Messages now show `(replying to msg_X)` when they reference previous messages
- Enables agents to track conversation threads and understand message context
- **Implementation note:** This surfaces existing infrastructure that was previously invisible - the `replyTo` field has always been supported by the messaging system, but wasn't displayed to agents
- Minimal implementation: displays message ID only, no content cache or lookup
- Commit: `5d20499`

**Decision Rationale:**
- Started with proposal for 50-message cache with content previews
- Team discussion (Staff, Critic, Architect) led to simplified approach
- Consensus: "Start simple, prove value before adding complexity"
- Phase 2 (message preview cache) deferred pending real usage data

**Collaborative Design Process:**
- Architect proposed initial solution with caching
- Critic challenged complexity vs. value proposition
- Staff enforced scope discipline and minimal approach
- Architect revised to simpler solution based on feedback
- Result: Better solution through consensus-driven design

**Key Principle Extracted:**
> "Build the minimal thing first, add complexity only when proven necessary"

This pattern of proposal → critique → revision → consensus serves as a model for future engineering decisions.

---

## Notes

This changelog follows the principles of:
- Documenting not just *what* changed, but *why*
- Capturing the collaborative decision-making process
- Extracting reusable principles for future work
- Giving credit to team discussion and iteration
