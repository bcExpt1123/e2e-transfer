/**
 * Short-code mode (docs/PROTOCOL.md §6). A separate entry point,
 * `@e2e-transfer/core/code`, so the app can load ristretto255 on demand.
 */

export { completeWord, formatCode, generateCode, parseCode, resolveWord, type ShortCode } from './code.ts';
export {
  CodeReceiver,
  type CodeReceiverOptions,
  CodeSender,
  type CodeSenderOptions,
} from './code-session.ts';
export { CODE_WORDS } from './wordlist.ts';
