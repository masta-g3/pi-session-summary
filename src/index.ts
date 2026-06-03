import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const EXTENSION_KEY = Symbol.for("pi-tldr-lite.extension.loaded");
type TldrLiteGlobal = typeof globalThis & { [EXTENSION_KEY]?: true };

export default function tldrLite(pi: ExtensionAPI) {
  const globalState = globalThis as TldrLiteGlobal;
  if (globalState[EXTENSION_KEY]) return;
  globalState[EXTENSION_KEY] = true;

  pi.on("session_shutdown", () => {
    delete globalState[EXTENSION_KEY];
  });
}
