import { definePluginApp } from "@get-bb/plugin-sdk/app";

type MutableMediaDevices = MediaDevices & {
  getUserMedia: MediaDevices["getUserMedia"];
};

export default definePluginApp((app) => {
  app.contentScripts.register({
    id: "voice-groq-microphone-normalization",
    mount() {
      const mediaDevices = navigator.mediaDevices as MutableMediaDevices | undefined;
      if (!mediaDevices?.getUserMedia) return;

      const original = mediaDevices.getUserMedia.bind(mediaDevices);
      const supported = mediaDevices.getSupportedConstraints?.() ?? {};
      const normalized: MediaDevices["getUserMedia"] = async (constraints) => {
        if (!constraints?.audio) return original(constraints);

        const requested = typeof constraints.audio === "object" ? constraints.audio : {};
        const audio: MediaTrackConstraints = { ...requested };
        if (supported.autoGainControl && audio.autoGainControl === undefined) audio.autoGainControl = true;
        if (supported.noiseSuppression && audio.noiseSuppression === undefined) audio.noiseSuppression = true;
        if (supported.echoCancellation && audio.echoCancellation === undefined) audio.echoCancellation = true;
        if (supported.channelCount && audio.channelCount === undefined) audio.channelCount = 1;

        return original({ ...constraints, audio });
      };

      mediaDevices.getUserMedia = normalized;
      return () => {
        if (mediaDevices.getUserMedia === normalized) mediaDevices.getUserMedia = original;
      };
    },
  });
});
