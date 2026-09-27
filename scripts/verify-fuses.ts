/**
 * Checks the Electron fuses of a packaged app (release workflow):
 * tsx scripts/verify-fuses.ts <path to the executable or the .app bundle>
 */
import { FuseState, FuseV1Options, getCurrentFuseWire } from '@electron/fuses';

const EXPECTED_FUSES: readonly [FuseV1Options, boolean][] = [
  [FuseV1Options.RunAsNode, false],
  [FuseV1Options.EnableCookieEncryption, true],
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable, false],
  [FuseV1Options.EnableNodeCliInspectArguments, false],
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation, true],
  [FuseV1Options.OnlyLoadAppFromAsar, true],
  [FuseV1Options.GrantFileProtocolExtraPrivileges, false],
];

const path = process.argv[2];
if (!path) {
  console.error('Usage: tsx scripts/verify-fuses.ts <app>');
  process.exit(2);
}
void getCurrentFuseWire(path).then((wire) => {
  let ok = true;
  for (const [option, expected] of EXPECTED_FUSES) {
    const enabled = wire[option] === FuseState.ENABLE;
    console.log(
      `${enabled === expected ? 'ok  ' : 'FAIL'} ${FuseV1Options[option]}: ${enabled ? 'enabled' : 'disabled'}`,
    );
    if (enabled !== expected) ok = false;
  }
  process.exit(ok ? 0 : 1);
});
