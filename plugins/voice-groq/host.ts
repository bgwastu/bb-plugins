import type { ExperimentalAiServicesHostContract } from "@get-bb/plugin-sdk/ai-services";
import type { ExperimentalHostEntry } from "@get-bb/plugin-sdk/host";
import { aiServicesHostContract } from "./host-contract";
import { spawn } from "node:child_process";

type AudioFile = {
  buffer: Buffer;
  mimeType: string;
  filename: string;
};

function extensionForMimeType(mimeType: string): string {
  if (mimeType.includes("mp4")) return "mp4";
  if (mimeType.includes("ogg")) return "ogg";
  if (mimeType.includes("wav")) return "wav";
  if (mimeType.includes("mpeg")) return "mp3";
  return "webm";
}

/**
 * Transcode incoming browser audio (WebM Opus, MP4, etc.) to canonical 16kHz mono WAV.
 * Groqs LPU backend frequently crashes with 500 Internal Server Error on Chromes
 * duration-less streaming WebM clusters, but processes standard 16kHz WAV flawlessly.
 */
function transcodeToWav(audioBuffer: Buffer, originalMimeType: string, originalFilename?: string): Promise<AudioFile> {
  return new Promise((resolve) => {
    const fallback: AudioFile = {
      buffer: audioBuffer,
      mimeType: originalMimeType,
      filename: originalFilename || `recording.${extensionForMimeType(originalMimeType)}`,
    };
    const ffmpegArgs = [
      "-hide_banner",
      "-loglevel", "error",
      "-i", "pipe:0",
      "-vn",
      "-ar", "16000",
      "-ac", "1",
      "-c:a", "pcm_s16le",
      "-f", "wav",
      "pipe:1",
    ];
    // Invoke ffmpeg through mise so upgrades do not leave a stale versioned
    // shim behind. The plugin still falls back to the original browser file.
    const ffmpeg = spawn("mise", ["exec", "ffmpeg@latest", "--", "ffmpeg", ...ffmpegArgs], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    const chunks: Buffer[] = [];
    let settled = false;
    const finish = (result: AudioFile) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    ffmpeg.stdout.on("data", (chunk) => chunks.push(chunk));
    // A converter that exits before consuming stdin emits EPIPE here. Always
    // consume it so a bad recording or missing binary cannot kill the worker.
    ffmpeg.stdin.on("error", () => {});
    ffmpeg.stdout.on("error", () => finish(fallback));
    ffmpeg.stderr.on("error", () => {});

    ffmpeg.on("close", (code) => {
      if (code === 0 && chunks.length > 0) {
        finish({
          buffer: Buffer.concat(chunks),
          mimeType: "audio/wav",
          filename: "recording.wav",
        });
      } else {
        finish(fallback);
      }
    });

    ffmpeg.on("error", () => {
      finish(fallback);
    });

    try {
      ffmpeg.stdin.end(audioBuffer);
    } catch {
      finish(fallback);
    }
  });
}

const hostEntry = {
  experimental_apiVersion: 1,
  contract: aiServicesHostContract,
  handlers: {
    "ai.inference.complete": async () => {
      return {
        ok: false,
        code: "request_failed",
        message: "Inference is not implemented by this plugin",
      };
    },
    "ai.voice.transcribe": async (input) => {
      const apiKey = process.env.GROQ_API_KEY;
      if (!apiKey) {
        return {
          ok: false,
          code: "auth_required",
          message: "GROQ_API_KEY is not set in environment",
        };
      }

      try {
        const rawBuffer = Buffer.from(input.audioBase64, "base64");
        if (rawBuffer.length === 0) {
          return { ok: false, code: "request_failed", message: "The recording was empty" };
        }

        // Transcode to clean 16kHz mono WAV to prevent Groq 500 crashes
        const { buffer: audioBuffer, mimeType, filename } = await transcodeToWav(
          rawBuffer,
          input.mimeType || "audio/webm",
          input.filename,
        );

        const formData = new FormData();
        const file = new Blob([audioBuffer], { type: mimeType });
        formData.append("file", file, filename);
        formData.append("model", input.model || "whisper-large-v3-turbo");

        // Clean & truncate prompt to stay safely below Groq 896-char limit
        if (input.prompt && input.prompt.trim().length > 0) {
          const cleanPrompt = input.prompt.trim().slice(-400);
          formData.append("prompt", cleanPrompt);
        }

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), input.timeoutMs || 30000);

        try {
          const res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiKey}`,
            },
            body: formData,
            signal: controller.signal,
          });

          if (!res.ok) {
            const errText = await res.text();
            console.error("[voice-groq] Groq API returned error:", res.status, errText);
            if (res.status === 429) {
              return { ok: false, code: "rate_limited", message: "Groq rate limited" };
            }
            if (res.status === 401 || res.status === 403) {
              return { ok: false, code: "auth_required", message: "Invalid GROQ_API_KEY" };
            }
            return {
              ok: false,
              code: "request_failed",
              message: `Groq error (${res.status}): ${errText}`,
            };
          }

          const data = (await res.json()) as { text: string };
          return {
            ok: true,
            model: input.model,
            text: data.text || "",
          };
        } finally {
          clearTimeout(timeout);
        }
      } catch (err: any) {
        console.error("[voice-groq] Exception:", err);
        if (err.name === "AbortError") {
          return { ok: false, code: "timeout", message: "Groq transcription timed out" };
        }
        return {
          ok: false,
          code: "request_failed",
          message: err.message || "Failed to transcribe audio via Groq",
        };
      }
    },
  },
} satisfies ExperimentalHostEntry<ExperimentalAiServicesHostContract>;

export default hostEntry;
