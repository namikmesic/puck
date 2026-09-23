# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build and Run Commands

```bash
npm run dev          # Run the multi-agent system (tsx src/index.ts)
npm run build        # Compile TypeScript to dist/
npm test             # Run test suite (smoke tests + build verification)
npx tsc --noEmit     # Type-check without emitting (use to verify changes compile)
```

For comprehensive pre-commit verification steps, see RETROSPECTIVE.md lines 51-63.

## Architecture Overview

This is a multi-agent proxy system where multiple Claude agents communicate peer-to-peer via a message queue. The system uses the Claude Agent SDK to spawn and manage agent sessions.

### Core Components

**Gimbal** (`proxy.ts`) - Main orchestrator that:
- Initializes agents from config and manages their lifecycle
- Runs event-driven loop where agents wake on incoming messages
- Provides human direction input via readline interface
- Coordinates channel subscriptions and message routing

**MessageQueue** (`message-queue.ts`) - Pub/sub messaging system:
- Direct messaging: `send(from, to, content)` for agent-to-agent
- Channel-based: agents subscribe to channels (e.g., `#planning`), publish broadcasts to subscribers
- Wakeup callbacks notify agents when messages arrive (no polling)

**AgentSession** (`agent-session.ts`) - Individual agent wrapper:
- Creates MCP server with messaging tools (send_message, subscribe, publish, etc.)
- Manages conversation state and session resumption
- Tool permissions configured via `AgentConfig.tools` array

**Types** (`types.ts`) - Core interfaces:
- `AgentConfig`: id, name, systemPrompt, model, tools
- `ToolName`: union type of valid tools ("Read" | "Edit" | "Write" | "Bash" | "Glob" | "Grep")
- `Message`: id, from, to, content, timestamp, replyTo, channel

### Data Flow

1. Human provides direction via stdin
2. Gimbal sends initial prompt to architect agent
3. Agents use messaging tools to communicate via MessageQueue
4. MessageQueue delivers to recipient queues, triggers wakeup callbacks
5. Gimbal runs agent loops that process incoming messages
6. Agents can use code tools (Read, Edit, Write, Bash, Glob, Grep) based on their config

### Agent Configuration

Agents are defined in `index.ts` with roles and tool permissions:
- **architect**: explores codebase, proposes improvements with acceptance criteria (Read, Glob, Grep)
- **developer**: writes test plans, implements, executes tests (Read, Edit, Write, Bash, Glob, Grep)
- **staff**: quality gate - approves proposals + test plans, documents changes (Read, Write, Bash, Glob, Grep)

Tool access is declarative via the `tools` array in AgentConfig.

### Workflow

1. Architect proposes: problem + solution + acceptance criteria
2. Staff reviews and approves proposal
3. Developer writes test plan to verify acceptance criteria
4. Staff approves test plan
5. Developer implements and runs tests
6. Staff verifies, approves commit, updates CHANGELOG
