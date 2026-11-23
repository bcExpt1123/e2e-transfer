import { MemorySink } from '../src/index.ts';
import { fileSinkContract } from './contract.ts';

fileSinkContract('memory', () => {
  const sink = new MemorySink();
  return {
    sink,
    async readBack(path) {
      const blob = sink.files.get(path);
      return blob ? new Uint8Array(await blob.arrayBuffer()) : undefined;
    },
  };
});
