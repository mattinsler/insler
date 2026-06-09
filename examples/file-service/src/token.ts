import { type Module, type Token, module, token } from '@insler/di';
import type { Contract } from '@insler/rpc-contract';

import type { FileServiceContract } from './contract.js';
import { type FileStore, InMemoryFileStore, createFileService } from './file-service.js';

/**
 * Public DI surface for the file service. A consuming application composes this
 * module into its own container; the service framework deliberately does not do
 * the wiring (design decision #5: DI is a DI concern). These tokens are the
 * seams the application resolves against.
 */

/** The storage backend. Override it to swap the in-memory store for a real one. */
export const fileStoreToken: Token<FileStore> = token<FileStore>('file-service/store');

/** The ready-to-host handlers, matching `Contract.Handlers<FileServiceContract>`. */
export const fileServiceToken: Token<Contract.Handlers<FileServiceContract>> =
  token<Contract.Handlers<FileServiceContract>>('file-service/handlers');

/**
 * Wire the file service into a container: `container().use(fileServiceModule())`.
 *
 * It registers a default in-memory store and builds the handlers on top of it.
 * Because the container is first-registration-wins, an app that wants a
 * different backend just provides `fileStoreToken` *before* applying this
 * module — the default below is then skipped and the handlers pick up the
 * app's store automatically.
 */
export const fileServiceModule: Module = module((builder) =>
  builder
    .provide(fileStoreToken, () => new InMemoryFileStore())
    .provide(fileServiceToken, [fileStoreToken], (store) => createFileService(store))
);
