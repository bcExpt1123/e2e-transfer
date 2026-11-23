import type { ErrorCode } from '@e2e-transfer/core';
import type { ErrorAction } from '../error-actions.ts';

/**
 * English source strings. Other locales must satisfy `Messages`, so a missing
 * key is a compile error. Keep copy plain and short (docs/UX.md § microcopy).
 */
export const en = {
  appName: 'e2e-transfer',
  tagline: 'Send files directly to another device, end-to-end encrypted.',
  common: {
    close: 'Close',
    cancel: 'Cancel',
  },
  header: {
    settings: 'Settings',
    about: 'How it works',
  },
  send: {
    dropTitle: 'Drop files or a folder here',
    dropHint: 'You can also paste files',
    chooseFiles: 'Choose files',
    chooseFolder: 'Choose folder',
    trust: 'Files go straight to the other device, end-to-end encrypted. Nothing is uploaded.',
    selected: 'Selected files',
    summary: (count: number, size: string) => `${count} ${count === 1 ? 'file' : 'files'} · ${size}`,
    added: (count: number) => `Added ${count} ${count === 1 ? 'file' : 'files'}`,
    remove: (name: string) => `Remove ${name}`,
    clear: 'Clear all',
    createLink: 'Create link',
    preview: 'Sending arrives in the next preview. Your files stay on this device.',
  },
  receive: {
    title: 'Incoming transfer',
    preview: 'Receiving arrives in the next preview. Ask the sender to try again later.',
  },
  status: {
    waiting: 'Waiting for the other device',
    connecting: 'Connecting directly',
    secured: 'Secured',
  },
  settings: {
    title: 'Settings',
    description: 'Saved on this device only.',
    theme: 'Theme',
    themeSystem: 'System',
    themeLight: 'Light',
    themeDark: 'Dark',
    language: 'Language',
  },
  about: {
    title: 'How it works',
    steps: [
      'Pick files. A secret link is created on your device.',
      'Share the link with the person you trust. The secret part never reaches any server.',
      'Their browser connects directly to yours and the files are sent end-to-end encrypted.',
    ],
    note: 'Anyone with the link can receive the files, so share it like a password. Keep this tab open until the transfer finishes.',
  },
  footer: 'End-to-end encrypted · No uploads · No accounts',
  errors: {
    SIGNALING_UNREACHABLE: "Can't reach the matchmaking network.",
    PEER_TIMEOUT: "The other device hasn't connected yet.",
    ICE_FAILED: 'Your networks block direct connections.',
    LINK_INVALID: 'This link is incomplete or damaged.',
    DECLINED: 'The other device declined.',
    PROTOCOL_ERROR: 'The transfer was interrupted for safety.',
    STORAGE_QUOTA: 'Not enough space to save these files.',
    CANCELLED: 'Transfer cancelled.',
    VERSION_MISMATCH: 'The other device uses an incompatible version.',
  } satisfies Record<ErrorCode, string>,
  errorActions: {
    retry: 'Retry',
    useQr: 'Use QR code instead',
    keepWaiting: 'Keep waiting',
    copyLink: 'Copy link again',
    configureTurn: 'Configure a relay',
    learnMore: 'Learn more',
    askNewLink: 'Ask for a new link',
    startOver: 'Start over',
    tryAgain: 'Try again',
    chooseFolder: 'Choose another folder',
    reload: 'Reload page',
  } satisfies Record<ErrorAction, string>,
};

export type Messages = typeof en;
