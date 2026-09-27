import { describe, expect, it } from 'vitest';
import { signingPlan } from './lib/signing';

describe('signingPlan', () => {
  it('builds unsigned packages without secrets', () => {
    for (const p of ['win', 'mac', 'linux'] as const) {
      const plan = signingPlan(p, {});
      expect(plan).toMatchObject({ args: [], signed: false, notarized: false });
      expect(plan.env).toEqual({ CSC_IDENTITY_AUTO_DISCOVERY: 'false' });
    }
  });

  it('prefers Azure Trusted Signing on Windows, then a PFX certificate', () => {
    const azure = {
      AZURE_TENANT_ID: 't',
      AZURE_CLIENT_ID: 'c',
      AZURE_CLIENT_SECRET: 's',
      AZURE_SIGN_ENDPOINT: 'https://weu.codesigning.azure.net',
      AZURE_SIGN_ACCOUNT: 'oxy',
      AZURE_SIGN_PROFILE: 'public',
      AZURE_SIGN_PUBLISHER: 'Jakub Konkol',
    };
    const plan = signingPlan('win', { ...azure, WIN_CSC_LINK: 'x', WIN_CSC_KEY_PASSWORD: 'y' });
    expect(plan.signed).toBe(true);
    expect(plan.args).toContain('--config.win.azureSignOptions.publisherName=Jakub Konkol');
    expect(plan.env).toEqual({});
    const pfx = signingPlan('win', { WIN_CSC_LINK: 'base64pfx', WIN_CSC_KEY_PASSWORD: 'pw' });
    expect(pfx).toMatchObject({ signed: true, args: [], env: { CSC_LINK: 'base64pfx', CSC_KEY_PASSWORD: 'pw' } });
    // Incomplete Azure settings do not half-configure signing.
    expect(signingPlan('win', { AZURE_TENANT_ID: 't' }).signed).toBe(false);
  });

  it('signs on macOS with a Developer ID and notarizes only with an API key', () => {
    const cert = { MAC_CSC_LINK: 'p12', MAC_CSC_KEY_PASSWORD: 'pw' };
    expect(signingPlan('mac', cert)).toMatchObject({ signed: true, notarized: false, args: [] });
    const full = signingPlan('mac', {
      ...cert,
      APPLE_API_KEY: '/k.p8',
      APPLE_API_KEY_ID: 'id',
      APPLE_API_ISSUER: 'iss',
    });
    expect(full).toMatchObject({ signed: true, notarized: true, args: ['--config.mac.notarize=true'] });
    expect(full.env).toEqual({ CSC_LINK: 'p12', CSC_KEY_PASSWORD: 'pw' });
    expect(signingPlan('mac', { APPLE_API_KEY: '/k.p8' }).signed).toBe(false);
  });
});
