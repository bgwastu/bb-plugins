import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { aiServicesHostContract } from "./host-contract";

export default function plugin(bb: BbPluginApi) {
  const hostClient = bb.hosts.experimental_client({
    contract: aiServicesHostContract,
  });

  async function getPrimaryHostId(): Promise<string | null> {
    try {
      return (await bb.sdk.system.config()).primaryHostId;
    } catch {
      return null;
    }
  }

  async function requirePrimaryHostId(): Promise<string> {
    const hostId = await getPrimaryHostId();
    if (!hostId) {
      throw new Error("No primary machine is connected");
    }
    return hostId;
  }

  bb.experimental_aiServices.register({
    id: "groq-whisper",
    displayName: "Groq Whisper",
    async transcribe(file: File, options?: { signal?: AbortSignal; hint?: string | null }): Promise<string> {
      const hostId = await requirePrimaryHostId();
      const audioBuffer = Buffer.from(await file.arrayBuffer());
      const res = await hostClient.call(
        "ai.voice.transcribe",
        {
          serviceId: "groq-whisper",
          model: "whisper-large-v3-turbo",
          audioBase64: audioBuffer.toString("base64"),
          mimeType: file.type || "audio/webm",
          filename: file.name || "recording.webm",
          prompt: options?.hint ?? null,
          timeoutMs: 30000,
        },
        {
          hostId,
          ...(options?.signal ? { signal: options.signal } : {}),
          timeoutMs: 35000,
        },
      );

      if (!res.ok) {
        throw new Error(res.message || "Failed to transcribe audio via Groq");
      }
      return res.text;
    },
    async status() {
      const hostId = await getPrimaryHostId();
      if (!hostId) {
        return { ready: false, message: "No primary machine is connected" };
      }
      if (!process.env.GROQ_API_KEY) {
        return { ready: false, message: "GROQ_API_KEY is not set" };
      }
      return { ready: true };
    },
  });
}
