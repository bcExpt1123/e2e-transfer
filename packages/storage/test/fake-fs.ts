import type { DirHandleLike, FileHandleLike, WritableLike } from '../src/index.ts';

const notFound = () => new DOMException('not found', 'NotFoundError');

/** In-memory FileSystemDirectoryHandle with swap-file semantics like Chromium's createWritable. */
export class FakeDir implements DirHandleLike {
  readonly dirs = new Map<string, FakeDir>();
  readonly files = new Map<string, FakeFile>();
  writes = 0;

  constructor(readonly name: string) {}

  async getDirectoryHandle(name: string, o?: { create?: boolean }): Promise<FakeDir> {
    let d = this.dirs.get(name);
    if (!d) {
      if (this.files.has(name)) throw new DOMException('is a file', 'TypeMismatchError');
      if (!o?.create) throw notFound();
      d = new FakeDir(name);
      this.dirs.set(name, d);
    }
    return d;
  }

  async getFileHandle(name: string, o?: { create?: boolean }): Promise<FileHandleLike> {
    let f = this.files.get(name);
    if (!f) {
      if (this.dirs.has(name)) throw new DOMException('is a folder', 'TypeMismatchError');
      if (!o?.create) throw notFound();
      f = new FakeFile(name, this);
      this.files.set(name, f);
    }
    return f;
  }

  async removeEntry(name: string, o?: { recursive?: boolean }): Promise<void> {
    if (this.files.delete(name)) return;
    const d = this.dirs.get(name);
    if (!d) throw notFound();
    if (!o?.recursive && (d.files.size || d.dirs.size))
      throw new DOMException('not empty', 'InvalidModificationError');
    this.dirs.delete(name);
  }

  /** Read back a nested path, or undefined. */
  read(path: string): Uint8Array | undefined {
    const parts = path.split('/');
    const file = parts.pop() ?? '';
    let d: FakeDir | undefined = this;
    for (const p of parts) d = d?.dirs.get(p);
    return d?.files.get(file)?.data;
  }
}

class FakeFile implements FileHandleLike {
  data = new Uint8Array(0);
  constructor(
    readonly name: string,
    readonly parent: FakeDir,
  ) {}

  async createWritable(): Promise<WritableLike> {
    const parts: Uint8Array[] = [];
    return {
      write: async (d) => {
        this.parent.writes++;
        parts.push(d.slice());
      },
      close: async () => {
        const total = parts.reduce((n, p) => n + p.byteLength, 0);
        const out = new Uint8Array(total);
        let at = 0;
        for (const p of parts) {
          out.set(p, at);
          at += p.byteLength;
        }
        this.data = out;
      },
      abort: async () => {
        parts.length = 0;
      },
    };
  }

  async getFile(): Promise<File> {
    return new File([this.data], this.name);
  }
}
