import { describe, expect, it } from 'vitest';
import { isDialogOpen } from './focus';

describe('isDialogOpen', () => {
  it('detects open dialogs and alert dialogs only', () => {
    document.body.innerHTML = '<div role="menu" data-state="open"></div><div role="dialog" data-state="closed"></div>';
    expect(isDialogOpen()).toBe(false);
    document.body.innerHTML = '<div role="dialog" data-state="open"></div>';
    expect(isDialogOpen()).toBe(true);
    document.body.innerHTML = '<div role="alertdialog" data-state="open"></div>';
    expect(isDialogOpen()).toBe(true);
    document.body.innerHTML = '';
  });
});
