# Retrospective Log

Learnings from gimbal improvement cycles.

---

## 2026-02-02: Interactive Permission Callback System

**Feature:** Replace `bypassPermissions` with interactive user-controlled permission gates.

**Commit:** `f0fed9a`

### What Went Well

**Proposal Quality:**
- Architect researched SDK interface (`canUseTool` callback) before proposing
- Three-part structure (Problem → Solution → Acceptance Criteria) with 6 specific requirements
- Conditional approval process sharpened the design (auto-approve scope, timeout behavior, file organization)
- Real problem identified: security risk + environment compatibility

**Quality Gates Working:**
- Staff's conditional approval with 3 specific questions forced design decisions upfront
- Auto-approve scope: minimal (read-only + messaging) vs. permissive
- Timeout behavior: fail-closed (deny) vs. fail-open (allow) - chose safer option
- File organization: inline vs. separate file - chose simpler option
- Post-commit verification (per previous retrospective lessons) ran clean

**Testing Approach:**
- Developer created comprehensive test plan (24 checkpoints)
- Standalone unit tests for auto-approval logic (19/19 passed)
- Code review against acceptance criteria before functional tests
- Scope stayed tight: only `src/agent-lifecycle.ts` committed (package-lock.json excluded)

**Team Collaboration:**
- Knowledge provided precise line references (lines 420-430, 432-454) - saved exploration time
- Research provided security guidance (fail-closed) at critical decision point
- Developer synthesized inputs into clean implementation
- Clear role division: Knowledge (codebase facts) + Research (patterns/practices)

### What Went Wrong

**Process Sequencing Issues:**
- Developer started refining implementation details BEFORE Architect responded to Staff's conditional approval questions
- Staff had to remind team 3+ times about proper sequencing: Architect responds → Staff approves → Developer proceeds
- "Conditional approval" was treated as "near-approval" rather than "blocked pending clarification"

**Root Cause Analysis:**
1. Eagerness to prepare led to premature technical work
2. No explicit "BLOCKED" signal when conditional approval is given
3. Developer interpreted Staff questions as minor clarifications rather than blocking requirements

**Impact:** Multiple message rounds correcting sequencing, but no code rework needed. Process caught the issue before implementation.

**Communication Noise:**
- Multiple "standing by" and "acknowledged" messages without substance
- Some status updates added no information
- Slowed the signal-to-noise ratio in channels

### Process Improvements

**1. Explicit Blocking Signals**
When Staff gives conditional approval, include explicit language:
```
CONDITIONALLY APPROVED - BLOCKED pending answers to:
1. Question A?
2. Question B?

Developer: DO NOT BEGIN until these are resolved.
```

**2. Conditional Approval = Full Stop for Developer**
Developer should treat "conditional approval" as "not approved" until Staff says "APPROVED" with no conditions.

**Learning**: "Conditional approval" ≠ "near-approval" - wait for explicit final green light

**3. Reduce Status-Only Messages**
Avoid messages that only say "standing by" or "acknowledged" without substance.
Combine acknowledgments with substantive updates, or stay silent.

**4. Unit Tests for Logic-Heavy Features**
The 19 auto-approval unit tests provided concrete verification beyond code review.
For features with decision logic, create standalone test scripts.

### Role-Specific Learnings

**Architect:**
- SDK research before proposing builds credibility and speeds approval
- Responding promptly to conditional approval questions unblocks the team
- Clear acceptance criteria (6 specific requirements) eliminate implementation ambiguity

**Developer:**
- "Conditional approval" = blocked, not "almost approved"
- Unit tests for decision logic (auto-approve list) provide concrete verification
- Fewer status messages, more substance when posting
- Risk assessment in test reports: explicitly note what wasn't tested

**Knowledge:**
- Precise line references save significant exploration time
- Continue: detailed technical responses
- Eliminate: pure status messages without substance
- Proactive edge case identification after understanding proposals

**Research:**
- Security guidance at decision points was highest-impact contribution (fail-closed)
- Pattern validation (SDK interface) gave implementation confidence
- Reduce pure acknowledgments, maintain substantive detail level
- Proactive testing research during planning phase would help

**Staff:**
- Conditional approval needs explicit "BLOCKED" language
- Direct messages to unblock stalled workflows work
- Independent post-commit verification remains valuable

### Key Principles Reinforced

> "Conditional approval is NOT approval - full stop until final green light"

> "Security defaults matter - fail-closed is safer than fail-open"

> "Unit tests for decision logic provide verification beyond code review"

> "Complementary roles work: Knowledge (codebase facts) + Research (patterns/practices)"

### What Made This Smooth

- Real problem with SDK-compliant solution
- 6 clear acceptance criteria that matched implementation
- 31 automated tests (19 unit + 12 verification checks)
- Post-commit verification ran clean
- Scope discipline: excluded package-lock.json
- Complementary team expertise applied at right times

