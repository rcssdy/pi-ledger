import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerJournalExtension } from "./extension.js";

export default function registerPiLedger(pi: ExtensionAPI): void {
  registerJournalExtension(pi);
}
