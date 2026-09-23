#!/usr/bin/env node
import * as readline from "readline";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { createGimbal } from "./index.js";

interface ParsedArgs {
  dir?: string;
  direction?: string;
  help?: boolean;
  version?: boolean;
  selfImprove?: boolean;
  storeTranscripts?: boolean;
  voiceSummary?: string;
  voiceInterview?: string;
  recordInterview?: string;
  voiceId?: string;
  outputFile?: string;
  // SME mode options
  smeMode?: boolean;
  repos?: string[];
  noArchitect?: boolean;
}

function parseArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = {};

  for (let i = 2; i < args.length; i++) {
    const arg = args[i];

    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
    } else if (arg === "--version" || arg === "-v") {
      parsed.version = true;
    } else if (arg === "--dir") {
      if (i + 1 >= args.length) {
        console.error("Error: --dir requires a path argument");
        process.exit(1);
      }
      parsed.dir = args[++i];
    } else if (arg === "--direction") {
      if (i + 1 >= args.length) {
        console.error("Error: --direction requires a text argument");
        process.exit(1);
      }
      parsed.direction = args[++i];
    } else if (arg === "--self-improve") {
      parsed.selfImprove = true;
    } else if (arg === "--store-transcripts") {
      parsed.storeTranscripts = true;
    } else if (arg === "--voice-summary") {
      if (i + 1 >= args.length) {
        console.error("Error: --voice-summary requires a file path argument");
        process.exit(1);
      }
      parsed.voiceSummary = args[++i];
    } else if (arg === "--voice-id") {
      if (i + 1 >= args.length) {
        console.error("Error: --voice-id requires a voice ID argument");
        process.exit(1);
      }
      parsed.voiceId = args[++i];
    } else if (arg === "--output") {
      if (i + 1 >= args.length) {
        console.error("Error: --output requires a file path argument");
        process.exit(1);
      }
      parsed.outputFile = args[++i];
    } else if (arg === "--voice-interview") {
      if (i + 1 >= args.length) {
        console.error("Error: --voice-interview requires a file path argument");
        process.exit(1);
      }
      parsed.voiceInterview = args[++i];
    } else if (arg === "--record") {
      if (i + 1 >= args.length) {
        console.error("Error: --record requires a file path argument");
        process.exit(1);
      }
      parsed.recordInterview = args[++i];
    } else if (arg === "--sme-mode") {
      parsed.smeMode = true;
    } else if (arg === "--repos") {
      // Collect all following arguments until we hit another flag
      parsed.repos = [];
      while (i + 1 < args.length && !args[i + 1].startsWith("--")) {
        parsed.repos.push(args[++i]);
      }
      if (parsed.repos.length === 0) {
        console.error("Error: --repos requires at least one path argument");
        process.exit(1);
      }
    } else if (arg === "--no-architect") {
      parsed.noArchitect = true;
    } else {
      console.error(`Error: Unknown option: ${arg}\n`);
      showHelp();
      process.exit(1);
    }
  }

  return parsed;
}

function showHelp(): void {
  console.log(`
Usage: gimbal [options]

Options:
  --dir <path>         Working directory for agents (default: current directory)
  --direction <text>   Initial direction for agents (skips interactive prompt)
  --self-improve       Run in self-improvement mode (gimbal improves itself)
  --store-transcripts  Save conversation transcript to TRANSCRIPT.md
  --voice-summary <file>    Generate voice summary from TRANSCRIPT.md
  --voice-interview <file>  Start interactive voice interview about session
  --record <file>           Record interview to file (use with --voice-interview)
  --voice-id <id>           ElevenLabs voice ID (default: Brian)
  --output <file>           Output audio file (default: summary.mp3)
  --help, -h           Show this help message
  --version, -v        Show version number

SME Mode (Subject Matter Expert):
  --sme-mode           Enable SME mode for multi-repository knowledge
  --repos <paths...>   Repository paths for SME mode (required with --sme-mode)
  --no-architect       Exclude Staff Architect agent from SME mode

Environment Variables:
  ELEVENLABS_API_KEY   Required for --voice-summary and --voice-interview

Examples:
  gimbal                                    # Interactive mode
  gimbal --dir ./my-project                 # Specify working directory
  gimbal --direction "Fix auth bug"         # Pre-set direction
  gimbal --dir ./project --direction "..."  # Combined options
  gimbal --self-improve                     # Self-improvement mode
  gimbal --voice-summary ./TRANSCRIPT.md    # Generate voice summary
  gimbal --voice-interview ./TRANSCRIPT.md  # Interactive voice interview
  gimbal --voice-interview ./TRANSCRIPT.md --record ./out.mp3  # With recording

SME Mode Examples:
  gimbal --sme-mode --repos ./backend ./frontend ./ml-service
  gimbal --sme-mode --repos ./api --no-architect
  gimbal --sme-mode --repos ./project1 ./project2 --store-transcripts
`);
}