---

## 2026-02-02: Agent Error Recovery and Visibility

**Feature:** Add error broadcasting to `#errors` channel when agents fail during message processing.

**Commit:** `77cdb37`

### What Went Well

**Proposal Quality:**
- Problem was real and validated by Staff in code (not theoretical) - agent failures causing workflow deadlocks
- Clear three-part structure (Problem → Solution → Acceptance Criteria) kept discussion focused
- Minimal scope from the start - reused existing `publishToChannel()` infrastructure, no new dependencies
- 5 specific, testable acceptance criteria eliminated ambiguity

**Quality Gates Working:**
- Staff's conditional approval with clarifying questions improved the proposal (timestamp format, broadcast timing)
- Test plan approval before implementation ensured verification strategy was solid
- Post-commit verification from previous retrospective lessons was applied successfully
- Scope creep caught: vitest/package.json changes excluded from commit

**Team Collaboration:**
- Knowledge provided excellent early technical verification (code locations, method signatures, feasibility)
- Team discussion led to better decisions (ISO timestamp vs epoch milliseconds)
- Timing confusion was resolved through explicit discussion before implementation began
- Developer incorporated RETROSPECTIVE.md lessons into test plan

### What Went Wrong

**Message Crossing and Timing Confusion:**
- Architect misread Staff's message about broadcast timing, stating Staff wanted "BEFORE state change" when Staff actually approved "AFTER state change"
- Multiple agents responded simultaneously to Staff's conditional approval, creating temporary confusion
- Developer submitted test plan before proposal was fully approved

**Root Cause Analysis:**
1. Architect didn't carefully re-read Staff's exact words before responding
2. No "wait for responses" protocol when Staff asks clarifying questions
3. Eagerness to proceed led to premature test plan submission

**Impact:** Wasted several message rounds clarifying timing, but the process caught the error before implementation began. No code rework was needed.

### Process Improvements

**1. Quote Exact Text When Responding to Approvals**
When responding to conditional approval or clarifying questions, quote the exact text being addressed to avoid misinterpretation:
```
Staff said: "Place broadcast after state change, before throw"
My response: Confirmed, implementing broadcast AFTER state change...
```

**2. Wait for Architect Response Before Test Plan**
When Staff asks clarifying questions on proposal:
1. Architect responds first with clarifications
2. Staff gives final approval
3. THEN Developer writes test plan

This prevents parallel work based on unclear requirements.

**3. Reference Messages by Content, Not ID**
Message IDs may not be visible to all agents. Reference messages by content quotes rather than "msg_15" or similar.

**4. Pre-Implementation Clean State Check (Reinforced)**
The test plan correctly included `git status` verification, which caught the package.json scope creep. This practice from previous retrospective continues to prove valuable.

### Role-Specific Learnings

**Architect:**
- Reading comprehension matters in technical discussions - precision is critical during quality gates
- Starting with "is this a REAL pain point?" before proposing builds confidence
- Minimal proposals get faster approval (~10 lines of code, no dependencies)
- When Staff asks clarifying questions, they're improving the proposal

**Developer:**
- Test plan complexity should match implementation complexity (Staff correctly simplified approach)
- Always run `git status` before starting implementation AND before staging
- Post-commit verification with `git show HEAD` prevents "works on my machine" issues
- Clear specifications prevent rework - zero code changes needed after initial implementation

**Knowledge:**
- Proactive technical verification in planning phase prevents implementation rework
- Early verification of code locations and method signatures gave team confidence
- Being subscribed to both #planning and #implementation provides good visibility
- Supporting scope discipline enforcement (catching vitest addition) reinforces acceptance criteria

### Key Principles Reinforced

> "Quality gates work when reviewers ask clarifying questions AND proposers read those questions carefully"

> "Proactive technical verification in planning phase prevents implementation rework"

> "Error visibility is critical for multi-agent coordination - silent failures cause deadlocks"

### What Made This Smooth

- Real problem with minimal solution (existing infrastructure reused)
- 5 clear acceptance criteria that matched actual implementation
- Quality gate caught the one scope issue (package.json) before it shipped
- Post-commit verification confirmed committed code matched specification
- Team aligned on technical details through explicit discussion BEFORE implementation

---

## 2026-02-02: CLI Interface Conversion

**Feature:** Convert gimbal to proper CLI tool with `--dir`, `--direction`, `--help`, `--version` flags.

**Commits:** `fcef2c1`, `b2c46fc` (fix), `d237077` (CHANGELOG)

### What Went Well

**Proposal & Planning:**
- Clear problem identification (real pain point: `npm run dev` awkward for tool usage)
- Three-part proposal structure (Problem → Solution → Acceptance Criteria) kept discussion focused
- Minimal scope: No external dependencies, just `process.argv` parsing
- Staff pushed back appropriately on scope (challenged `--version`, kept it minimal)

