import { Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import {
  API_LIMITS,
  type ApiAuth,
  type ApiResource,
  HTTP_METHODS,
  type HttpMethod,
  RESOURCE_ENVIRONMENTS,
  SAFE_METHODS,
  secretStatusKey,
} from '@shared/domain/project-resources';
import { cn } from '../../../lib/cn';
import { ipc } from '../../../lib/ipc-client';
import { Button } from '../../../ui/Button';
import { draftSecretsOf, newApi, secretState, splitList } from '../resources-model';
import {
  BridgeNote,
  Check,
  Field,
  input,
  ResourceList,
  SecretInput,
  Section,
  Segmented,
  TestConnection,
} from './controls';
import type { ResourceTabProps } from './DatabasesTab';

interface RunProfile {
  id: string;
  name: string;
  url?: string;
}

const describe = (a: ApiResource) =>
  `${typeof a.baseUrl === 'string' ? a.baseUrl.replace(/^https?:\/\//, '') : 'Run profile'} · ${a.access.methods.join(' ')}`;

const num = (value: string, fallback: number, min: number, max: number) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
};

function useRunProfiles(projectId: string): RunProfile[] {
  const [profiles, setProfiles] = useState<RunProfile[]>([]);
  useEffect(() => {
    let cancelled = false;
    ipc.invoke('plugins:executeCommand', { id: 'oxytocin.project-runner.profiles', args: [{ projectId }] }).then(
      (list) => !cancelled && Array.isArray(list) && setProfiles(list as RunProfile[]),
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [projectId]);
  return profiles;
}

function AuthFields({
  api,
  set,
  props,
}: {
  api: ApiResource;
  set: (patch: Partial<ApiResource>) => void;
  props: ResourceTabProps;
}) {
  const a = api.auth;
  const secret = (key: string, label: string, testId: string) => (
    <SecretInput
      key={key}
      label={label}
      testId={testId}
      state={secretState(props.stored, props.edits, api.id, key)}
      onSet={(value) => props.setEdits((e) => ({ ...e, [secretStatusKey(api.id, key)]: { value } }))}
      onRemove={() => props.setEdits((e) => ({ ...e, [secretStatusKey(api.id, key)]: { remove: true } }))}
      onReset={() =>
        props.setEdits((e) => {
          const next = { ...e };
          delete next[secretStatusKey(api.id, key)];
          return next;
        })
      }
    />
  );
  const setAuth = (auth: ApiAuth) => set({ auth });
  return (
    <>
      <Field label="Authentication">
        <select
          data-testid="api-auth"
          value={a.type}
          onChange={(e) => {
            const type = e.target.value as ApiAuth['type'];
            if (type === 'basic') setAuth({ type, user: '' });
            else if (type === 'api-key') setAuth({ type, in: 'header', name: 'X-Api-Key' });
            else if (type === 'headers') setAuth({ type, names: ['X-Api-Key'] });
            else setAuth({ type });
          }}
          className={input}
        >
          <option value="none">None</option>
          <option value="bearer">Bearer token</option>
          <option value="basic">Basic (user and password)</option>
          <option value="api-key">API key</option>
          <option value="headers">Custom headers</option>
        </select>
      </Field>
      {a.type === 'bearer' && secret('token', 'Token', 'api-token')}
      {a.type === 'basic' && (
        <div className="grid grid-cols-2 gap-2">
          <Field label="User">
            <input value={a.user} onChange={(e) => setAuth({ ...a, user: e.target.value })} className={input} />
          </Field>
          {secret('password', 'Password', 'api-password')}
        </div>
      )}
      {a.type === 'api-key' && (
        <div className="grid grid-cols-[110px_1fr_1fr] gap-2">
          <Field label="Sent in">
            <select
              value={a.in}
              onChange={(e) => setAuth({ ...a, in: e.target.value as 'header' | 'query' })}
              className={input}
            >
              <option value="header">Header</option>
              <option value="query">Query</option>
            </select>
          </Field>
          <Field label="Name">
            <input
              value={a.name}
              onChange={(e) => setAuth({ ...a, name: e.target.value })}
              className={cn(input, 'font-mono')}
            />
          </Field>
          {secret('apiKey', 'Key', 'api-key')}
        </div>
      )}
      {a.type === 'headers' && (
        <>
          <Field label="Header names" hint="Comma separated; each value is a secret.">
            <input
              value={a.names.join(', ')}
              onChange={(e) =>
                setAuth({
                  ...a,
                  names: splitList(e.target.value).filter((n) => /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(n)),
                })
              }
              className={cn(input, 'font-mono')}
            />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            {a.names.map((n) => secret(`header:${n}`, n, `api-header-${n}`))}
          </div>
        </>
      )}
    </>
  );
}

function ApiForm({ api, props, profiles }: { api: ApiResource; props: ResourceTabProps; profiles: RunProfile[] }) {
  const set = (patch: Partial<ApiResource>) =>
    props.update((r) => ({ ...r, apis: r.apis.map((a) => (a.id === api.id ? { ...a, ...patch } : a)) }));
  const setAccess = (patch: Partial<ApiResource['access']>) => set({ access: { ...api.access, ...patch } });
  const fromProfile = typeof api.baseUrl !== 'string';
  const production = api.environment === 'production';
  const methodState = (m: HttpMethod): 'off' | 'on' | 'ask' =>
    api.access.confirmMethods.includes(m) ? 'ask' : api.access.methods.includes(m) ? 'on' : 'off';
  const setMethod = (m: HttpMethod, state: 'off' | 'on' | 'ask') =>
    setAccess({
      methods: state === 'on' ? [...new Set([...api.access.methods, m])] : api.access.methods.filter((x) => x !== m),
      confirmMethods:
        state === 'ask'
          ? [...new Set([...api.access.confirmMethods, m])]
          : api.access.confirmMethods.filter((x) => x !== m),
    });
  return (
    <div data-testid="api-form" className="flex min-w-0 flex-1 flex-col gap-3 overflow-auto pr-1">
      <Section
        title="Connection"
        action={
          <Button
            size="sm"
            variant="ghost"
            data-testid="api-remove"
            onClick={() => props.update((r) => ({ ...r, apis: r.apis.filter((a) => a.id !== api.id) }))}
          >
            <Trash2 size={12} /> Remove
          </Button>
        }
      >
        <div className="grid grid-cols-[1fr_140px] gap-2">
          <Field label="Name">
            <input
              data-testid="api-name"
              value={api.name}
              onChange={(e) => set({ name: e.target.value })}
              className={input}
            />
          </Field>
          <Field label="Environment">
            <select
              value={api.environment}
              onChange={(e) => {
                const environment = e.target.value as ApiResource['environment'];
                // Production: unsafe methods ask first.
                const unsafe = api.access.methods.filter((m) => !SAFE_METHODS.includes(m));
                set({
                  environment,
                  ...(environment === 'production' && unsafe.length
                    ? {
                        access: {
                          ...api.access,
                          methods: api.access.methods.filter((m) => SAFE_METHODS.includes(m)),
                          confirmMethods: [...new Set([...api.access.confirmMethods, ...unsafe])],
                        },
                      }
                    : {}),
                });
              }}
              className={input}
            >
              {RESOURCE_ENVIRONMENTS.map((e) => (
                <option key={e} value={e}>
                  {e}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Segmented
          label="Base URL"
          value={fromProfile ? 'profile' : 'url'}
          options={[
            { value: 'url', label: 'URL' },
            { value: 'profile', label: 'From a Run profile' },
          ]}
          onChange={(v) => {
            if (v === 'url')
              set({
                baseUrl:
                  typeof api.baseUrl === 'string' ? api.baseUrl : (api.baseUrl.fallback ?? 'http://localhost:3000'),
              });
            else
              set({
                baseUrl: {
                  runProfileId: profiles[0]?.id ?? '',
                  fallback: typeof api.baseUrl === 'string' ? api.baseUrl : undefined,
                },
              });
          }}
        />
        {typeof api.baseUrl === 'string' ? (
          <Field label="Base URL" hint="Requests only go to this origin; agents pass paths.">
            <input
              data-testid="api-base-url"
              value={api.baseUrl}
              onChange={(e) => set({ baseUrl: e.target.value })}
              className={cn(input, 'font-mono')}
            />
          </Field>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            <Field label="Run profile" hint="Its URL while it runs (Project Runner).">
              <select
                value={api.baseUrl.runProfileId}
                onChange={(e) =>
                  set({
                    baseUrl: { ...(api.baseUrl as object), runProfileId: e.target.value },
                  })
                }
                className={input}
              >
                {profiles.length === 0 && <option value="">No Run profiles</option>}
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                    {p.url ? ` (${p.url})` : ''}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Fallback URL" hint="Used when the Project Runner cannot tell.">
              <input
                value={api.baseUrl.fallback ?? ''}
                onChange={(e) =>
                  set({
                    baseUrl: {
                      ...(api.baseUrl as { runProfileId: string }),
                      fallback: e.target.value || undefined,
                    },
                  })
                }
                className={cn(input, 'font-mono')}
              />
            </Field>
          </div>
        )}
        <AuthFields api={api} set={set} props={props} />
        <div className="grid grid-cols-2 gap-2">
          <Field label="Health path" hint="Checked by Test (default: the base URL).">
            <input
              value={api.healthPath ?? ''}
              placeholder="/health"
              onChange={(e) => set({ healthPath: e.target.value || undefined })}
              className={cn(input, 'font-mono')}
            />
          </Field>
          <Field label="OpenAPI document">
            <div className="flex gap-1">
              <select
                data-testid="api-openapi"
                value={api.openapi.source}
                onChange={(e) =>
                  set({
                    openapi: {
                      source: e.target.value as ApiResource['openapi']['source'],
                      ...(api.openapi.value ? { value: api.openapi.value } : {}),
                    },
                  })
                }
                className={cn(input, 'w-32 flex-none')}
              >
                <option value="auto">Find it</option>
                <option value="url">URL</option>
                <option value="file">File</option>
                <option value="off">None</option>
              </select>
              {(api.openapi.source === 'url' || api.openapi.source === 'file') && (
                <input
                  value={api.openapi.value ?? ''}
                  placeholder={api.openapi.source === 'url' ? '/swagger/v1/swagger.json' : 'openapi.yaml'}
                  onChange={(e) => set({ openapi: { ...api.openapi, value: e.target.value } })}
                  className={cn(input, 'font-mono')}
                />
              )}
            </div>
          </Field>
        </div>
        <Check
          checked={api.access.allowSelfSignedOnLoopback}
          onChange={(v) => setAccess({ allowSelfSignedOnLoopback: v })}
        >
          Allow self-signed certificates on localhost (ASP.NET, Vite dev certificates)
        </Check>
        <TestConnection
          testId="api-test"
          run={() =>
            ipc.invoke('resources:test', {
              projectId: props.projectId,
              kind: 'api',
              resource: api,
              ...draftSecretsOf(api.id, props.edits),
            })
          }
        />
      </Section>

      <Section title="What agents may do">
        <div className="flex flex-col gap-1" data-testid="api-methods">
          {HTTP_METHODS.map((m) => (
            <div key={m} className="flex items-center gap-3">
              <span className="w-20 font-mono text-small text-fg">{m}</span>
              <Segmented<'off' | 'on' | 'ask'>
                label={m}
                testId={`api-method-${m}`}
                value={methodState(m)}
                options={[
                  { value: 'off', label: 'Blocked' },
                  ...(production && !SAFE_METHODS.includes(m) ? [] : [{ value: 'on' as const, label: 'Allowed' }]),
                  { value: 'ask', label: 'Ask me', tone: 'warning' },
                ]}
                onChange={(v) => setMethod(m, v)}
              />
            </div>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Allowed paths" hint="Globs: * one segment, ** any; one per line.">
            <textarea
              rows={2}
              value={api.access.allowPaths.join('\n')}
              onChange={(e) => setAccess({ allowPaths: splitList(e.target.value) })}
              className={cn(input, 'h-auto py-1 font-mono text-small')}
            />
          </Field>
          <Field label="Blocked paths" hint="e.g. /admin/**">
            <textarea
              rows={2}
              value={api.access.denyPaths.join('\n')}
              onChange={(e) => setAccess({ denyPaths: splitList(e.target.value) })}
              className={cn(input, 'h-auto py-1 font-mono text-small')}
            />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Time limit (s)">
            <input
              type="number"
              min={1}
              max={300}
              value={Math.round(api.access.timeoutMs / 1000)}
              onChange={(e) =>
                setAccess({ timeoutMs: num(e.target.value, api.access.timeoutMs / 1000, 1, 300) * 1000 })
              }
              className={input}
            />
          </Field>
          <Field label="Response size (KB)">
            <input
              type="number"
              min={4}
              max={4096}
              value={Math.round(api.access.maxResponseBytes / 1024)}
              onChange={(e) =>
                setAccess({
                  maxResponseBytes:
                    num(
                      e.target.value,
                      api.access.maxResponseBytes / 1024,
                      API_LIMITS.maxResponseBytes.min / 1024,
                      API_LIMITS.maxResponseBytes.max / 1024,
                    ) * 1024,
                })
              }
              className={input}
            />
          </Field>
        </div>
      </Section>

      <Section title="Agents">
        <Check
          testId="api-exposed"
          checked={api.agents.exposed}
          onChange={(v) => set({ agents: { ...api.agents, exposed: v } })}
        >
          Available to agents
        </Check>
        <Check
          checked={api.agents.shareWithRelated}
          disabled={!api.agents.exposed}
          onChange={(v) => set({ agents: { ...api.agents, shareWithRelated: v } })}
        >
          Share with related projects
        </Check>
        <Field label="Notes for agents">
          <textarea
            rows={2}
            maxLength={2000}
            value={api.agents.description ?? ''}
            onChange={(e) => set({ agents: { ...api.agents, description: e.target.value || undefined } })}
            className={cn(input, 'h-auto py-1')}
          />
        </Field>
        <BridgeNote />
      </Section>
    </div>
  );
}

/** Project settings → APIs. */
export function ApisTab(props: ResourceTabProps) {
  const { resources, update } = props;
  const [selected, setSelected] = useState<string | null>(resources.apis[0]?.id ?? null);
  const profiles = useRunProfiles(props.projectId);
  const current = resources.apis.find((a) => a.id === selected) ?? resources.apis[0];
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3" data-testid="tab-apis">
      <div>
        <Button
          size="sm"
          data-testid="api-add"
          onClick={() => {
            const api = newApi(resources);
            update((r) => ({ ...r, apis: [...r.apis, api] }));
            setSelected(api.id);
          }}
        >
          <Plus size={12} /> Add API
        </Button>
      </div>
      <div className="flex min-h-0 flex-1 gap-3">
        <ResourceList
          testId="api-list"
          items={resources.apis}
          selected={current?.id ?? null}
          onSelect={setSelected}
          describe={describe}
          empty="No APIs yet."
        />
        {current ? (
          <ApiForm key={current.id} api={current} props={props} profiles={profiles} />
        ) : (
          <div className="flex flex-1 flex-col gap-2 text-small text-fg-muted">
            <p>
              Describe the project's HTTP APIs: agents read the OpenAPI summary and call endpoints through Oxytocin,
              which adds the authentication and only lets the methods and paths you allow through.
            </p>
            <BridgeNote />
          </div>
        )}
      </div>
    </div>
  );
}
