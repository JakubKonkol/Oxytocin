import { type IPaneviewPanelProps, type PaneviewApi, PaneviewReact, type PaneviewReadyEvent } from 'dockview-react';
import { useEffect, useRef, useState } from 'react';
import type { PaneviewState } from '@shared/domain/ui-state';
import { SectionBody, SectionHeader } from '../ui/Section';
import { EmptyState } from '../ui/EmptyState';
import { useUiStore } from '../stores/ui-store';

export const SIDEBAR_HEADER_SIZE = 30;

interface SectionDefinition {
  id: string;
  title: string;
  size: number;
}

/** Core sidebar sections; plugin panes are appended in M5. */
const CORE_SECTIONS: SectionDefinition[] = [
  { id: 'projects', title: 'PROJECTS', size: 220 },
  { id: 'changes', title: 'CHANGES', size: 320 },
  { id: 'usage', title: 'USAGE', size: 180 },
];

function PaneHeader(props: IPaneviewPanelProps) {
  const [expanded, setExpanded] = useState(props.api.isExpanded);
  useEffect(() => {
    const d = props.api.onDidExpansionChange((e) => setExpanded(e.isExpanded));
    return () => d.dispose();
  }, [props.api]);
  return (
    <SectionHeader
      testId={`section-header-${props.api.id}`}
      title={props.title}
      expanded={expanded}
      onToggle={() => props.api.setExpanded(!expanded)}
    />
  );
}

function PlaceholderBody({ text }: { text: string }) {
  return (
    <SectionBody>
      <EmptyState title={text} className="py-4" />
    </SectionBody>
  );
}

const components = {
  projects: () => <PlaceholderBody text="No projects yet" />,
  changes: () => <PlaceholderBody text="No project selected" />,
  usage: () => <PlaceholderBody text="No usage data yet" />,
};

function readPaneviewState(api: PaneviewApi): PaneviewState {
  const panels = api.panels;
  return {
    order: panels.map((p) => p.id),
    sizes: Object.fromEntries(panels.filter((p) => p.api.isExpanded).map((p) => [p.id, Math.round(p.height)])),
    collapsed: panels.filter((p) => !p.api.isExpanded).map((p) => p.id),
    hidden: [],
  };
}

/** Left column: a Paneview of collapsible, resizable, reorderable section cards. */
export function Sidebar() {
  const saved = useUiStore((s) => s.state.paneview);
  const setPaneview = useUiStore((s) => s.setPaneview);
  const savedRef = useRef(saved);

  const onReady = (event: PaneviewReadyEvent) => {
    const state = savedRef.current;
    const known = new Map(CORE_SECTIONS.map((s) => [s.id, s]));
    const order = [
      ...state.order.filter((id) => known.has(id)),
      ...CORE_SECTIONS.map((s) => s.id).filter((id) => !state.order.includes(id)),
    ];
    for (const id of order) {
      const section = known.get(id);
      if (!section || state.hidden.includes(id)) continue;
      event.api.addPanel({
        id,
        component: id,
        headerComponent: 'section',
        title: section.title,
        isExpanded: !state.collapsed.includes(id),
        size: state.sizes[id] ?? section.size,
        headerSize: SIDEBAR_HEADER_SIZE,
        minimumBodySize: 80,
      });
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    event.api.onDidLayoutChange(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => setPaneview(readPaneviewState(event.api)), 200);
    });
  };

  return (
    <PaneviewReact
      className="oxy-sidebar dockview-theme-oxytocin h-full"
      components={components}
      headerComponents={{ section: PaneHeader }}
      onReady={onReady}
    />
  );
}
