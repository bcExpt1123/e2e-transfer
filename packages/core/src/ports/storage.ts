/** Port for storage adapters (docs/ARCHITECTURE.md § Adapter interfaces). */
export interface FileMeta {
  /** Relative path, `/`-separated, already validated by core. */
  path: string;
  size: number;
  mime: string;
}

export interface FileSink {
  readonly id: string;
  /** Called once per file after the user accepts. */
  open(meta: FileMeta): Promise<SinkWriter>;
}

export interface SinkWriter {
  write(chunk: Uint8Array, offset: number): Promise<void>;
  close(): Promise<void>;
  abort(reason?: unknown): Promise<void>;
}
