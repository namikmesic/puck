import * as fs from "fs";
import * as path from "path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { ElevenLabsClient, AudioFormat, CommitStrategy, RealtimeEvents } from "@elevenlabs/elevenlabs-js";
import { NodeAudioInterface } from "./audio-interface.js";
import { InterviewRecorder } from "./interview-recorder.js";
import { TranscriptReaderImpl } from "./transcript-writer.js";

export interface VoiceInterviewOptions {
  transcriptPath: string;
  recordingPath?: string;
  voiceId?: string;
}

const END_PHRASES = ["goodbye", "end interview", "that's all", "bye", "exit"];

/**
 * Check if the user's speech indicates they want to end the interview.
 */
function isEndPhrase(text: string): boolean {
  const lower = text.toLowerCase().trim();
  return END_PHRASES.some(phrase => lower.includes(phrase));
}

/**
 * Load context files for the interview (transcript, changelog, retrospective).
 */
function loadContext(transcriptPath: string): {
  transcriptContent: string;
  changelogContent: string;
  retrospectiveContent: string;
} {
  const dir = path.dirname(transcriptPath);

  const transcriptContent = fs.readFileSync(transcriptPath, "utf-8");

  let changelogContent = "";
  const changelogPath = path.join(dir, "CHANGELOG.md");
  if (fs.existsSync(changelogPath)) {
    changelogContent = fs.readFileSync(changelogPath, "utf-8");
  }

  let retrospectiveContent = "";
  const retroPath = path.join(dir, "RETROSPECTIVE.md");
  if (fs.existsSync(retroPath)) {
    retrospectiveContent = fs.readFileSync(retroPath, "utf-8");
  }

  return { transcriptContent, changelogContent, retrospectiveContent };
}

/**
 * Build the system prompt for the interview agent.
 */
function buildSystemPrompt(
  transcriptContent: string,
  changelogContent: string,
  retrospectiveContent: string
): string {
  return `You are an AI assistant reviewing a gimbal development session.

=== TRANSCRIPT ===
${transcriptContent}

${changelogContent ? `=== CHANGELOG ===\n${changelogContent}\n` : ""}
${retrospectiveContent ? `=== RETROSPECTIVE ===\n${retrospectiveContent}\n` : ""}
IMPORTANT: This is a spoken voice interview. Your responses will be read aloud.
- Never use code blocks, inline code formatting, or code snippets
- Never use markdown formatting (backticks, asterisks, etc.)
- Speak naturally as if in a conversation
- You can mention file names or line numbers verbally
- Keep responses concise (under 30 seconds spoken, ~75-100 words)

Answer questions about what happened, explain decisions, highlight learnings.`;
}

/**
 * Start an interactive voice interview about a development session.
 */
