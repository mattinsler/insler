import type { Contract } from '@insler/rpc-contract';

import type { FileContent, FileInfo, FileServiceContract, Identity } from './contract.js';

/**
 * Storage seam for the file service. Tenant-scoped so the identity carried in
 * contract context actually does something: two orgs never see each other's
 * files. Swap the in-memory implementation for S3/GCS/disk without touching the
 * handlers.
 */
export interface FileStore {
  put(tenant: string, path: string, content: string, contentType: string): Promise<FileInfo>;
  get(tenant: string, path: string): Promise<FileContent | undefined>;
  stat(tenant: string, path: string): Promise<FileInfo | undefined>;
  delete(tenant: string, path: string): Promise<boolean>;
  list(tenant: string, prefix?: string): Promise<FileInfo[]>;
}

/** A zero-dependency `FileStore` backing the example. */
export class InMemoryFileStore implements FileStore {
  // key = `${tenant} ${path}`
  readonly #files = new Map<string, FileContent>();

  async put(tenant: string, path: string, content: string, contentType: string): Promise<FileInfo> {
    const file: FileContent = {
      path,
      content,
      contentType,
      size: Buffer.byteLength(content, 'utf8'),
      etag: Bun.hash(content).toString(16),
      updatedAt: new Date(),
    };
    this.#files.set(key(tenant, path), file);
    return info(file);
  }

  async get(tenant: string, path: string): Promise<FileContent | undefined> {
    const file = this.#files.get(key(tenant, path));
    return file ? { ...file } : undefined;
  }

  async stat(tenant: string, path: string): Promise<FileInfo | undefined> {
    const file = this.#files.get(key(tenant, path));
    return file ? info(file) : undefined;
  }

  async delete(tenant: string, path: string): Promise<boolean> {
    return this.#files.delete(key(tenant, path));
  }

  async list(tenant: string, prefix = ''): Promise<FileInfo[]> {
    const scope = `${tenant} `;
    const matches: FileInfo[] = [];
    for (const [k, file] of this.#files) {
      if (k.startsWith(scope) && file.path.startsWith(prefix)) {
        matches.push(info(file));
      }
    }
    return matches.sort((a, b) => a.path.localeCompare(b.path));
  }
}

function key(tenant: string, path: string): string {
  return `${tenant} ${path}`;
}

function info(file: FileContent): FileInfo {
  const { content: _content, ...rest } = file;
  return rest;
}

/** Tenancy is derived from caller identity, never from method input. */
function tenantOf(identity: Identity): string {
  return identity.orgId ?? identity.userId;
}

/** A contract error the host turns into a typed `FileNotFound` on the wire. */
function fileNotFound(path: string): Contract.Errors<FileServiceContract, 'readFile'> {
  return { _tag: 'FileNotFound', payload: { path } };
}

/**
 * Build the file-service handlers over a `FileStore`. The result is purely
 * contract-shaped (design decision #3): every method is `(context, input)`,
 * with no transport or middleware awareness, so it can be unit-tested by plain
 * function calls. Wiring it into a container lives in `token.ts`.
 */
export function createFileService(store: FileStore): Contract.Handlers<FileServiceContract> {
  return {
    async writeFile(context, input) {
      const contentType = input.contentType ?? 'application/octet-stream';
      return store.put(tenantOf(context.identity), input.path, input.content, contentType);
    },

    async readFile(context, input) {
      const file = await store.get(tenantOf(context.identity), input.path);
      if (!file) throw fileNotFound(input.path);
      return file;
    },

    async statFile(context, input) {
      const stat = await store.stat(tenantOf(context.identity), input.path);
      if (!stat) throw fileNotFound(input.path);
      return stat;
    },

    async deleteFile(context, input) {
      const existed = await store.delete(tenantOf(context.identity), input.path);
      if (!existed) throw fileNotFound(input.path);
    },

    async listFiles(context, input) {
      return { files: await store.list(tenantOf(context.identity), input.prefix) };
    },

    async *watchFiles(context, input) {
      for (const file of await store.list(tenantOf(context.identity), input.prefix)) {
        yield file;
      }
    },
  };
}
