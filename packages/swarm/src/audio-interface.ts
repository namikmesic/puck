import { spawn, ChildProcess } from "child_process";
import { EventEmitter } from "events";

/**
 * Audio interface for microphone input and speaker output.
 * Uses the 'mic' package for microphone capture and ffplay for playback.
 */
export class NodeAudioInterface extends EventEmitter {
  private micProcess: ChildProcess | null = null;
  private playbackProcess: ChildProcess | null = null;
  private isPlaying = false;

  /**
   * Start capturing audio from the microphone.
   * Calls the callback with PCM audio chunks (16kHz, 16-bit, mono).
   */
  startMicrophone(callback: (audio: Buffer) => void): void {
    // Use sox/rec for cross-platform microphone capture
    // Output: 16kHz, 16-bit signed LE, mono PCM
    this.micProcess = spawn("rec", [
      "-q",           // Quiet mode
      "-t", "raw",    // Raw output
      "-b", "16",     // 16-bit
      "-e", "signed", // Signed integer
      "-c", "1",      // Mono
      "-r", "16000",  // 16kHz sample rate
      "-",            // Output to stdout
    ], {
      stdio: ["ignore", "pipe", "ignore"],
    });

    this.micProcess.stdout?.on("data", (chunk: Buffer) => {
      callback(chunk);
    });

    this.micProcess.on("error", (err) => {
      console.error("Microphone error:", err.message);
      console.error("Make sure 'sox' is installed (brew install sox on macOS)");
      this.emit("error", err);
    });

    this.micProcess.on("close", (code) => {
      if (code !== 0 && code !== null) {
        console.error(`Microphone process exited with code ${code}`);
      }
      this.micProcess = null;
    });
  }

  /**
   * Stop capturing audio from the microphone.
   */
  stopMicrophone(): void {
    if (this.micProcess) {
      this.micProcess.kill("SIGTERM");
      this.micProcess = null;
    }
  }

  /**
   * Play audio from an async iterable stream (e.g., ElevenLabs TTS).
   * Uses ffplay for playback.
   */
  async playAudio(audioStream: AsyncIterable<Uint8Array>): Promise<void> {
    return new Promise((resolve, reject) => {
      this.isPlaying = true;

      // Use ffplay to play MP3 audio from stdin
      this.playbackProcess = spawn("ffplay", [
        "-nodisp",      // No video display
        "-autoexit",    // Exit when done
        "-loglevel", "error",  // Minimal logging
        "-i", "pipe:0", // Read from stdin
      ], {
        stdio: ["pipe", "ignore", "pipe"],
      });

      this.playbackProcess.stderr?.on("data", (data) => {
        const msg = data.toString().trim();
        if (msg && !msg.includes("deprecated")) {
          console.error("Playback:", msg);
        }
      });

      this.playbackProcess.on("error", (err) => {
        console.error("Playback error:", err.message);
        console.error("Make sure 'ffmpeg' is installed (brew install ffmpeg on macOS)");
        this.isPlaying = false;
        reject(err);
      });

      this.playbackProcess.on("close", (code) => {
        this.isPlaying = false;
        this.playbackProcess = null;
        if (code === 0 || code === null) {
          resolve();
        } else {
          reject(new Error(`Playback process exited with code ${code}`));
        }
      });

      // Stream audio chunks to ffplay
      (async () => {
        try {
          for await (const chunk of audioStream) {
            if (!this.playbackProcess || !this.isPlaying) {
              break;
            }
            this.playbackProcess.stdin?.write(Buffer.from(chunk));
          }
          this.playbackProcess?.stdin?.end();
        } catch (err) {
          this.playbackProcess?.stdin?.end();
          reject(err);
        }
      })();
    });
  }

  /**
   * Interrupt current playback (for handling user interruptions).
   */
  interrupt(): void {
    this.isPlaying = false;
    if (this.playbackProcess) {
      this.playbackProcess.kill("SIGTERM");
      this.playbackProcess = null;
    }
  }

  /**
   * Clean up all resources.
   */
  cleanup(): void {
    this.stopMicrophone();
    this.interrupt();
  }
}
