import { type IPaneviewPanelProps, type PaneviewApi, PaneviewReact, type PaneviewReadyEvent } from 'dockview-react';
import { useEffect, useState } from 'react';
import type { PaneviewState } from '@shared/domain/ui-state';
import { SectionHeader } from '../ui/Section';
import { useUiStore } from '../stores/ui-store';
import { ScratchpadHeaderActions, ScratchpadSection } from '../features/scratchpad/ScratchpadSection';
import { SIDEBAR_HEADER_SIZE } from './Sidebar';

interface SectionDefinition {
  id: string;
  title: string;
  size: number;
}

/** Sections of the right column, top to bottom (new tools are added here). */
const SECTIONS: SectionDefinition[] = [{ id: 'scratchpad', title: 'SCRATCHPAD', size: 400 }];

const components = {
  scratchpad: () => <ScratchpadSection />,
};

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
      {...(props.api.id === 'scratchpad' ? { actions: <ScratchpadHeaderActions /> } : {})}
    />
  );
}

function readPaneviewState(api: PaneviewApi): PaneviewState {
  return {
    order: api.panels.map((p) => p.id),
    sizes: Object.fromEntries(api.panels.filter((p) => p.api.isExpanded).map((p) => [p.id, Math.round(p.height)])),
    collapsed: api.panels.filter((p) => !p.api.isExpanded).map((p) => p.id),
    hidden: [],
  };
}

/** Right column: collapsible, resizable section cards (scratchpad, …), toggled from the title bar. */
export function SecondarySidebar() {
  const onReady = (event: PaneviewReadyEvent) => {
    const state = useUiStore.getState().state.secondaryPaneview;
    const known = new Map(SECTIONS.map((s) => [s.id, s]));
    const order = [
      ...state.order.filter((id) => known.has(id)),
      ...SECTIONS.map((s) => s.id).filter((id) => !state.order.includes(id)),
    ];
    for (const id of order) {
      const section = known.get(id)!;
      event.api.addPanel({
        id,
        component: id,
        headerComponent: 'section',
        title: section.title,
        isExpanded: !state.collapsed.includes(id),
        size: state.sizes[id] ?? section.size,
        headerSize: SIDEBAR_HEADER_SIZE,
        minimumBodySize: 120,
      });
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    event.api.onDidLayoutChange(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => useUiStore.getState().setSecondaryPaneview(readPaneviewState(event.api)), 200);
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
