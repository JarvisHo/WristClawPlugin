import type { ChannelPlugin, OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { wristclawPlugin } from "./src/channel.js";
import { setWristClawRuntime } from "./src/runtime.js";

const plugin = {
  id: "wristclaw",
  name: "WristClaw",
  description: "WristClaw messaging channel plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setWristClawRuntime(api.runtime);
    api.registerChannel({ plugin: wristclawPlugin as ChannelPlugin });
  },
};

export default plugin;
