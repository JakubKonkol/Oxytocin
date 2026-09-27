import type { IPaneviewPanelProps } from 'dockview-react';
import { useEffect, useState } from 'react';
import { usePluginsStore } from '../../stores/plugins-store';
import { SectionBody } from '../../ui/Section';
import { EmptyState } from '../../ui/EmptyState';
import { PluginFrame } from './PluginFrame';
import { usePluginViewMeta } from './view-meta-store';

export interface PluginPaneParams {
  pluginId: string;
  viewId: string;
}

/** Instance id of a sidebar view (one instance per contributed view). */
export const sidebarViewInstanceId = (pluginId: string, viewId: string) =>
  `sv-${pluginId}-${viewId}`.replace(/[^\w.-]/g, '-');

/** A plugin view in a sidebar pane; mounted on first expansion. */
export function PluginSidebarView(props: IPaneviewPanelProps<PluginPaneParams>) {
  const { pluginId, viewId } = props.params;
  const contribution = usePluginsStore((s) =>
    s.contributions.views.find((v) => v.pluginId === pluginId && v.id === viewId),
  );
  const [expanded, setExpanded] = useState(props.api.isExpanded);
  const [everExpanded, setEverExpanded] = useState(props.api.isExpanded);
  const instanceId = sidebarViewInstanceId(pluginId, viewId);
  const setMeta = usePluginViewMeta((s) => s.set);
  useEffect(() => {
    const d = props.api.onDidExpansionChange((e) => {
      setExpanded(e.isExpanded);
      if (e.isExpanded) setEverExpanded(true);
    });
    return () => d.dispose();
  }, [props.api]);
  if (!contribution) return <EmptyState title="View unavailable" />;
  return (
    <SectionBody className="flex flex-col p-0">
      <div className="min-h-0 flex-1" data-testid={`plugin-view-${viewId}`}>
        {everExpanded && (
          <PluginFrame
            pluginId={pluginId}
            entry={contribution.entry}
            viewId={instanceId}
            kind="view"
            providerId={viewId}
            title={contribution.title}
            visible={expanded}
            onTitle={(title) => setMeta(instanceId, { title })}
            onBadge={(badge) => setMeta(instanceId, { badge })}
          />
        )}
      </div>
    </SectionBody>
  );
}
