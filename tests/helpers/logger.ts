import type { Logger } from '../../src/shared/logging/logger';

export const silentLogger: Logger = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} };
