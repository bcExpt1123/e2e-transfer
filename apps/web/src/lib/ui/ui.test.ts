import { fireEvent, render, screen } from '@testing-library/svelte';
import { createRawSnippet } from 'svelte';
import { describe, expect, it, vi } from 'vitest';
import { Button, FileList, Progress, StatusStepper } from './index.ts';

const text = (s: string) => createRawSnippet(() => ({ render: () => `<span>${s}</span>` }));

describe('Button', () => {
  it('renders a type=button with its content and handles clicks', async () => {
    const onclick = vi.fn();
    render(Button, { children: text('Go'), onclick });
    const btn = screen.getByRole('button', { name: 'Go' });
    expect(btn.getAttribute('type')).toBe('button');
    await fireEvent.click(btn);
    expect(onclick).toHaveBeenCalledOnce();
  });

  it('forwards the disabled state to the native button', () => {
    // jsdom still dispatches synthetic clicks to disabled buttons; browsers don't, so assert the attribute.
    render(Button, { children: text('Go'), disabled: true });
    expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('FileList', () => {
  const items = [
    { path: 'a.txt', size: 1500 },
    { path: 'dir/b.bin', size: 2_000_000 },
  ];

  it('lists paths and human sizes', () => {
    render(FileList, { items, label: 'Files' });
    const list = screen.getByRole('list', { name: 'Files' });
    expect(list.querySelectorAll('li')).toHaveLength(2);
    expect(screen.getByText('dir/b.bin')).toBeTruthy();
    expect(screen.getByText('2 MB')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('offers accessible remove buttons when onremove is set', async () => {
    const onremove = vi.fn();
    render(FileList, { items, label: 'Files', onremove, removeLabel: (p: string) => `Remove ${p}` });
    await fireEvent.click(screen.getByRole('button', { name: 'Remove dir/b.bin' }));
    expect(onremove).toHaveBeenCalledWith(1);
  });
});

describe('Progress', () => {
  it('exposes value to assistive tech', () => {
    render(Progress, { value: 40, label: 'Upload' });
    const bar = screen.getByRole('progressbar', { name: 'Upload' });
    expect(bar.getAttribute('aria-valuenow')).toBe('40');
  });
});

describe('StatusStepper', () => {
  it('marks the current step', () => {
    render(StatusStepper, { steps: ['One', 'Two', 'Three'], current: 1, label: 'Status' });
    const current = screen.getByText('Two').closest('li');
    expect(current?.getAttribute('aria-current')).toBe('step');
    expect(screen.getByText('One').closest('li')?.getAttribute('aria-current')).toBeNull();
  });
});
