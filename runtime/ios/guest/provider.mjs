import { randomUUID } from 'node:crypto';
import { chmod, copyFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { guestMetadataView, guestInstallRequiredMessage, guestSuspendedMessage } from './metadata.mjs';
import { SerialGuestChannel } from './channel.mjs';
import { GuestPaths, guestEnvironment } from './paths.mjs';

export const guestUnavailableMessage = '这个命令在 iOS 本机不可用，可以连接电脑执行；也可以安装可选的 Linux 环境后重试。';
const unsupported = 'ERR_IOS_GUEST_MIXED: 此脚本将 Node Worker 与 Linux 命令或无法安全判定的执行混用；请拆成独立工具调用，未执行此脚本。';

export class GuestProvider {
  #channel;
  #queue;
  #forbiddenRoots;
  #readMetadata;
  #temporaryRoot;

  // channel is a trusted main-process native transport, never a model/config
  // supplied object. Merely creating this provider does not boot the guest.
  constructor({ channel, readMetadata, cleanupDeadline, temporaryRoot, forbiddenRoots = [] } = {}) {
    if (readMetadata !== undefined && typeof readMetadata !== 'function') throw new TypeError('Invalid trusted guest metadata reader');
    this.#readMetadata = readMetadata;
    this.#temporaryRoot = temporaryRoot;
    this.#channel = channel;
    this.#queue = channel && new SerialGuestChannel(channel, { cleanupDeadline });
    this.#forbiddenRoots = [...forbiddenRoots];
  }

  get metadata() {
    let cached;
    try { cached = this.#readMetadata?.(); } catch {}
    const value = guestMetadataView(cached, !!this.#queue, this.#queue?.state);
    return this.#channel?.suspended ? Object.freeze({ ...value, state: 'suspended',
      suspended: true, suspendedReason: 'crashed', available: false }) : value;
  }

  async execute({ decision, argv, policy, rootPermission, cwd, temporaryRoot, env, stdin, signal, graceMs, output }) {
    const fail = async (text, exitCode) => {
      await output('stderr', Buffer.from(text + '\n'));
      return { exitCode, signal: null };
    };
    if (decision.route === 'unsupported') return fail(unsupported, 2);
    const metadata = this.metadata;
    if (metadata.suspended) return fail(guestSuspendedMessage, 126);
    if (!this.#queue) return fail(guestUnavailableMessage, 127);
    if (this.#readMetadata) {
      if (metadata.installed !== 'present') return fail(metadata.installed === 'absent' ? guestInstallRequiredMessage :
        'ERR_IOS_GUEST_INSTALL_INVALID: Linux 安装状态不完整，请在设置中重新安装 Linux 环境。', 127);
    }
    if (!Array.isArray(argv) || !['bash', 'sh'].includes(argv[0])
      || [...argv].some(value => typeof value !== 'string' || value.includes('\0'))) {
      return fail('ERR_IOS_GUEST_ROUTE: Linux shell 路由仅接受有效的 bash/sh 参数数组。', 2);
    }
    // Only the policy consumed from a one-use approved confinement ticket may
    // authorize native work. No direct spawn receives an inferred wider mode.
    if (!policy || !['read-only', 'workspace-write', 'danger-full-access'].includes(policy.mode)) {
      return fail('EACCES: IOS_GUEST_POLICY_REQUIRED: Linux 执行需要现有沙箱审批产生的受限票据。', 126);
    }
    // Full access cannot widen the native guest's workspace/temp mounts.
    const mode = policy.mode === 'read-only' ? 'read-only' : 'workspace-write';
    const paths = new GuestPaths({ workspaceRoot: policy.workspaceRoot, temporaryRoot: this.#temporaryRoot, forbiddenRoots: this.#forbiddenRoots });
    const guestCwd = paths.toGuest(cwd);
    if (guestCwd !== '/workspace' && !guestCwd.startsWith('/workspace/')) {
      return fail('ERR_IOS_GUEST_CWD: 请从工作区启动；需要临时目录时在脚本内执行 cd /tmp。', 2);
    }
    let session, shimRoot, cleaning;
    const cleanup = () => cleaning ??= (async () => {
      try { await session?.close(); }
      finally { if (shimRoot) await rm(shimRoot, { recursive: true, force: true }); }
    })();
    try {
      let guestEnv = guestEnvironment(env, guestCwd);
      // Resolve the trusted owner per task: plugin activation may follow provider
      // construction. Host authorization needs the original approved policy, not
      // the narrower mode used by the native guest mounts.
      const owner = globalThis[Symbol.for('dsh.go.ios.host-files')];
      if (owner) {
        session = await owner.openGuestSession({ policy, signal });
        const temporary = paths.mounts.find(row => row.guest === '/tmp').host;
        const name = '.hostfs-' + randomUUID();
        const directory = join(temporary, name);
        await mkdir(directory, { mode: 0o700 });
        shimRoot = directory;
        const bin = join(shimRoot, 'bin');
        await mkdir(bin, { mode: 0o700 });
        const shim = join(bin, 'hostfs');
        await copyFile(new URL('../host-files/hostfs.sh', import.meta.url), shim);
        await chmod(shim, 0o755);
        // Only these owner-provided fields cross the environment allowlist.
        // Credentials stay in task memory and never enter the shim file.
        guestEnv = Object.freeze({ ...guestEnv,
          DSH_HOSTFS_URL: session.env.DSH_HOSTFS_URL,
          DSH_HOSTFS_TOKEN: session.env.DSH_HOSTFS_TOKEN,
          PATH: `/tmp/${name}/bin:${guestEnv.PATH}`,
        });
      }
      const request = Object.freeze({
        id: randomUUID(),
        argv: Object.freeze(['/bin/sh', ...argv.slice(1)]),
        cwd: guestCwd, stdin,
        env: guestEnv,
        mode, rootWritable: rootPermission !== undefined,
        ...(rootPermission === undefined ? {} : { expectedRootDevice: rootPermission.expectedRootDevice, expectedRootInode: rootPermission.expectedRootInode }),
        mounts: Object.freeze(paths.mounts.map(row => Object.freeze({ ...row, readOnly: mode === 'read-only' }))),
        cleanup,
      });
      return await this.#queue.execute(request, { signal, graceMs, output });
    } finally {
      // Also covers queued cancellation and synchronous native startup failure.
      await cleanup();
    }
  }

  dispose() { return this.#queue?.dispose() ?? Promise.resolve(); }
}
