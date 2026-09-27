/**
 * Signing configuration for release builds (roadmap M9-T1, docs/plan/10-quality-testing-release.md §9), derived
 * from the CI environment so unsigned builds keep working when no secrets are configured.
 *
 * Windows: Azure Trusted Signing (AZURE_TENANT_ID/AZURE_CLIENT_ID/AZURE_CLIENT_SECRET + AZURE_SIGN_ENDPOINT,
 * AZURE_SIGN_ACCOUNT, AZURE_SIGN_PROFILE, AZURE_SIGN_PUBLISHER) or a PFX certificate (WIN_CSC_LINK +
 * WIN_CSC_KEY_PASSWORD, signtool). macOS: a Developer ID certificate (MAC_CSC_LINK + MAC_CSC_KEY_PASSWORD) and
 * notarization with an App Store Connect API key (APPLE_API_KEY path, APPLE_API_KEY_ID, APPLE_API_ISSUER).
 */
export type SigningPlatform = 'win' | 'mac' | 'linux';

export interface SigningPlan {
  /** Extra electron-builder CLI arguments. */
  args: string[];
  /** Environment variables for electron-builder (CSC_LINK etc.). */
  env: Record<string, string>;
  /** What happens, for the build log. */
  summary: string;
  signed: boolean;
  notarized: boolean;
}

const has = (env: Record<string, string | undefined>, ...names: string[]) => names.every((n) => !!env[n]?.trim());

export function signingPlan(platform: SigningPlatform, env: Record<string, string | undefined>): SigningPlan {
  const unsigned = (summary: string): SigningPlan => ({
    args: [],
    env: { CSC_IDENTITY_AUTO_DISCOVERY: 'false' },
    summary,
    signed: false,
    notarized: false,
  });
  if (platform === 'win') {
    if (
      has(env, 'AZURE_TENANT_ID', 'AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET') &&
      has(env, 'AZURE_SIGN_ENDPOINT', 'AZURE_SIGN_ACCOUNT', 'AZURE_SIGN_PROFILE', 'AZURE_SIGN_PUBLISHER')
    ) {
      return {
        args: [
          `--config.win.azureSignOptions.endpoint=${env['AZURE_SIGN_ENDPOINT']}`,
          `--config.win.azureSignOptions.codeSigningAccountName=${env['AZURE_SIGN_ACCOUNT']}`,
          `--config.win.azureSignOptions.certificateProfileName=${env['AZURE_SIGN_PROFILE']}`,
          `--config.win.azureSignOptions.publisherName=${env['AZURE_SIGN_PUBLISHER']}`,
        ],
        env: {},
        summary: 'Windows: signing with Azure Trusted Signing',
        signed: true,
        notarized: false,
      };
    }
    if (has(env, 'WIN_CSC_LINK', 'WIN_CSC_KEY_PASSWORD')) {
      return {
        args: [],
        env: { CSC_LINK: env['WIN_CSC_LINK']!, CSC_KEY_PASSWORD: env['WIN_CSC_KEY_PASSWORD']! },
        summary: 'Windows: signing with the PFX certificate (signtool)',
        signed: true,
        notarized: false,
      };
    }
    return unsigned('Windows: unsigned (no signing secrets; SmartScreen will warn)');
  }
  if (platform === 'mac') {
    if (!has(env, 'MAC_CSC_LINK', 'MAC_CSC_KEY_PASSWORD'))
      return unsigned('macOS: unsigned, ad-hoc signature only (no Developer ID secrets)');
    const notarize = has(env, 'APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER');
    return {
      args: notarize ? ['--config.mac.notarize=true'] : [],
      env: { CSC_LINK: env['MAC_CSC_LINK']!, CSC_KEY_PASSWORD: env['MAC_CSC_KEY_PASSWORD']! },
      summary: notarize
        ? 'macOS: signing with Developer ID and notarizing'
        : 'macOS: signing with Developer ID (not notarized: no App Store Connect API key)',
      signed: true,
      notarized: notarize,
    };
  }
  return unsigned('Linux: packages are not signed');
}
