import { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess';
import { CommandRouter, bindPluginCommands } from './command-router.mjs';
import { createChildProcessFacade } from './plugin-process.mjs';
import { createLinuxCommandBackend } from './linux-backend.mjs';
import { createLinuxControl, registerLinuxControlRoutes } from '../linux/control.mjs';

export default class OhSubprocessRuntime extends SubprocessRuntime {
  constructor(ctx, config = {}) {
    if (process.platform !== 'openharmony' && globalThis[Symbol.for('dsh.go.ohos.sim')] !== true) throw new Error('iOS 虚拟进程后端只能由 iOS profile 或仿真显式启用');
    super(ctx);
    const onSpillFailure = error => ctx.logger.error('iOS 虚拟进程无法保留完整输出', error);
    // iOS: its own Linux guest takes gh, python3 and pip through the virtual shell.
    this.backend = new CommandRouter({ ...config, onSpillFailure });
    this.pluginProcess = createChildProcessFacade(spec => this.backend.spawnPlugin(spec));
    this.capabilities = this.backend.capabilities;
    ctx.effect(() => () => this.backend.dispose(), 'ohos subprocess teardown');
    ctx.effect(() => bindPluginCommands(this.backend), 'ohos plugin command binding');
  }
  get temporaryRoot() { return this.backend.temporaryRoot; }
  get guestMetadata() { return this.backend.virtual.guestMetadata; }
  isHostPath(path) { return this.backend.roots.some(root => path === root || path.startsWith(root + "/")); }
  spawn(spec) { return this.backend.spawn(spec); }
  prepare(...args) { return this.backend.prepare(...args); }
  resolveExecutable(...args) { return this.backend.resolveExecutable(...args); }
  terminalEnvironment(...args) { return this.backend.terminalEnvironment(...args); }
  spawnTerminal(...args) { return this.backend.spawnTerminal(...args); }
}
