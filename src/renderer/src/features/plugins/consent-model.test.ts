import { describe, expect, it } from 'vitest';
import type { PluginDescriptor } from '@shared/domain/plugin';
import { consentDetails, needsConsent } from './consent-model';

const plugin = (over: Partial<PluginDescriptor> = {}): PluginDescriptor =>
  ({
    id: 'acme.hello',
    version: '1.0.0',
    displayName: 'Hello',
    source: 'user',
    path: '/u/plugins/acme.hello',
    state: 'disabled',
    manifest: { main: 'host.js', permissions: ['projects.read', 'terminals.write'] },
    ...over,
  }) as PluginDescriptor;

describe('plugin consent', () => {
  it('is needed for user plugins the user has not answered for', () => {
    expect(needsConsent(plugin(), {})).toBe(true);
    expect(needsConsent(plugin(), { 'acme.hello': false })).toBe(false);
    expect(needsConsent(plugin({ source: 'builtin' }), {})).toBe(false);
    expect(needsConsent(plugin({ source: 'dev' }), {})).toBe(false);
  });

  it('lists the backend, the permissions and a replaced built-in plugin', () => {
    expect(consentDetails(plugin())).toEqual({
      publisher: 'an unknown publisher',
      hasBackend: true,
      permissions: [
        { id: 'projects.read', description: 'See your projects (names and folders)' },
        { id: 'terminals.write', description: 'Type into your terminals' },
      ],
      replacesBuiltin: false,
    });
    const viewOnly = consentDetails(
      plugin({
        publisher: 'acme',
        manifest: { permissions: [] } as unknown as PluginDescriptor['manifest'],
        shadowed: [{ source: 'builtin', path: '/r' }],
      }),
    );
    expect(viewOnly).toMatchObject({ publisher: 'acme', hasBackend: false, permissions: [], replacesBuiltin: true });
  });
});
