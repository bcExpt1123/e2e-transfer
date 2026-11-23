export { DEFAULT_CONFIG, PROTOCOL_VERSION, resolveConfig, type TransferConfig } from './config.ts';
export { Emitter, type EventMap } from './emitter.ts';
export { ErrorCode, isTransferError, TransferError, toTransferError } from './errors.ts';
export type { Signaling, SignalingRoom } from './ports/signaling.ts';
export type { FileMeta, FileSink, SinkWriter } from './ports/storage.ts';
