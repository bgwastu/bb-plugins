// bb-plugin-plain-copy — make timeline selection copies produce plain text.
//
// bb serializes a timeline text selection to Markdown and writes it to the
// clipboard as `text/plain` (plus DOM HTML as `text/html`) from a document
// `copy` listener. That means pasting a copied message anywhere plain yields
// `**bold**`, `- bullets`, `$$tex$$`, and so on.
//
// This plugin mounts a window-level `copy` listener. Document listeners run
// before window ones, so bb's serializer has already set the clipboard data and
// called preventDefault by the time this runs. We overwrite just the plain-text
// flavor with the browser's own selection text and leave the HTML flavor alone,
// so rich paste targets keep their formatting.

import { definePluginApp } from "@get-bb/plugin-sdk/app";

const SCRIPT_ID = "plain-text-copy";

function plainSelectionText(): string | null {
  const selection = window.getSelection();
  if (selection === null || selection.isCollapsed || selection.rangeCount === 0) {
    return null;
  }
  const text = selection.toString();
  return text.trim().length === 0 ? null : text;
}

export default definePluginApp((app) => {
  app.contentScripts.register({
    id: SCRIPT_ID,
    mount({ signal }) {
      const onCopy = (event: ClipboardEvent) => {
        // Only touch copies bb's timeline serializer took over, and never a
        // copy another handler already owns exclusively.
        if (!event.defaultPrevented) return;
        const clipboard = event.clipboardData;
        if (clipboard === null) return;
        const text = plainSelectionText();
        if (text === null) return;
        clipboard.setData("text/plain", text);
      };

      window.addEventListener("copy", onCopy);
      const dispose = () => window.removeEventListener("copy", onCopy);
      signal.addEventListener("abort", dispose, { once: true });
      return dispose;
    },
  });
});
