// `prepack`: copies the view SDK sources and the backend API types from the monorepo into vendor/, so the
// published package works on its own.
import { cp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { PACKAGE_DIR } from './scaffold.js';

const vendor = join(PACKAGE_DIR, 'vendor');
await rm(vendor, { recursive: true, force: true });
await mkdir(join(vendor, 'plugin-sdk'), { recursive: true });
for (const file of ['index.ts', 'protocol.ts', 'react.ts', 'theme.css'])
  await cp(join(PACKAGE_DIR, '..', 'plugin-sdk', 'src', file), join(vendor, 'plugin-sdk', file));
await mkdir(join(vendor, 'plugin-api'), { recursive: true });
for (const file of ['index.d.ts', 'package.json'])
  await cp(join(PACKAGE_DIR, '..', 'plugin-api', file), join(vendor, 'plugin-api', file));
