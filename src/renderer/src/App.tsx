import { useEffect, useState } from 'react';
import type { AppInfo } from '@shared/domain/app-info';
import { ipc } from './lib/ipc-client';

export function App() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  useEffect(() => {
    void ipc.invoke('app:getInfo').then(setInfo);
  }, []);
  return (
    <main data-testid={info ? 'app-ready' : undefined}>
      <h1>Oxytocin</h1>
      {info && (
        <p data-testid="app-versions">
          Electron {info.versions.electron} · Node {info.versions.node}
        </p>
      )}
    </main>
  );
}
