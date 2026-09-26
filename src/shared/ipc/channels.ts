/**
 * Channel names only (no zod) so the preload bundle stays tiny. The typed contracts in contract.ts and
 * events.ts must cover exactly these channels (enforced by the type checker).
 */
export const INVOKE_CHANNELS = [
  'app:getInfo',
  'app:getHostStatus',
  'settings:get',
  'settings:update',
  'ui:getState',
  'ui:patchState',
  'projects:list',
  'projects:getActive',
  'projects:add',
  'projects:remove',
  'projects:update',
  'projects:reorder',
  'projects:setActive',
  'projects:pickFolder',
  'terminals:create',
  'terminals:kill',
  'terminals:restart',
  'terminals:rename',
  'terminals:dispose',
  'terminals:list',
  'terminals:profiles',
  'shell:openExternal',
  'clipboard:read',
  'clipboard:writeText',
  'terminals:clearBell',
  'fs:statMany',
  'editor:open',
  'workspace:load',
  'workspace:save',
] as const;

export const EVENT_CHANNELS = [
  'settings:changed',
  'hosts:status',
  'terminals:updated',
  'terminals:removed',
  'projects:changed',
  'projects:active',
  'notifications:show',
] as const;

export type InvokeChannel = (typeof INVOKE_CHANNELS)[number];
export type EventChannel = (typeof EVENT_CHANNELS)[number];
