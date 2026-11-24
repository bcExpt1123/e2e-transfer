/** Save straight into a folder the user picks (Chromium). Constant memory. */
import { DirectorySink, type DirHandleLike } from './shared/directory.ts';

interface PickerWindow {
  showDirectoryPicker(options?: { mode?: 'read' | 'readwrite'; id?: string }): Promise<DirHandleLike>;
}

export function fsAccessAvailable(): boolean {
  return typeof window !== 'undefined' && 'showDirectoryPicker' in window;
}

/**
 * Ask the user for a folder. Must be called from a user gesture (a click).
 * Rejects with an AbortError DOMException when the user dismisses the picker.
 */
export async function pickDirectorySink(): Promise<DirectorySink> {
  const root = await (window as unknown as PickerWindow).showDirectoryPicker({
    mode: 'readwrite',
    id: 'e2e-transfer',
  });
  return new DirectorySink('fs-access', root, { collisions: 'rename' });
}
