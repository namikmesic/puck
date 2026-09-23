import * as readline from "readline";
import { HumanDirector as IHumanDirector } from "./types.js";
import { InputParserImpl, ParsedInput } from "./input-parser.js";

type DirectionCallback = (direction: string) => void;
type FreshStartCallback = () => void;
type StatusCallback = () => void;
type PauseCallback = () => void;
type ResumeCallback = () => void;

/**
 * Handles human input and direction via readline interface.
 * Supports slash commands and confirms suspicious short inputs.
 */
export class HumanDirectorImpl implements IHumanDirector {
  private rl: readline.Interface | null = null;
  private directionCallback: DirectionCallback | null = null;
  private freshStartCallback: FreshStartCallback | null = null;
  private statusCallback: StatusCallback | null = null;
  private pauseCallback: PauseCallback | null = null;
  private resumeCallback: ResumeCallback | null = null;
  private running = false;
  private parser = new InputParserImpl();

  startListening(): void {
    if (this.rl) return;

    this.running = true;
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    this.startDirectionInputLoop();
  }

  stopListening(): void {
    this.running = false;
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
  }

  onDirection(callback: DirectionCallback): void {
    this.directionCallback = callback;
  }

  onFreshStart(callback: FreshStartCallback): void {
    this.freshStartCallback = callback;
  }

  onStatusRequest(callback: StatusCallback): void {
    this.statusCallback = callback;
  }

  onPause(callback: PauseCallback): void {
    this.pauseCallback = callback;
  }

  onResume(callback: ResumeCallback): void {
    this.resumeCallback = callback;
  }

  async prompt(message: string): Promise<string> {
    return new Promise((resolve) => {
      if (!this.rl) {
        resolve("");
        return;
      }

      this.rl.question(message, (input) => {
        resolve(input);
      });
    });
  }

  /**
   * Prompt for direction after all agents have signed off.
   * Allows user to continue with context or start fresh.
   */
  promptForFreshStartChoice(): void {
    if (!this.rl) return;

    this.rl.question(
      "\n[All agents signed off] Enter direction, or /fresh for fresh start: ",
      async (input) => {
        if (input.toLowerCase() === "q" || input === "/quit" || input === "/q") {
          this.stopListening();
          process.exit(0);
        }

        await this.handleInput(input, true);
        this.startDirectionInputLoop();
      }
    );
  }

  private startDirectionInputLoop(): void {
    const promptForDirection = () => {
      if (!this.running || !this.rl) return;

      this.rl.question("\n[Direction] Enter guidance (or /help): ", async (input) => {
        if (input.toLowerCase() === "q") {
          this.stopListening();
          process.exit(0);
        }

        await this.handleInput(input);
        promptForDirection();
      });
    };

    promptForDirection();
  }

  private async handleInput(input: string, afterSignOff = false): Promise<void> {
    const parsed = this.parser.parse(input);

    if (parsed.type === "command") {
      await this.handleCommand(parsed, afterSignOff);
    } else if (parsed.rawInput.trim()) {
      // Check for suspicious short inputs
      if (this.parser.isSuspiciousShortInput(parsed.rawInput)) {
        const confirm = await this.prompt(
          `Broadcast "${parsed.rawInput}" as direction? (y/N): `
        );
        if (confirm.toLowerCase() !== "y") {
          console.log("Cancelled. Use /help for available commands.");
          return;
        }
      }
      this.directionCallback?.(parsed.rawInput);
    }
  }

  private async handleCommand(parsed: ParsedInput, afterSignOff = false): Promise<void> {
    switch (parsed.command) {
      case "help":
        this.showHelp();
        break;
      case "status":
        this.statusCallback?.();
        break;
      case "pause":
        this.pauseCallback?.();
        console.log("[Director] Agents paused");
        break;
      case "resume":
        this.resumeCallback?.();
        console.log("[Director] Agents resumed");
        break;
      case "fresh":
        if (afterSignOff) {
          // In sign-off context, no confirmation needed
          console.log("[Director] Fresh start - resetting all agent contexts");
          this.freshStartCallback?.();
        } else {
          const confirmFresh = await this.prompt("Reset all agent contexts? (y/N): ");
          if (confirmFresh.toLowerCase() === "y") {
            console.log("[Director] Fresh start - resetting all agent contexts");
            this.freshStartCallback?.();
          } else {
            console.log("Fresh start cancelled.");
          }
        }
        break;
      case "quit":
      case "q":
        const confirmQuit = await this.prompt("Quit? (y/N): ");
        if (confirmQuit.toLowerCase() === "y") {
          this.stopListening();
          process.exit(0);
        }
        break;
      default:
        console.log(`Unknown command: /${parsed.command}. Type /help for commands.`);
    }
  }

  private showHelp(): void {
    console.log(`
Available Commands:
  /help      Show this help
  /status    Show workflow state
  /pause     Pause all agents
  /resume    Resume agents
  /fresh     Fresh start (resets contexts)
  /quit, /q  Exit

Any other text is broadcast as direction to agents.
Short inputs (a, y, n, etc.) require confirmation.
`);
  }
}
