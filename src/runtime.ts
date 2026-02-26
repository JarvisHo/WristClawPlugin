import type { PluginRuntime } from "openclaw/plugin-sdk";

let runtime: PluginRuntime | null = null;
/** Minimal logger interface matching RuntimeEnv */
export type Logger = { log: (...args: unknown[]) => void; error: (...args: unknown[]) => void };

let runtimeEnv: Logger | null = null;

export function setWristClawRuntime(next: PluginRuntime) {
  runtime = next;
}

export function getWristClawRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("WristClaw runtime not initialized");
  }
  return runtime;
}

export function setRuntimeEnv(env: Logger) {
  runtimeEnv = env;
}

/**
 * Get the RuntimeEnv logger (log/error).
 * Falls back to console if not yet initialized (early startup).
 */
export function getRuntimeEnv(): Logger {
  if (runtimeEnv) return runtimeEnv;
  return { log: console.log, error: console.error };
}
