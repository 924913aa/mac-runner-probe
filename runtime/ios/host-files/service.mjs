import { constants } from 'node:fs';
import { cp, lstat, mkdir, open, readdir, realpath, rename, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export const operations = Object.freeze(['roots', 'list', 'stat', 'read', 'write', 'mkdir', 'copy', 'move', 'remove']);
export const hostError = (code, message) => Object.assign(new Error(message), { code });
const inside = (root, path) => path === root || path.startsWith(root + sep);
const invalid = message => hostError('HOSTFS_INVALID_REQUEST', message);
const kind = entry => entry.isSymbolicLink() ? 'symlink' : entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other';
const missing = error => error.code === 'ENOENT';
const maxBytes = 1024 * 1024;

function integer(value, fallback, maximum) {
  const number = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(number) || number < 0 || number > maximum) throw invalid('Invalid offset, length or limit');
  return number;
}

export function decodeBase64(value) {
  if (typeof value !== 'string' || value.length > 2 * maxBytes || Buffer.from(value, 'base64').toString('base64') !== value) {
    throw invalid('Expected canonical base64 data');
  }
  return Buffer.from(value, 'base64');
}

// Only Swift supplies these roots. Policy is supplied by the tool/guest owner,
// never by the JSON request. Node path checks are partial enforcement: another
// task can still rename directories between a check and the filesystem syscall.
export async function createHostFiles({ containerRoot, workspaceRoot }) {
  if (!isAbsolute(containerRoot ?? '') || !isAbsolute(workspaceRoot ?? '')) throw invalid('Host roots must be absolute directories');
  const root = await realpath(containerRoot);
  const fallbackWorkspace = await realpath(workspaceRoot);
  if (root === sep || !inside(root, fallbackWorkspace) || !(await lstat(root)).isDirectory()) {
    throw invalid('Workspace must belong to the application data container');
  }

  async function canonical(path, followFinal) {
    try {
      if (followFinal) return await realpath(path);
      if (path === root) return root;
      return join(await realpath(dirname(path)), basename(path));
    } catch (error) {
      if (!missing(error)) throw error;
      const parent = dirname(path);
      if (parent === path) throw error;
      return join(await canonical(parent, true), basename(path));
    }
  }

  return Object.freeze({
    async execute(request, policy, signal) {
      signal?.throwIfAborted();
      if (!request || !operations.includes(request.operation)) throw invalid('Unknown host file operation');
      if (!['read-only', 'workspace-write', 'danger-full-access'].includes(policy?.mode)) {
        throw hostError('HOSTFS_POLICY_DENIED', 'A resolved session policy is required');
      }
      for (const key of ['overwrite', 'recursive']) {
        if (request[key] !== undefined && typeof request[key] !== 'boolean') throw invalid(`${key} must be boolean`);
      }
      // Keep the alias usable after an explicitly permitted workspace removal,
      // so a subsequent mkdir/copy can recreate it without restarting the engine.
      const workspace = await canonical(resolve(policy.workspaceRoot ?? fallbackWorkspace), true);
      if (!inside(root, workspace)) throw hostError('HOSTFS_PATH_DENIED', 'Session workspace is outside the application data container');

      async function target(value, followFinal = true) {
        if (typeof value !== 'string' || !value || value.includes('\0')) throw invalid('Expected app:/ or workspace:/ path');
        let path;
        if (value.startsWith('app:/')) path = resolve(root, value.slice(5));
        else if (value.startsWith('workspace:/')) path = resolve(workspace, value.slice(11));
        else if (isAbsolute(value)) path = resolve(value);
        else throw invalid('Expected app:/ or workspace:/ path');
        // realpath also normalizes iOS /var vs /private/var spellings.
        const physical = await canonical(path, followFinal);
        if (!inside(root, physical)) throw hostError('HOSTFS_PATH_DENIED', 'Resolved path leaves the application data container');
        return physical;
      }
      async function writable(path) {
        if (path === root) throw hostError('HOSTFS_ROOT_BUSY', 'The application data container root itself cannot be removed or replaced');
        if (policy.mode === 'danger-full-access') return;
        if (policy.mode === 'workspace-write') {
          // Match the platform's ordinary writable-root grants, while retaining
          // the enclosing application-container boundary even for full access.
          for (const granted of policy.writableRoots ?? [workspace, ...(policy.additionalWritableRoots ?? [])]) {
            const directory = await canonical(resolve(granted), true);
            if (inside(root, directory) && inside(directory, path)) return;
          }
        }
        const mode = policy.mode === 'read-only' ? 'workspace-write or danger-full-access' : 'danger-full-access';
        throw hostError('HOSTFS_POLICY_DENIED', `This mutation exceeds ${policy.mode}. Retry this exact operation with sandbox_permissions=${mode} and justification for one-call approval; from Linux, request approval on the enclosing bash call.`);
      }
      const publicPath = path => path === root ? 'app:/' : 'app:/' + relative(root, path);
      const operation = request.operation;
      if (operation === 'roots') return { containerRoot: root, workspaceRoot: workspace, app: 'app:/', workspace: 'workspace:/' };
      if (operation === 'copy' || operation === 'move') {
        const source = await target(request.source, false);
        await lstat(source);
        let destination = await target(request.destination, false);
        let existing;
        try { existing = await lstat(destination); } catch (error) { if (!missing(error)) throw error; }
        if (existing?.isDirectory()) destination = await target(join(destination, basename(source)), false);
        if (source === destination || inside(source, destination)) throw invalid('Destination must differ from source and must not be inside it');
        await writable(destination);
        if (operation === 'move') await writable(source);
        signal?.throwIfAborted();
        if (!request.overwrite) {
          try { await lstat(destination); throw hostError('EEXIST', 'Destination already exists'); }
          catch (error) { if (!missing(error)) throw error; }
        }
        if (operation === 'copy') {
          // Copy links as links; never traverse a source link into another container.
          await cp(source, destination, { recursive: true, dereference: false, verbatimSymlinks: true,
            force: request.overwrite === true, errorOnExist: request.overwrite !== true });
        } else {
          // Do not silently copy+delete on EXDEV: report the real partial-effect boundary.
          await rename(source, destination);
        }
        return { operation, source: publicPath(source), destination: publicPath(destination) };
      }

      const path = await target(request.path, !['remove', 'stat', 'write', 'mkdir'].includes(operation));
      if (operation === 'stat') {
        const entry = await lstat(path);
        return { path: publicPath(path), type: kind(entry), size: entry.size, modifiedMs: entry.mtimeMs };
      }
      if (operation === 'list') {
        const offset = integer(request.offset, 0, Number.MAX_SAFE_INTEGER);
        const limit = integer(request.limit, 256, 1000);
        if (!limit) throw invalid('List limit must be positive');
        const entries = (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
        return { path: publicPath(path), entries: entries.slice(offset, offset + limit).map(entry => ({ name: entry.name, type: kind(entry) })),
          total: entries.length, nextOffset: offset + limit < entries.length ? offset + limit : null };
      }
      if (operation === 'read') {
        const offset = integer(request.offset, 0, Number.MAX_SAFE_INTEGER);
        const length = integer(request.length, 65536, maxBytes);
        const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          if (!(await file.stat()).isFile()) throw invalid('read requires a regular file');
          const data = Buffer.alloc(length);
          const { bytesRead } = await file.read(data, 0, length, offset);
          return { path: publicPath(path), encoding: 'base64', data: data.subarray(0, bytesRead).toString('base64'),
            offset, bytesRead, nextOffset: offset + bytesRead, eof: offset + bytesRead >= (await file.stat()).size };
        } finally { await file.close(); }
      }
      await writable(path);
      signal?.throwIfAborted();
      if (operation === 'mkdir') await mkdir(path, { recursive: request.recursive === true });
      else if (operation === 'remove') await rm(path, { recursive: request.recursive === true, force: false });
      else if (operation === 'write') {
        if (typeof request.data !== 'string' || !['utf8', 'base64'].includes(request.encoding ?? 'utf8')) throw invalid('write requires data and encoding utf8 or base64');
        const data = request.encoding === 'base64' ? decodeBase64(request.data) : Buffer.from(request.data);
        if (data.length > maxBytes) throw invalid('write supports at most 1 MiB per operation');
        const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK |
          (request.overwrite ? constants.O_TRUNC : constants.O_EXCL);
        const file = await open(path, flags, 0o600);
        try {
          if (!(await file.stat()).isFile()) throw invalid('write requires a regular file');
          await file.writeFile(data);
        } finally { await file.close(); }
        return { operation, path: publicPath(path), bytesWritten: data.length };
      }
      return { operation, path: publicPath(path) };
    },
  });
}

export function errorResult(error) {
  return { code: typeof error?.code === 'string' ? error.code : 'HOSTFS_OPERATION_FAILED',
    message: error instanceof Error ? error.message : String(error) };
}
