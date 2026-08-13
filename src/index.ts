import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerLifecycleRecording } from "./lifecycle/pi-lifecycle.js";

/** Register the pi-ledger extension. */
export default function registerPiLedger(pi: ExtensionAPI): void {
  registerLifecycleRecording(pi);
}
