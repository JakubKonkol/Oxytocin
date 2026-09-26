import type { OxyPreloadApi } from '../../src/shared/ipc/preload-api';

declare global {
  interface Window {
    oxy: OxyPreloadApi;
  }
}
