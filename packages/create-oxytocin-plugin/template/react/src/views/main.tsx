import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useOxyView } from '@oxytocin/plugin-sdk/react';
import '@oxytocin/plugin-sdk/theme.css';
import './main.css';
import type { Greeting } from '../host';

function App() {
  const view = useOxyView();
  const [status, setStatus] = useState('Ask the backend for a greeting.');
  if (!view) return <main id="status">Connecting…</main>;
  return (
    <main>
      <h1>{{name}}</h1>
      <p id="status">{status}</p>
      <div className="actions">
        <button
          id="greet"
          type="button"
          onClick={() =>
            void view.request<Greeting>('greet', { name: 'Oxytocin' }).then((g) => {
              setStatus(`${g.text} You have ${g.projects} project${g.projects === 1 ? '' : 's'}.`);
            })
          }
        >
          Greet
        </button>
        <button id="hello" type="button" onClick={() => void view.executeCommand('{{prefix}}.hello')}>
          Say hello
        </button>
      </div>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
