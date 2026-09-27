import React, { useEffect, useState } from "react";
import { definePluginApp, useRpc, useSettings } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import { SOUND_NAMES } from "./sound-names";
import {
  getAudioDiagnosticStatus,
  playBellSound,
  setupAudioUnlockListeners,
} from "./audio-player";

type SoundKey = "sound" | "workflowSound" | "failSound";
const SOUND_ROWS: Array<{ key: SoundKey; label: string }> = [
  { key: "sound", label: "Main turn" },
  { key: "workflowSound", label: "Workflow" },
  { key: "failSound", label: "Failure" },
];
const GROUPS: Record<string, string> = {
  alert: "Alerts", "bip-bop": "Bip-bops", nope: "Failures",
  staplebops: "Staplebops", yup: "Success", pinda: "Other",
};
const groupOf = (sound: string) => sound.startsWith("bip-bop") ? "bip-bop" : sound.split("-")[0] || "other";
const labelOf = (sound: string) => sound.split("-").map((part) => part[0].toUpperCase() + part.slice(1)).join(" ");

function SoundOptions() {
  return <>{Object.entries(GROUPS).map(([group, label]) => {
    const sounds = SOUND_NAMES.filter((sound) => groupOf(sound) === group);
    return <optgroup key={group} label={label}>{sounds.map((sound) => <option key={sound} value={sound}>{labelOf(sound)}</option>)}</optgroup>;
  })}</>;
}

function BellSettingsSection() {
  const { values } = useSettings();
  const rpc = useRpc<typeof rpcContract>();
  const [sounds, setSounds] = useState<Record<SoundKey, string>>({
    sound: String(values?.sound ?? "bip-bop-01"),
    workflowSound: String(values?.workflowSound ?? "yup-01"),
    failSound: String(values?.failSound ?? "nope-03"),
  });

  useEffect(() => {
    setSounds({
      sound: String(values?.sound ?? "bip-bop-01"),
      workflowSound: String(values?.workflowSound ?? "yup-01"),
      failSound: String(values?.failSound ?? "nope-03"),
    });
  }, [values?.sound, values?.workflowSound, values?.failSound]);

  const updateSound = async (key: SoundKey, value: string) => {
    setSounds((current) => ({ ...current, [key]: value }));
    try {
      await rpc.call("bell_update_settings", { [key]: value });
    } catch {
      // The host settings form remains the source of truth if an inline save fails.
    }
  };

  const preview = async (value: string) => {
    const volume = Number.parseFloat(String(values?.volume ?? "0.8"));
    await playBellSound(value, Number.isFinite(volume) ? Math.max(0, Math.min(1, volume)) : 0.8);
  };

  return (
    <div className="space-y-2 pt-1">
      {SOUND_ROWS.map(({ key, label }) => (
        <div key={key} className="flex items-center gap-3 rounded-md border border-border/60 px-3 py-2">
          <span className="w-36 shrink-0 text-sm font-medium">{label}</span>
          <select
            value={sounds[key]}
            onChange={(event) => void updateSound(key, event.target.value)}
            disabled={(key === "workflowSound" && values?.onIdle !== true) || (key === "failSound" && values?.onFailed !== true)}
            className="min-w-0 flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50"
            aria-label={label + " sound"}
          >
            <SoundOptions />
          </select>
          <button type="button" onClick={() => void preview(sounds[key])} disabled={(key === "workflowSound" && values?.onIdle !== true) || (key === "failSound" && values?.onFailed !== true)} className="inline-flex size-9 shrink-0 items-center justify-center rounded-md border border-border text-sm hover:bg-muted/50 disabled:cursor-not-allowed disabled:opacity-40" aria-label={`Play ${label} sound`} title={`Play ${label} sound`}>
            <span aria-hidden="true">▶</span>
          </button>
        </div>
      ))}
    </div>
  );
}

export default definePluginApp((app) => {
  app.contentScripts.register({
    id: "bell-bridge",
    mount({ signal }) {
      let active = true;
      const cleanupUnlock = setupAudioUnlockListeners();
      const wait = (ms: number) => new Promise<void>((resolve) => {
        const timer = window.setTimeout(resolve, ms);
        signal.addEventListener("abort", () => { window.clearTimeout(timer); resolve(); }, { once: true });
      });
      async function openEventStream() {
        let retry = 1000;
        while (active && !signal.aborted) {
          try {
            const response = await fetch("/api/v1/plugins/bell/http/events", { signal, headers: { accept: "text/event-stream" }, credentials: "same-origin" });
            if (!response.ok || !response.body) throw new Error("SSE HTTP " + response.status);
            retry = 1000;
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = "";
            while (active && !signal.aborted) {
              const { done, value } = await reader.read();
              if (done) break;
              buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
              let end: number;
              while ((end = buffer.indexOf("\n\n")) !== -1) {
                const frame = buffer.slice(0, end);
                buffer = buffer.slice(end + 2);
                const data = frame.split("\n").filter((line) => line.startsWith("data: ")).map((line) => line.slice(6)).join("\n");
                if (!data) continue;
                try {
                  const event = JSON.parse(data);
                  if (event?.ring && event?.sound && (event.trigger !== "hidden-only" || document.hidden)) {
                    const amount = Number.parseFloat(String(event.volume ?? "0.8"));
                    await playBellSound(event.sound, Number.isFinite(amount) ? Math.max(0, Math.min(1, amount)) : 0.8);
                  }
                } catch {}
              }
            }
            try { await reader.cancel(); } catch {}
          } catch {
            if (signal.aborted) break;
            await wait(retry);
            retry = Math.min(retry * 2, 15000);
          }
        }
      }
      void openEventStream();
      const ping = async () => {
        if (signal.aborted) return;
        try {
          await fetch("/api/v1/plugins/bell/http/status-ping", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(getAudioDiagnosticStatus()), signal, credentials: "same-origin" });
        } catch {}
      };
      void ping();
      const interval = window.setInterval(ping, 30000);
      return () => { active = false; window.clearInterval(interval); cleanupUnlock(); };
    },
  });
  app.slots.settingsSection({
    id: "bell-preview",
    component: BellSettingsSection,
  });
});
