import { SOUND_DATA } from "./sounds";

let audioCtx: AudioContext | null = null;
const decodedBufferCache = new Map<string, AudioBuffer>();
let isUnlocked = false;
let lastPlaybackError: string | null = null;
let lastPlayedTime = 0;

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binaryString = atob(base64.replace(/^data:audio\/[a-z0-9]+;base64,/, ""));
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes.buffer;
}

export function getAudioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!audioCtx) {
    const Ctx = window.AudioContext || (window as any).webkitAudioContext;
    if (!Ctx) return null;
    audioCtx = new Ctx();
  }
  return audioCtx;
}

export async function unlockAudioContext(): Promise<boolean> {
  const ctx = getAudioContext();
  if (!ctx) return false;
  try {
    if (ctx.state === "suspended") {
      await ctx.resume();
    }
    isUnlocked = ctx.state === "running";
    return isUnlocked;
  } catch (err) {
    console.warn("[bell] Failed to unlock audio context:", err);
    return false;
  }
}

export function setupAudioUnlockListeners(): () => void {
  if (typeof window === "undefined") return () => {};

  const onUserInteraction = () => {
    unlockAudioContext().then((unlocked) => {
      if (unlocked) {
        window.removeEventListener("pointerdown", onUserInteraction);
        window.removeEventListener("keydown", onUserInteraction);
        window.removeEventListener("click", onUserInteraction);
      }
    });
  };

  window.addEventListener("pointerdown", onUserInteraction, { passive: true });
  window.addEventListener("keydown", onUserInteraction, { passive: true });
  window.addEventListener("click", onUserInteraction, { passive: true });

  return () => {
    window.removeEventListener("pointerdown", onUserInteraction);
    window.removeEventListener("keydown", onUserInteraction);
    window.removeEventListener("click", onUserInteraction);
  };
}

export async function getDecodedBuffer(
  ctx: AudioContext,
  soundName: string
): Promise<AudioBuffer | null> {
  if (decodedBufferCache.has(soundName)) {
    return decodedBufferCache.get(soundName)!;
  }

  const base64 = SOUND_DATA[soundName];
  if (!base64) return null;

  try {
    const arrayBuffer = base64ToArrayBuffer(base64);
    const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
    decodedBufferCache.set(soundName, audioBuffer);
    return audioBuffer;
  } catch (err) {
    console.warn(`[bell] Failed to decode sound "${soundName}":`, err);
    return null;
  }
}

export async function playBellSound(soundName: string, volume = 0.8): Promise<boolean> {
  lastPlaybackError = null;
  const ctx = getAudioContext();
  const safeVolume = Number.isFinite(volume) ? Math.max(0, Math.min(1, volume)) : 0.8;

  // Try Web Audio API first (reliable, background-safe once unlocked)
  if (ctx) {
    try {
      if (ctx.state === "suspended") {
        await ctx.resume();
      }
      isUnlocked = ctx.state === "running";

      const buffer = await getDecodedBuffer(ctx, soundName);
      if (buffer) {
        const source = ctx.createBufferSource();
        const gainNode = ctx.createGain();
        gainNode.gain.value = safeVolume;

        source.buffer = buffer;
        source.connect(gainNode);
        gainNode.connect(ctx.destination);

        source.start(0);
        lastPlayedTime = Date.now();
        console.log(
          `[bell] Successfully played sound "${soundName}" via Web Audio API (vol: ${safeVolume})`
        );
        return true;
      }
    } catch (err: any) {
      lastPlaybackError = err?.message || String(err);
      console.warn("[bell] Web Audio playback failed, trying HTML5 Audio fallback:", err);
    }
  }

  // HTML5 Audio Fallback
  try {
    const src =
      SOUND_DATA[soundName] ??
      `/api/v1/plugins/bell/http/audio?sound=${encodeURIComponent(soundName)}`;
    const audio = new Audio(src);
    audio.volume = safeVolume;
    await audio.play();
    lastPlayedTime = Date.now();
    console.log(`[bell] Successfully played sound "${soundName}" via HTML5 Audio`);
    return true;
  } catch (err: any) {
    lastPlaybackError = err?.message || String(err);
    console.warn("[bell] All audio playback methods failed:", err);
    return false;
  }
}

export function getAudioDiagnosticStatus() {
  const ctx = getAudioContext();
  return {
    isUnlocked,
    state: ctx ? ctx.state : "unsupported",
    cachedBuffers: decodedBufferCache.size,
    lastError: lastPlaybackError,
    lastPlayedTime,
  };
}
