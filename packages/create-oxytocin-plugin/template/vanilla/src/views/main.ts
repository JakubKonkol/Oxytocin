import { connect } from '@oxytocin/plugin-sdk';
import '@oxytocin/plugin-sdk/theme.css';
import './main.css';
import type { Greeting } from '../host';

const status = document.getElementById('status')!;
const greet = document.getElementById('greet') as HTMLButtonElement;
const hello = document.getElementById('hello') as HTMLButtonElement;

void connect().then(
  (view) => {
    status.textContent = 'Connected. Ask the backend for a greeting.';
    greet.disabled = false;
    hello.disabled = false;
    greet.addEventListener('click', () => {
      void view.request<Greeting>('greet', { name: 'Oxytocin' }).then((g) => {
        status.textContent = `${g.text} You have ${g.projects} project${g.projects === 1 ? '' : 's'}.`;
      });
    });
    hello.addEventListener('click', () => void view.executeCommand('{{prefix}}.hello'));
  },
  (e: unknown) => {
    status.textContent = e instanceof Error ? e.message : String(e);
  },
);
