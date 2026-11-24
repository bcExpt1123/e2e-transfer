export type { FileMeta, FileSink, SinkWriter } from '@e2e-transfer/core';
export { fsAccessAvailable, pickDirectorySink } from './fs-access.ts';
export { MemorySink } from './memory.ts';
export { clearOpfs, openOpfsSink, opfsAvailable } from './opfs.ts';
export {
  DirectorySink,
  type DirectorySinkOptions,
  type DirHandleLike,
  type FileHandleLike,
  type SavedFile,
  type WritableLike,
} from './shared/directory.ts';
