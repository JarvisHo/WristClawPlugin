import type { PluginRuntime } from "openclaw/plugin-sdk";

let runtime: PluginRuntime | null = null;

export function setWristClawRuntime(next: PluginRuntime) {
  runtime = next;
}

export function getWristClawRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("WristClaw runtime not initialized");
  }
  return runtime;
}
