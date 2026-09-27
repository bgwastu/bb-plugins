import type { BbPluginApi } from "@get-bb/plugin-sdk";

export default function plugin(bb: BbPluginApi) {
  bb.experimental_aiServices.register({
    id: "groq-whisper",
    displayName: "Groq Whisper",
    kinds: ["voice"],
  });
}
