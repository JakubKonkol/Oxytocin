/**
 * Channel names only (no zod) so the preload bundle stays tiny. The typed contracts in contract.ts and
 * events.ts must cover exactly these channels (enforced by the type checker).
 */
export const INVOKE_CHANNELS = ['app:getInfo', 'app:getHostStatus', 'settings:get'] as const;

export const EVENT_CHANNELS = ['settings:changed', 'hosts:status'] as const;

export type InvokeChannel = (typeof INVOKE_CHANNELS)[number];
export type EventChannel = (typeof EVENT_CHANNELS)[number];
