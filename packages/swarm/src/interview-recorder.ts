import * as fs from "fs";
import { spawn } from "child_process";

/**
 * Records both microphone and agent audio streams to a single MP3 file.
 * Uses ffmpeg to mix and encode the audio streams.
 */
export class InterviewRecorder {
  private outputPath: string;
  private micChunks: Buffer[] = [];
  private agentChunks: Buffer[] = [];
  private isRecording = true;

  constructor(outputPath: string) {
    this.outputPath = outputPath;
  }

  /**
   * Record a chunk of microphone audio (PCM 16kHz, 16-bit, mono).
   */
  recordMicrophoneChunk(audio: Buffer): void {
    if (this.isRecording) {
      this.micChunks.push(Buffer.from(audio));
    }
  }

  /**
   * Record a chunk of agent audio (MP3 format from ElevenLabs).
   */
  recordAgentChunk(audio: Buffer): void {
    if (this.isRecording) {
      this.agentChunks.push(Buffer.from(audio));
    }
  }

  /**
   * Stop recording and write the combined audio to the output file.
   * Returns the path to the output file.
   */
  async stopRecording(): Promise<string> {
    this.isRecording = false;

    // Combine chunks
    const micBuffer = Buffer.concat(this.micChunks);
    const agentBuffer = Buffer.concat(this.agentChunks);

    // Write temporary files for ffmpeg processing
    const tempMicPath = `${this.outputPath}.mic.raw`;
    const tempAgentPath = `${this.outputPath}.agent.mp3`;

    fs.writeFileSync(tempMicPath, micBuffer);
    fs.writeFileSync(tempAgentPath, agentBuffer);

    // Use ffmpeg to mix both audio streams into a single MP3
    await this.mixAudioWithFfmpeg(tempMicPath, tempAgentPath, this.outputPath);

    // Clean up temp files
    try {
      fs.unlinkSync(tempMicPath);
      fs.unlinkSync(tempAgentPath);
    } catch {
      // Ignore cleanup errors
    }

    return this.outputPath;
  }

  /**
   * Mix microphone (PCM) and agent (MP3) audio into a single MP3 file.
   */
  private async mixAudioWithFfmpeg(
    micPath: string,
    agentPath: string,
    outputPath: string
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      // Check if we have any audio to mix
      const micStats = fs.statSync(micPath);
      const agentStats = fs.statSync(agentPath);

      if (micStats.size === 0 && agentStats.size === 0) {
        // No audio recorded, create empty file
        fs.writeFileSync(outputPath, Buffer.alloc(0));
        resolve();
        return;
      }

      // Build ffmpeg command based on available audio
      const args: string[] = [];

      // Input microphone audio (raw PCM)
      if (micStats.size > 0) {
        args.push(
          "-f", "s16le",
          "-ar", "16000",
          "-ac", "1",
          "-i", micPath
        );
      }

      // Input agent audio (MP3)
      if (agentStats.size > 0) {
        args.push("-i", agentPath);
      }

      // Output configuration
      if (micStats.size > 0 && agentStats.size > 0) {
        // Mix both streams
        args.push(
          "-filter_complex", "[0:a][1:a]amix=inputs=2:duration=longest[out]",
          "-map", "[out]"
        );
      }

      args.push(
        "-codec:a", "libmp3lame",
        "-b:a", "128k",
        "-y",  // Overwrite output file
        outputPath
      );

      const ffmpeg = spawn("ffmpeg", args, {
        stdio: ["ignore", "ignore", "pipe"],
      });

      let stderr = "";
      ffmpeg.stderr?.on("data", (data) => {
        stderr += data.toString();
      });

      ffmpeg.on("error", (err) => {
        reject(new Error(`ffmpeg error: ${err.message}`));
      });

      ffmpeg.on("close", (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`ffmpeg exited with code ${code}: ${stderr}`));
        }
      });
    });
  }

  /**
   * Get the current recording stats.
   */
  getStats(): { micBytes: number; agentBytes: number } {
    return {
      micBytes: this.micChunks.reduce((sum, chunk) => sum + chunk.length, 0),
      agentBytes: this.agentChunks.reduce((sum, chunk) => sum + chunk.length, 0),
    };
  }
}
