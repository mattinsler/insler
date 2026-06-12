import { Contract } from '@insler/rpc/contract';
import { z } from 'zod';

/**
 * Caller identity. Declared as contract context (design decision #2: context is
 * part of the contract), so every handler receives it as a typed parameter and
 * the propagator moves it across the wire — it is never smuggled in as input.
 */
export const IdentitySchema = z.object({
  userId: z.string(),
  orgId: z.string().optional(),
});
export type Identity = z.infer<typeof IdentitySchema>;

/** Metadata describing a stored file (without its contents). */
export const FileInfoSchema = z.object({
  path: z.string(),
  size: z.number().int().nonnegative(),
  etag: z.string(),
  contentType: z.string(),
  updatedAt: z.date(),
});
export type FileInfo = z.infer<typeof FileInfoSchema>;

/** A stored file together with its contents. */
export const FileContentSchema = FileInfoSchema.extend({
  content: z.string(),
});
export type FileContent = z.infer<typeof FileContentSchema>;

/** Payload for the `FileNotFound` error, shared by the lookup methods. */
export const FileNotFoundSchema = z.object({ path: z.string() });

/**
 * The file-service contract: the single shared truth both the host and any
 * client derive from. Pure data (design decision #1) — no transport, no
 * implementation, just methods + zod schemas + context + typed errors.
 */
export const fileServiceContract = Contract.create('file-service', {
  version: '1.0.0',
  context: { identity: IdentitySchema },
  schemas: {
    Identity: IdentitySchema,
    FileInfo: FileInfoSchema,
    FileContent: FileContentSchema,
  },
  methods: {
    writeFile: {
      description: 'Create or overwrite a file at the given path.',
      input: z.object({
        path: z.string().min(1),
        content: z.string(),
        contentType: z.string().optional(),
      }),
      output: FileInfoSchema,
    },
    readFile: {
      description: 'Read a file and its contents.',
      input: z.object({ path: z.string().min(1) }),
      output: FileContentSchema,
      errors: { FileNotFound: FileNotFoundSchema },
    },
    statFile: {
      description: 'Fetch metadata for a file without transferring its contents.',
      input: z.object({ path: z.string().min(1) }),
      output: FileInfoSchema,
      errors: { FileNotFound: FileNotFoundSchema },
    },
    deleteFile: {
      description: 'Remove a file. Deleting a missing file is an error.',
      input: z.object({ path: z.string().min(1) }),
      errors: { FileNotFound: FileNotFoundSchema },
    },
    listFiles: {
      description: 'List file metadata, optionally filtered by a path prefix.',
      input: z.object({ prefix: z.string().optional() }),
      output: z.object({ files: z.array(FileInfoSchema) }),
    },
    watchFiles: {
      kind: 'serverStream',
      description: 'Stream a snapshot of file metadata, one entry at a time.',
      input: z.object({ prefix: z.string().optional() }),
      output: FileInfoSchema,
    },
  },
});

export type FileServiceContract = typeof fileServiceContract;
