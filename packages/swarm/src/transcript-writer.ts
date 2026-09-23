import * as fs from "fs";
import * as path from "path";
import { Message } from "./types.js";

/**
 * Parsed session data from a TRANSCRIPT.md file.
 */
export interface ParsedSession {
  startTime: string;
  direction?: string;
  endTime?: string;
  messages: Message[];
}

/**
 * Reads and parses TRANSCRIPT.md files back into structured data.
 * Complements TranscriptWriterImpl - same format, opposite direction.
 */
export class TranscriptReaderImpl {
  /**
   * Parse a transcript file into structured session data.
   */
  static parseFile(filePath: string): ParsedSession {
    const content = fs.readFileSync(filePath, "utf-8");
    return TranscriptReaderImpl.parseContent(content);
  }

  /**
   * Parse transcript content string into structured session data.
   */
  static parseContent(content: string): ParsedSession {
    const lines = content.split("\n");
    const session: ParsedSession = {
      startTime: "",
      messages: [],
    };

    // Extract session metadata from header
    for (const line of lines) {
      if (line.startsWith("**Started:**")) {
        session.startTime = line.replace("**Started:**", "").trim();
      } else if (line.startsWith("**Direction:**")) {
        session.direction = line.replace("**Direction:**", "").trim();
      } else if (line.startsWith("**Ended:**")) {
        session.endTime = line.replace("**Ended:**", "").trim();
      }
    }

    // Parse messages using the same format TranscriptWriterImpl uses:
    // ### [HH:MM:SS] from → target
    // content...
    // ---
    const messageHeaderPattern = /^### \[(\d{2}:\d{2}:\d{2})\] (.+?) → (.+)$/;
    let currentMessage: Partial<Message> | null = null;
    let contentLines: string[] = [];
    let messageCounter = 0;

    for (const line of lines) {
      const headerMatch = line.match(messageHeaderPattern);

      if (headerMatch) {
        // Save previous message if exists
        if (currentMessage) {
          currentMessage.content = contentLines.join("\n").trim();
          session.messages.push(currentMessage as Message);
        }

        // Start new message
        const [, time, from, target] = headerMatch;
        const isChannel = target.startsWith("#");

        currentMessage = {
          id: `msg-${++messageCounter}`,
          from,
          to: isChannel ? from : target, // For channels, 'to' is self
          content: "",
          timestamp: TranscriptReaderImpl.parseTimeToTimestamp(time, session.startTime),
          channel: isChannel ? target : undefined,
        };
        contentLines = [];
      } else if (currentMessage && line !== "---" && !line.startsWith("## ")) {
        contentLines.push(line);
      }
    }

    // Save final message
    if (currentMessage) {
      currentMessage.content = contentLines.join("\n").trim();
      session.messages.push(currentMessage as Message);
    }

    return session;
  }

  /**
   * Convert time string (HH:MM:SS) to timestamp using session start date.
   */
  private static parseTimeToTimestamp(time: string, sessionStart: string): number {
    // If we have a session start date, combine it with the time
    if (sessionStart) {
      const datePart = sessionStart.split(" ")[0]; // "2026-02-02"
      const dateTimeStr = `${datePart}T${time}`;
      const parsed = Date.parse(dateTimeStr);
      if (!isNaN(parsed)) {
        return parsed;
      }
    }
    // Fallback: just use today's date with the time
    const today = new Date().toISOString().split("T")[0];
    return Date.parse(`${today}T${time}`) || Date.now();
  }
}

/**
 * Writes agent conversations to a human-readable TRANSCRIPT.md file.
 * Only active when --store-transcripts flag is provided.
 */
export class TranscriptWriterImpl {
  private filePath: string;
  private enabled: boolean;
  private sessionStarted = false;

  constructor(workingDir: string, enabled: boolean) {
    this.enabled = enabled;
    this.filePath = path.join(workingDir, "TRANSCRIPT.md");
  }

  /**
   * Write session header to transcript file.
   * Called when the session starts.
   */
  startSession(direction?: string): void {
    if (!this.enabled) return;

    const timestamp = new Date().toISOString().replace("T", " ").substring(0, 19);
    let header = `# Gimbal Session Transcript
**Started:** ${timestamp}
`;

    if (direction) {
      header += `**Direction:** ${direction}\n`;
    }

    header += `
---

## Messages

`;

    fs.writeFileSync(this.filePath, header);
    this.sessionStarted = true;
  }

  /**
   * Record a message to the transcript.
   * Appends formatted message to TRANSCRIPT.md.
   */
  recordMessage(msg: Message): void {
    if (!this.enabled) return;

    // Auto-start session if not started
    if (!this.sessionStarted) {
      this.startSession();
    }

    const time = new Date(msg.timestamp).toLocaleTimeString("en-US", {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });

    const target = msg.channel || msg.to;
    const entry = `### [${time}] ${msg.from} → ${target}
${msg.content}

---

`;

    fs.appendFileSync(this.filePath, entry);
  }

  /**
   * Write session footer with summary.
   * Called when the session ends.
   */
  endSession(): void {
    if (!this.enabled || !this.sessionStarted) return;

    const timestamp = new Date().toISOString().replace("T", " ").substring(0, 19);
    const footer = `
## Session Ended
**Ended:** ${timestamp}
`;

    fs.appendFileSync(this.filePath, footer);
  }
}
