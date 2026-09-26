import type { IDockviewPanelProps } from 'dockview-react';
import { useEffect, useState } from 'react';
import { OxyError } from '@shared/errors';
import { useProjectsStore } from '../../stores/projects-store';
import { usePluginsStore } from '../../stores/plugins-store';
import { EmptyState } from '../../ui/EmptyState';
import { workspaceFor } from '../attention/reveal';
import { newPanelId } from '../layout/panel-registry';
import { getWorkspaceApi } from '../layout/workspace-registry';
import { useWorkspaceVisible } from '../layout/workspace-visibility';
import { usePluginViewMeta } from './view-meta-store';
import { PluginFrame } from './PluginFrame';
import { viewStates } from './view-bridge';

export interface PluginPanelParams {
  pluginId: string;
  panelType: string;
  projectId: string;
  /** Instance id of the view (stable across restarts, keys its state). */
  viewId: string;
  params?: unknown;
}

const newViewId = () => newPanelId('plg').replace('plg-', 'pv-');

/**
 * Opens a plugin panel (`contributes.panels`) in a project's workspace, honouring `singleton`
 * (docs/plan/07-plugin-engine.md §8.2).
 */
export async function openPluginPanel(
  panelType: string,
  o: { projectId?: string; params?: unknown; title?: string; placement?: 'active-group' | 'right' | 'below' } = {},
): Promise<void> {
  const contribution = usePluginsStore.getState().contributions.panels.find((p) => p.type === panelType);
  if (!contribution) throw new OxyError('NOT_FOUND', `Unknown panel type: ${panelType}`);
  const projectId = o.projectId ?? useProjectsStore.getState().activeId;
  if (!projectId) throw new OxyError('INVALID', 'Open a project first');
  const api = getWorkspaceApi(projectId) ?? (await workspaceFor(projectId));
  if (!api) throw new OxyError('UNAVAILABLE', 'The workspace is not ready');
  const same = api.panels.filter((p) => {
    const params = p.params as Partial<PluginPanelParams> | undefined;
    return p.api.component === 'plugin' && params?.panelType === panelType;
  });
  const existing =
    contribution.singleton === 'global'
      ? same[0]
      : contribution.singleton === 'project'
        ? same.find(
            (p) => JSON.stringify((p.params as PluginPanelParams).params ?? null) === JSON.stringify(o.params ?? null),
          )
        : undefined;
  if (existing) {
    existing.api.setActive();
    return;
  }
  const params: PluginPanelParams = {
    pluginId: contribution.pluginId,
    panelType,
    projectId,
    viewId: newViewId(),
    ...(o.params !== undefined ? { params: o.params } : {}),
  };
  const reference = api.activeGroup;
  api.addPanel<PluginPanelParams>({
    id: newPanelId('plg'),
    component: 'plugin',
    params,
    title: o.title ?? contribution.title,
    ...(o.placement && o.placement !== 'active-group' && reference
      ? { position: { referenceGroup: reference, direction: o.placement === 'right' ? 'right' : 'below' } }
      : {}),
  });
}

/** Dockview panel hosting a plugin view. */
export function PluginPanelComponent(props: IDockviewPanelProps<PluginPanelParams>) {
  const { pluginId, panelType, viewId, params, projectId } = props.params;
  const contribution = usePluginsStore((s) =>
    s.contributions.panels.find((p) => p.type === panelType && p.pluginId === pluginId),
  );
  const workspaceVisible = useWorkspaceVisible();
  const setMeta = usePluginViewMeta((s) => s.set);
  useEffect(() => () => usePluginViewMeta.getState().set(props.api.id, { badge: null }), [props.api.id]);
  const [panelVisible, setPanelVisible] = useState(props.api.isVisible);
  useEffect(() => {
    const d = props.api.onDidVisibilityChange((e) => setPanelVisible(e.isVisible));
    return () => d.dispose();
  }, [props.api]);
  if (!contribution) {
    return (
      <EmptyState title={`Plugin "${pluginId}" is unavailable`} description="Enable the plugin to show this panel." />
    );
  }
  return (
    <div className="h-full" data-testid={`plugin-panel-${panelType}`}>
      <PluginFrame
        pluginId={pluginId}
        entry={contribution.entry}
        viewId={viewId}
        kind="panel"
        providerId={panelType}
        projectId={projectId}
        {...(params !== undefined ? { params } : {})}
        title={props.api.title ?? contribution.title}
        visible={workspaceVisible && panelVisible}
        onTitle={(title) => props.api.setTitle(title)}
        onBadge={(badge) => setMeta(props.api.id, { badge })}
        onStateChange={() => props.api.updateParameters({ ...props.params })}
      />
    </div>
  );
}

/** Panel state for persistence (`PanelDescriptor.state`). */
export function pluginPanelState(viewId: string): unknown {
  return viewStates.get(viewId);
}
