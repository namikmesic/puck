export interface ParsedInput {
  type: "command" | "direction";
  command?: string;
  args?: string[];
  rawInput: string;
}

/**
 * Parses user input to distinguish between slash commands and directions.
 * Also detects suspicious short inputs that may be accidental.
 */
export class InputParserImpl {
  private static SUSPICIOUS = [
    "a",
    "y",
    "n",
    "d",
    "yes",
    "no",
    "ok",
    "approve",
    "reject",
    "deny",
  ];

  parse(input: string): ParsedInput {
    const trimmed = input.trim();
    if (this.isCommand(trimmed)) {
      const parts = trimmed.slice(1).split(/\s+/);
      return {
        type: "command",
        command: parts[0].toLowerCase(),
        args: parts.slice(1),
        rawInput: trimmed,
      };
    }
    return { type: "direction", rawInput: trimmed };
  }

  isCommand(input: string): boolean {
    return input.trim().startsWith("/");
  }

  isSuspiciousShortInput(input: string): boolean {
    return InputParserImpl.SUSPICIOUS.includes(input.trim().toLowerCase());
  }
}
