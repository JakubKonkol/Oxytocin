import { useSyncExternalStore } from 'react';
import { currentTheme, type EffectiveTheme, onDidChangeTheme } from './theme';

/** The effective theme ("system" already resolved), re-rendering on switches. */
export function useEffectiveTheme(): EffectiveTheme {
  return useSyncExternalStore(onDidChangeTheme, currentTheme);
}