export async function startVoiceInterview(options: VoiceInterviewOptions): Promise<void> {
  // Validate API key
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    throw new Error(
      "ELEVENLABS_API_KEY environment variable is required.\n" +
      "Get your API key at: https://elevenlabs.io/app/settings/api-keys"
    );
  }

  // Validate transcript path
  const transcriptPath = path.resolve(options.transcriptPath);
  if (!fs.existsSync(transcriptPath)) {
    throw new Error(`Transcript file not found: ${transcriptPath}`);
  }

  // Parse transcript to validate it has content
  const session = TranscriptReaderImpl.parseFile(transcriptPath);
  if (session.messages.length === 0) {
    throw new Error("No messages found in transcript. Is the file empty?");
  }

  // Load context
  const { transcriptContent, changelogContent, retrospectiveContent } = loadContext(transcriptPath);
  const systemPrompt = buildSystemPrompt(transcriptContent, changelogContent, retrospectiveContent);

  // Initialize components
  const client = new ElevenLabsClient({ apiKey });
  const audioInterface = new NodeAudioInterface();
  const recorder = options.recordingPath ? new InterviewRecorder(options.recordingPath) : null;

  // Handle audio interface errors gracefully
  audioInterface.on("error", () => {
    process.exit(1);
  });

  // Default voice: Brian (friendly, conversational)
  const voiceId = options.voiceId || "nPczCjzI2devNBz1zQrb";

  let sessionId: string | undefined;
  let isProcessing = false;
  let shouldExit = false;

  console.log("\n=== Voice Interview ===");
  console.log("Reviewing:", transcriptPath);
  if (recorder) {
    console.log("Recording to:", options.recordingPath);
  }
  console.log('\nSpeak naturally. Say "goodbye" or "end interview" to finish.');
  console.log("Connecting to speech recognition...\n");

  /**
   * Convert text to speech and play it.
   */
  async function speakResponse(text: string): Promise<void> {
    console.log(`[Agent]: ${text}\n`);

    const audioStream = await client.textToSpeech.convert(voiceId, {
      text,
      modelId: "eleven_flash_v2_5",
      outputFormat: "mp3_44100_128",
      voiceSettings: {
        stability: 0.4,
        similarityBoost: 0.75,
      },
    });

    // Collect audio for recording if enabled
    const recordingStream = (async function* () {
      for await (const chunk of audioStream) {
        const buffer = Buffer.from(chunk);
        recorder?.recordAgentChunk(buffer);
        yield chunk;
      }
    })();

    await audioInterface.playAudio(recordingStream);
  }

  /**
   * Handle user speech: send to Claude, get response, speak it.
   */
  async function handleUserSpeech(text: string): Promise<void> {
    if (!text.trim() || isProcessing) return;

    console.log(`[You]: ${text}`);

    // Check for end phrases
    if (isEndPhrase(text)) {
      shouldExit = true;
      await speakResponse("Thanks for the interview! Goodbye!");
      return;
    }

    isProcessing = true;

    try {
      // Query Claude with session resumption for context continuity
      const response = query({
        prompt: text,
        options: {
          model: "opus",
          systemPrompt,
          resume: sessionId,
          cwd: process.cwd(),
          permissionMode: "default" as const,
          tools: [],
        },
      });

      let responseText = "";

      for await (const message of response) {
        if (message.type === "system" && message.subtype === "init") {
          sessionId = message.session_id;
          continue;
        }

        if (message.type === "assistant") {
          const betaMessage = message.message;
          if (betaMessage && betaMessage.content) {
            for (const block of betaMessage.content) {
              if ("text" in block && typeof block.text === "string") {
                responseText += block.text;
              }
            }
          }
        }

        if (message.type === "result") {
          if (message.subtype !== "success") {
            const errorMsg = "errors" in message
              ? (message as { errors?: string[] }).errors?.join(", ")
              : "Unknown error";
            console.error(`Claude error: ${errorMsg}`);
          }
        }
      }

      if (responseText.trim()) {
        await speakResponse(responseText.trim());
      }
    } catch (error) {
      console.error("Error processing speech:", (error as Error).message);
    } finally {
      isProcessing = false;
    }
  }

  // Connect to ElevenLabs real-time speech-to-text
  const sttConnection = await client.speechToText.realtime.connect({
    modelId: "scribe_v2_realtime",
    audioFormat: AudioFormat.PCM_16000,
    sampleRate: 16000,
    commitStrategy: CommitStrategy.VAD,
    vadSilenceThresholdSecs: 1.0,
    vadThreshold: 0.4,
    minSpeechDurationMs: 100,
    minSilenceDurationMs: 100,
    languageCode: "en",
  });

  // Handle committed transcripts (final text after VAD detects silence)
  sttConnection.on(RealtimeEvents.COMMITTED_TRANSCRIPT, async (data) => {
    if (data.text && data.text.trim()) {
      await handleUserSpeech(data.text);
      if (shouldExit) {
        cleanup();
      }
    }
  });

  // Handle partial transcripts (for visual feedback)
  sttConnection.on(RealtimeEvents.PARTIAL_TRANSCRIPT, (data) => {
    if (data.text && data.text.trim()) {
      process.stdout.write(`\r[Listening]: ${data.text}        `);
    }
  });

  // Handle errors
  sttConnection.on(RealtimeEvents.ERROR, (error) => {
    console.error("STT error:", error);
  });

  // Start microphone capture
  audioInterface.startMicrophone((audioChunk: Buffer) => {
    // Record microphone audio if recording is enabled
    recorder?.recordMicrophoneChunk(audioChunk);

    // Send audio to STT service
    sttConnection.send({
      audioBase64: audioChunk.toString("base64"),
    });
  });

  // Give an initial greeting
  await speakResponse("Hello! I'm ready to discuss this development session. What would you like to know?");

  /**
   * Clean up resources and exit.
   */
  async function cleanup(): Promise<void> {
    console.log("\nEnding interview...");

    audioInterface.cleanup();

    try {
      sttConnection.close();
    } catch {
      // Ignore close errors
    }

    if (recorder) {
      const outputPath = await recorder.stopRecording();
      console.log(`Recording saved to: ${outputPath}`);
    }

    process.exit(0);
  }

  // Handle graceful shutdown
  process.on("SIGINT", () => {
    cleanup();
  });

  // Keep the process running
  await new Promise(() => {
    // This promise never resolves - we exit via cleanup()
  });
}