**Process:**
- Test plan written and approved BEFORE implementation
- Channel separation (#planning for design, #implementation for code) reduced noise
- Evidence-based verification (5 specific items required)
- Multiple team members verified implementation matched proposal

**Collaboration:**
- Knowledge Coordinator provided accurate technical guidance (tsconfig settings, shebang handling)
- Architect's acceptance criteria were testable and specific
- Developer's test plan was comprehensive

### What Went Wrong

**CRITICAL: Broken Commit Shipped**
- Commit `fcef2c1` was approved and created with broken code
- `src/index.ts` was not properly refactored (missing exports)
- Build failed: `src/cli.ts` imported `createAgentProxy` which didn't exist
- Required follow-up fix commit `b2c46fc`

**Root Cause Analysis:**
1. Tests were run on working directory state (pre-commit)
2. File changes appeared successful but didn't persist correctly
3. No post-commit verification was performed
4. CHANGELOG was updated assuming commit was valid
5. Broken build entered git history

### Process Improvements

**NEW RULE: Post-Commit Verification is MANDATORY**

After Developer creates commit, BEFORE Staff updates CHANGELOG:

```bash
# 1. Verify commit contents
git show HEAD:src/file.ts | head -20

# 2. Verify build works on committed code
npm run build

# 3. Basic smoke test
node dist/cli.js --help

# 4. Only then: CHANGELOG update
```

**Additional Learnings:**

1. **Verify file persistence** - After Edit operations, read the file back to confirm changes saved
2. **Test after commit, not just before** - Working directory state may differ from committed state
3. **Include verification methods in acceptance criteria** - Not just "what" but "how to prove it"
4. **Show exact API signatures in proposals** - Reduces ambiguity about exports/interfaces

### Acceptance Criteria Template Update

Old format:
```
✅ TypeScript compilation succeeds without errors
```

Better format:
```
✅ TypeScript compilation succeeds
   - Verify: `npm run build` exits 0
   - Post-commit: Run again after commit to confirm
```

### Key Principle Reinforced

> "Trust but verify" - Approving based on reported results isn't enough. Independent verification of committed code is required.

---

## 2026-02-02: README.md User Documentation

**Feature:** Add user-facing documentation for gimbal CLI tool.

**Commits:** `948be96` (README.md), `3b8c41e` (CHANGELOG)

### What Went Well

**Proposal Quality:**
- Clear problem identification (CLI tool with zero user documentation)
- 8 specific, testable acceptance criteria eliminated ambiguity
- Team collaboration improved the proposal (Knowledge suggested interactive workflow section, Staff enforced minimal agent descriptions)

**Quality Gate Success:**
- Staff caught unrelated package.json changes during pre-commit review
- Git status verification prevented scope creep
- Developer reverted cleanly before commit

**Process Discipline:**
- Test plan written and approved BEFORE implementation
- Evidence-based verification (line numbers, file sizes) made review efficient
- Post-commit verification confirmed clean state

**Collaboration:**
- Knowledge provided accurate source code references (CLI flags, agent roles)
- Architect incorporated team feedback into proposal
- Developer's thorough test results with evidence made approval fast

### What Could Be Improved

**1. Explicit Scope Boundaries**
- Proposal said "Files to create: README.md" but didn't explicitly say "no code changes"
- Unintended package.json changes were in working directory from earlier work
- **Action:** Add "Out of Scope" section to proposal template

**2. Pre-Implementation Clean State Check**
- Developer didn't verify clean git status before starting
- Package.json changes surprised team during final review
- **Action:** Add "verify clean working tree" to test plan template

**3. Approval Signal Clarity**
- Some timeline confusion about test plan approval status (crossed messages)
- **Action:** Use explicit state transitions ("ENTERING IMPLEMENTATION PHASE")

### Process Improvements

**Proposal Template Addition:**
```
**In Scope:**
- [What will change]

**Out of Scope (NOT changing):**
- [What won't change]
```

**Test Plan Template Addition:**
```
**Pre-Implementation Check:**
- [ ] `git status` shows clean working tree (or known/approved changes only)
```

### Key Learning

> "Explicit scope boundaries (including what's NOT changing) prevent scope creep and reduce review friction"

### What Made This Smooth

- Documentation-only task (low risk)
- Clear acceptance criteria (no ambiguity)
- Quality gate caught the one issue before it shipped
- Team feedback improved final deliverable

---

## Template for Future Retrospectives

### What Went Well
- [List specific successes]

### What Went Wrong
- [List failures with root cause]

### Process Improvements
- [Concrete changes to workflow]

### Key Learning
- [One sentence takeaway]
