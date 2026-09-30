import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { confirmDialogEx } from '../stores/dialog-store';
import { DialogHost } from './DialogHost';

describe('DialogHost', () => {
  it('asks for one of several answers', async () => {
    render(<DialogHost />);
    let answer: Promise<unknown> = Promise.resolve();
    act(() => {
      answer = confirmDialogEx({
        title: 'An agent asks',
        description: 'Deploy?',
        input: { kind: 'options', options: ['Yes', 'Later'] },
        confirmLabel: 'Answer',
      });
    });
    const confirm = await screen.findByRole('button', { name: 'Answer' });
    expect(confirm).toBeDisabled();
    await userEvent.click(screen.getByRole('radio', { name: 'Later' }));
    await userEvent.click(screen.getByRole('button', { name: 'Answer' }));
    await expect(answer).resolves.toEqual({ confirmed: true, checked: false, value: 'Later' });
  });

  it('asks for a free answer and submits it with Enter', async () => {
    render(<DialogHost />);
    let answer: Promise<unknown> = Promise.resolve();
    act(() => {
      answer = confirmDialogEx({ title: 'Name?', input: { kind: 'text', placeholder: 'A name' } });
    });
    await userEvent.type(await screen.findByPlaceholderText('A name'), ' api {Enter}');
    await expect(answer).resolves.toEqual({ confirmed: true, checked: false, value: 'api' });
  });

  it('offers a secondary button and shows code', async () => {
    render(<DialogHost />);
    let answer: Promise<unknown> = Promise.resolve();
    act(() => {
      answer = confirmDialogEx({
        title: 'Allow Reset?',
        code: '{\n  "table": "users"\n}',
        confirmLabel: 'Allow once',
        secondaryLabel: 'Always allow',
        cancelLabel: 'Deny',
      });
    });
    expect(await screen.findByTestId('confirm-dialog-code')).toHaveTextContent('"table": "users"');
    await userEvent.click(screen.getByRole('button', { name: 'Always allow' }));
    await expect(answer).resolves.toEqual({ confirmed: true, checked: false, secondary: true });
  });
});