function showVersion(): void {
  // Read version from package.json
  const packageJsonPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "../package.json");
  try {
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
    console.log(packageJson.version);
  } catch (error) {
    console.error("Error reading version from package.json");
    process.exit(1);
  }
}

async function getInitialDirection(): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(
      "\n[Direction] What should the agents focus on? (Enter for default): ",
      (input) => {
        rl.close();
        resolve(
          input.trim() ||
            "Explore the codebase and propose one improvement to make agent communication better."
        );
      }
    );
  });
}

async function getSelfImproveDirection(): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(
      "\n[Self-Improve] What should gimbal improve about itself? (Enter for default): ",
      (input) => {
        rl.close();
        resolve(
          input.trim() ||
            "Analyze gimbal's recent retrospectives and changelog, then propose one improvement to the multi-agent coordination or workflow."
        );
      }
    );
  });
}

function getGimbalRootDir(): string {
  // From dist/cli.js, go up one level to project root
  const cliDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(cliDir, "..");
}

function validateDirectory(dirPath: string): void {
  try {
    const stats = fs.statSync(dirPath);
    if (!stats.isDirectory()) {
      console.error(`Error: '${dirPath}' is not a directory`);
      process.exit(1);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      console.error(`Error: Directory '${dirPath}' does not exist`);
      process.exit(1);
    } else if ((error as NodeJS.ErrnoException).code === "EACCES") {
      console.error(`Error: Directory '${dirPath}' is not accessible`);
      process.exit(1);
    } else {
      console.error(`Error: Cannot access directory '${dirPath}'`);
      process.exit(1);
    }
  }
}

async function main() {
  const args = parseArgs(process.argv);

  // Handle help flag
  if (args.help) {
    showHelp();
    process.exit(0);
  }

  // Handle version flag
  if (args.version) {
    showVersion();
    process.exit(0);
  }

  // Handle voice summary command
  if (args.voiceSummary) {
    const { generateVoiceSummary } = await import("./voice-summary.js");
    try {
      const outputPath = await generateVoiceSummary({
        transcriptPath: args.voiceSummary,
        outputPath: args.outputFile,
        voiceId: args.voiceId,
      });
      console.log(`Voice summary saved to: ${outputPath}`);
      process.exit(0);
    } catch (error) {
      console.error(`Error: ${(error as Error).message}`);
      process.exit(1);
    }
  }

  // Handle voice interview command
  if (args.voiceInterview) {
    const { startVoiceInterview } = await import("./voice-interview.js");
    try {
      await startVoiceInterview({
        transcriptPath: args.voiceInterview,
        recordingPath: args.recordInterview,
        voiceId: args.voiceId,
      });
      // startVoiceInterview handles its own exit
    } catch (error) {
      console.error(`Error: ${(error as Error).message}`);
      process.exit(1);
    }
  }

  // Handle SME mode
  if (args.smeMode) {
    if (!args.repos || args.repos.length === 0) {
      console.error("Error: --sme-mode requires --repos with at least one repository path");
      process.exit(1);
    }

    // Validate repository paths
    for (const repoPath of args.repos) {
      const resolvedPath = path.resolve(repoPath);
      validateDirectory(resolvedPath);
    }

    const { createSMEMode } = await import("./sme-mode.js");
    try {
      await createSMEMode({
        repositories: args.repos.map((p) => path.resolve(p)),
        includeArchitect: !args.noArchitect,
        storeTranscripts: args.storeTranscripts,
      });
      process.exit(0);
    } catch (error) {
      console.error(`Error: ${(error as Error).message}`);
      process.exit(1);
    }
  }

  // Validate and resolve directory if provided
  let workingDirectory: string | undefined;
  if (args.dir) {
    const resolvedDir = path.resolve(args.dir);
    validateDirectory(resolvedDir);
    workingDirectory = resolvedDir;
  }

  // Handle self-improve mode
  if (args.selfImprove) {
    if (args.dir) {
      console.warn("Warning: --dir is ignored in --self-improve mode");
    }
    workingDirectory = getGimbalRootDir();
    console.log(`[Self-Improve Mode] Working on gimbal at: ${workingDirectory}`);
  }

  // Get direction (from flag or interactive prompt)
  let direction: string | undefined;
  if (args.direction) {
    direction = args.direction;
  } else if (args.selfImprove) {
    direction = await getSelfImproveDirection();
  } else {
    direction = await getInitialDirection();
  }

  // Handle graceful shutdown
  process.on("SIGINT", () => {
    console.log("\nShutting down...");
    process.exit(0);
  });

  // Create and run gimbal
  await createGimbal({
    workingDirectory,
    initialDirection: direction,
    selfImproveMode: args.selfImprove || false,
    storeTranscripts: args.storeTranscripts || false,
  });
}

main();
