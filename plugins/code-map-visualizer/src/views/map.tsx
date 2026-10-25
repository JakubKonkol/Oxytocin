import { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import cytoscape, { type Core, type NodeSingular } from 'cytoscape';
import { useOxyView, useOxyTheme } from '@oxytocin/plugin-sdk/react';
import type { CodeMapResponse, CodeMapSliceNode, CodeMapSliceEdge, CodeMapRelation } from '@oxytocin/plugin-api';
import { SelectionSchema, type Selection, type Model, type Answer } from '../shared/model';
import { stablePositions, ViewEpoch } from './state';
import './map.css';

const initial = () => SelectionSchema.parse({});
const relationTypes: CodeMapRelation[] = [
  'imports',
  'references',
  'calls',
  'exports',
  'extends',
  'implements',
  'contains',
];
function App() {
  const view = useOxyView(),
    theme = useOxyTheme();
  const [model, setModel] = useState<Model>({ project: null, checkouts: [] }),
    [response, setResponse] = useState<CodeMapResponse>();
  const [changes, setChanges] = useState<Answer['changes']>(),
    [changeRootsTruncated, setChangeRootsTruncated] = useState(false);
  const [selection, setSelection] = useState(initial),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [selected, setSelected] = useState<string>();
  const [listOnly, setListOnly] = useState(false),
    [provenance, setProvenance] = useState('all');
  const [searchText, setSearchText] = useState('');
  const [receiptText, setReceiptText] = useState('');
  const pendingReceipt = useRef<{ projectId: string; selection: Selection } | undefined>(undefined);
  const [history, setHistory] = useState<{ entries: Selection[]; at: number }>({ entries: [initial()], at: 0 });
  const graph = useRef<HTMLDivElement>(null),
    cy = useRef<Core | null>(null),
    gate = useRef(new ViewEpoch()),
    project = useRef('');
  const positions = useRef(new Map<string, { x: number; y: number }>()),
    current = useRef(selection),
    refresh = useRef<() => void>(() => {});
  const camera = useRef<{ zoom: number; pan: { x: number; y: number } } | undefined>(undefined);
  useEffect(() => {
    current.current = selection;
  }, [selection]);
  const load = useCallback(async () => {
    if (!view || !view.visible) return;
    let expected = project.current,
      seq = gate.current.begin(expected);
    setBusy(true);
    setError('');
    try {
      const next = await view.request<Model>('model');
      if (!gate.current.accepts(seq, expected)) return;
      const id = next.project?.id ?? '';
      if (project.current !== id) {
        positions.current.clear();
        cy.current?.elements().remove();
        setResponse(undefined);
        setChanges(undefined);
        setSelected(undefined);
        project.current = id;
        const starting =
          pendingReceipt.current?.projectId === id ? pendingReceipt.current.selection : (next.initial ?? initial());
        pendingReceipt.current = undefined;
        current.current = starting;
        setSelection(starting);
        setReceiptText(starting.receipt ?? '');
        setHistory({ entries: [starting], at: 0 });
      }
      setModel(next);
      if (!id || !next.checkouts.length) {
        setResponse(undefined);
        return;
      }
      if (current.current.view === 'task-context' && !current.current.receipt) {
        setResponse(undefined);
        return;
      }
      const request = gate.current.begin(id);
      seq = request;
      expected = id;
      let answer = await view.request<Answer>('query', current.current);
      if (!gate.current.accepts(request, answer.projectId)) return;
      if (answer.response.code === 'SNAPSHOT_CHANGED' && current.current.view !== 'task-context') {
        answer = await view.request<Answer>('query', { ...current.current, generation: undefined });
        if (!gate.current.accepts(request, answer.projectId)) return;
      }
      setResponse(answer.response);
      setChanges(answer.changes);
      setChangeRootsTruncated(!!answer.changeRootsTruncated);
    } catch (e) {
      if (gate.current.accepts(seq, expected)) {
        setError(String(e));
        setResponse(undefined);
        setChanges(undefined);
      }
    } finally {
      if (gate.current.accepts(seq, expected)) setBusy(false);
    }
  }, [view]);
  useEffect(() => {
    refresh.current = () => {
      void load();
    };
  }, [load]);
  useEffect(() => {
    if (!view) return;
    const epoch = gate.current;
    queueMicrotask(() => void load());
    const unsubscribe = view.onMessage((raw) => {
      const m = raw as { type?: string; projectId?: string; checkoutId?: string; receipt?: string };
      if (m.type === 'open-receipt' && m.projectId) {
        const next = SelectionSchema.parse({ view: 'task-context', checkoutId: m.checkoutId, receipt: m.receipt });
        pendingReceipt.current = { projectId: m.projectId, selection: next };
        gate.current.invalidate();
        current.current = next;
        setSelection(next);
        setResponse(undefined);
        setSelected(undefined);
        setReceiptText(m.receipt ?? '');
        setHistory({ entries: [next], at: 0 });
        refresh.current();
        return;
      }
      if (m.type === 'reset') {
        gate.current.invalidate();
        project.current = '';
        positions.current.clear();
        cy.current?.elements().remove();
        setResponse(undefined);
        setChanges(undefined);
        setSelected(undefined);
        setModel({ project: null, checkouts: [] });
      }
      if (m.type === 'reset' || m.type === 'invalidate') {
        if (current.current.view === 'knowledge' || current.current.view === 'task-context') setResponse(undefined);
        refresh.current();
      }
    });
    const visible = view.onVisibilityChange((shown) => {
      gate.current.invalidate();
      if (shown) {
        cy.current?.resize();
        refresh.current();
      } else {
        cy.current?.stop();
        void view.request('cancel');
      }
    });
    return () => {
      epoch.invalidate();
      unsubscribe();
      visible();
      void view.request('cancel').catch(() => undefined);
    };
  }, [view, load]);
  useEffect(() => {
    if (view) queueMicrotask(() => void load());
  }, [selection, view, load]);
  useEffect(() => {
    if (response?.data?.kind !== 'slice' || !response.data.receiptExpiresAt) return;
    const remaining = Date.parse(response.data.receiptExpiresAt) - Date.now();
    const timer = setTimeout(
      () => {
        setResponse(undefined);
        setError('Receipt expired. Task context unavailable; request a new context.');
      },
      Math.max(0, remaining),
    );
    return () => clearTimeout(timer);
  }, [response]);
  const rawNodes: CodeMapSliceNode[] =
    response?.data?.kind === 'slice'
      ? response.data.nodes
      : response?.data?.kind === 'search'
        ? response.data.matches.map((m) => ({
            id: m.id,
            kind: m.id.startsWith('f:') ? 'file' : 'symbol',
            label: m.name,
            path: m.path,
            signature: m.signature,
            span: m.span,
            whyIncluded: m.whyIncluded.join('; '),
            stale: m.stale,
          }))
        : [];
  const changedPaths = new Set(changes?.files.flatMap((f) => (f.oldPath ? [f.path, f.oldPath] : [f.path])));
  const nodes = rawNodes.map((node) => ({
    ...node,
    learningReview: node.learning?.review,
    learningAdmission: node.learning?.admission,
    learningApplicability: node.learning?.applicability.state,
    changeKind: changes ? (changedPaths.has(node.path ?? '') ? 'changed' : 'dependent') : 'none',
  }));
  const grouped = selection.view === 'impact' || selection.view === 'changes';
  const knowledge = selection.view === 'knowledge' || selection.view === 'task-context';
  const orderedNodes = grouped
    ? [...nodes].sort((a, b) => (a.path ?? a.label).localeCompare(b.path ?? b.label))
    : nodes;
  const edges: CodeMapSliceEdge[] = (response?.data?.kind === 'slice' ? response.data.edges : []).filter(
    (e) => provenance === 'all' || e.prov === provenance,
  );
  const nodesKey = JSON.stringify(nodes),
    edgesKey = JSON.stringify(edges),
    available = model.checkouts.length > 0;
  useEffect(() => {
    if (!graph.current || listOnly) return;
    try {
      const styles = getComputedStyle(document.documentElement),
        color = (token: string) => styles.getPropertyValue(token).trim();
      const instance = cytoscape({
        container: graph.current,
        elements: [],
        layout: { name: 'preset' },
        pixelRatio: 1,
        minZoom: 0.15,
        maxZoom: 2.5,
        hideEdgesOnViewport: true,
        textureOnViewport: true,
        style: [
          {
            selector: 'node',
            style: {
              label: 'data(label)',
              'background-color': color('--accent'),
              color: color('--text-primary'),
              'font-size': 11,
              width: 12,
              height: 12,
              'text-valign': 'bottom',
              'text-margin-y': 6,
              'min-zoomed-font-size': 9,
              'text-max-width': '140px',
              'text-wrap': 'ellipsis',
            },
          },
          {
            selector: 'edge',
            style: {
              label: '',
              width: 1,
              'line-color': color('--text-muted'),
              'target-arrow-color': color('--text-muted'),
              'target-arrow-shape': 'triangle',
              'curve-style': 'bezier',
              'font-size': 9,
              opacity: 0.3,
              'arrow-scale': 0.6,
              color: color('--text-muted'),
            },
          },
          {
            selector: 'node[kind = "group"]',
            style: { 'background-color': color('--map-folder'), width: 20, height: 20 },
          },
          { selector: 'node[kind = "file"]', style: { 'background-color': color('--map-file') } },
          { selector: 'node[kind = "symbol"]', style: { 'background-color': color('--map-symbol') } },
          { selector: '.muted-node', style: { opacity: 0.15 } },
          {
            selector: 'edge.focus-edge',
            style: {
              opacity: 0.9,
              label: 'data(rel)',
              width: 1.5,
              'text-background-opacity': 1,
              'text-background-color': color('--bg-card'),
              'text-background-padding': '3px',
            },
          },
          {
            selector: 'node.focus-node',
            style: {
              'min-zoomed-font-size': 0,
              'text-outline-width': 2,
              'text-outline-color': color('--bg-card'),
              'z-index': 10,
            },
          },
          { selector: 'edge[rel = "contains"]', style: { 'line-style': 'dotted', 'target-arrow-shape': 'none' } },
          { selector: 'edge[prov = "heuristic"]', style: { 'line-style': 'dashed' } },
          {
            selector: 'edge[prov = "knowledge"]',
            style: {
              'line-style': 'dashed',
              'line-color': color('--warning'),
              'target-arrow-color': color('--warning'),
            },
          },
          {
            selector: 'node[kind = "learning"]',
            style: {
              shape: 'round-rectangle',
              'background-color': color('--warning'),
              'border-width': 2,
              'border-color': color('--text-primary'),
            },
          },
          {
            selector: 'node[kind = "learning"][learningReview = "proposed"]',
            style: { shape: 'diamond', 'border-style': 'dashed' },
          },
          {
            selector: 'node[kind = "learning"][learningReview = "accepted"][learningApplicability = "needs-review"]',
            style: { shape: 'triangle', 'border-style': 'dashed' },
          },
          {
            selector: 'node[kind = "learning"][learningAdmission = "automatic"]',
            style: { shape: 'hexagon', 'background-color': color('--text-muted') },
          },
          {
            selector: 'node[kind = "evidence"]',
            style: { shape: 'rectangle', 'background-color': color('--text-muted') },
          },
          {
            selector: 'node[changeKind = "changed"]',
            style: {
              'background-color': color('--warning'),
              shape: 'diamond',
              'border-width': 3,
              'border-color': color('--text-primary'),
            },
          },
          {
            selector: 'node[changeKind = "dependent"]',
            style: { 'background-color': color('--text-muted'), shape: 'round-rectangle' },
          },
          { selector: ':selected', style: { 'border-width': 3, 'border-color': color('--text-primary') } },
        ],
      });
      cy.current = instance;
      instance.on('tap', 'node', (e) => setSelected((e.target as NodeSingular).id()));
      instance.on('tap', (e) => {
        if (e.target === instance) setSelected(undefined);
      });
      const resize = new ResizeObserver(() => instance.resize());
      resize.observe(graph.current);
      return () => {
        resize.disconnect();
        camera.current = { zoom: instance.zoom(), pan: { ...instance.pan() } };
        for (const node of instance.nodes()) positions.current.set(node.id(), { ...node.position() });
        instance.destroy();
        cy.current = null;
      };
    } catch (e) {
      queueMicrotask(() => {
        setError(`Graph unavailable; use the list. ${String(e)}`);
        setListOnly(true);
      });
    }
  }, [listOnly, theme, available]);
  useEffect(() => {
    const instance = cy.current;
    if (!instance) return;
    const visibleNodes = JSON.parse(nodesKey) as CodeMapSliceNode[],
      visibleEdges = JSON.parse(edgesKey) as CodeMapSliceEdge[];
    for (const node of instance.nodes()) positions.current.set(node.id(), { ...node.position() });
    const needsLayout = visibleNodes.some((n) => !positions.current.has(n.id));
    const next = stablePositions(
        visibleNodes.map((n) => n.id),
        positions.current,
      ),
      first = instance.nodes().length === 0;
    instance.batch(() => {
      instance.elements().remove();
      instance.add(
        visibleNodes.map((n) => ({
          data: { ...n, label: n.kind === 'file' ? n.label.split('/').at(-1) : n.label },
          position: next.get(n.id),
        })),
      );
      instance.add(visibleEdges.map((e, i) => ({ data: { ...e, id: `edge:${i}`, source: e.from, target: e.to } })));
    });
    positions.current = next;
    if (first && visibleNodes.length) {
      if (!needsLayout && camera.current) {
        instance.zoom(camera.current.zoom);
        instance.pan(camera.current.pan);
        return;
      }
      instance
        .layout({
          name: 'cose',
          animate: false,
          randomize: false,
          fit: false,
          nodeDimensionsIncludeLabels: true,
          nodeRepulsion: () => 12000,
          idealEdgeLength: () => 140,
          nodeOverlap: 20,
          componentSpacing: 80,
          gravity: 0.25,
          numIter: 500,
        })
        .run();
      instance.fit(undefined, 65);
      if (instance.zoom() > 1.2) {
        instance.zoom(1.2);
        instance.center();
      }
    }
  }, [nodesKey, edgesKey, listOnly, theme, available]);
  useEffect(() => {
    const instance = cy.current;
    if (!instance) return;
    instance.elements().removeClass('muted-node focus-node focus-edge');
    instance.nodes().unselect();
    if (!selected) return;
    const node = instance.getElementById(selected);
    if (!node.length) return;
    node.select();
    const neighbors = node.closedNeighborhood();
    instance.elements().difference(neighbors).addClass('muted-node');
    neighbors.nodes().addClass('focus-node');
    neighbors.edges().addClass('focus-edge');
  }, [selected, nodesKey, edgesKey, listOnly, theme, available]);
  const navigate = (next: Selection) => {
    gate.current.invalidate();
    setSelected(undefined);
    setError('');
    setResponse(undefined);
    setChanges(undefined);
    setSelection(next);
    setHistory((h) => ({ entries: [...h.entries.slice(0, h.at + 1), next].slice(-50), at: Math.min(h.at + 1, 49) }));
  };
  const expand = (node: CodeMapSliceNode) => {
    if (node.kind === 'learning' || node.kind === 'evidence') return;
    if (node.kind === 'group' && node.path)
      navigate({
        ...selection,
        view: 'overview',
        root: { path: node.path },
        generation: response?.freshness.generation,
      });
    else
      navigate({
        ...selection,
        view: node.kind === 'file' ? 'file' : 'neighborhood',
        root: node.kind === 'file' ? { path: node.path! } : { symbolId: node.id },
        generation: response?.freshness.generation,
      });
  };
  const chosen = nodes.find((n) => n.id === selected);
  const travel = (delta: number) => {
    gate.current.invalidate();
    setResponse(undefined);
    setChanges(undefined);
    setSelected(undefined);
    const at = history.at + delta;
    setHistory({ ...history, at });
    setSelection(history.entries[at]!);
  };
  const open = async () => {
    if (!chosen?.path || !chosen.sha256 || !response) return;
    try {
      await view?.request('open', {
        checkoutId: response.checkoutId,
        path: chosen.path,
        sha256: chosen.sha256,
        generation: response.freshness.generation,
        ...(chosen.kind === 'symbol' ? { symbolId: chosen.id, span: chosen.span } : {}),
      });
    } catch (e) {
      setError(String(e));
    }
  };
  return (
    <main className="map">
      <header>
        <h1>Code Map · {model.project?.name ?? 'No project'}</h1>
        <span className="beta" title="Code Map is in beta: not fully tested yet" data-testid="code-map-view-beta">
          Beta
        </span>
        <span className="snapshot" title="Index snapshot">
          {model.checkouts.find((c) => c.checkoutId === response?.checkoutId)?.label ?? 'Main checkout'} ·{' '}
          {response?.freshness.state ?? 'Unavailable'} · Generation {response?.freshness.generation ?? '—'}
        </span>
        {model.checkouts.length > 0 && (
          <label>
            Checkout
            <select
              aria-label="Checkout"
              value={selection.checkoutId ?? model.checkouts.find((c) => c.mode === 'project')?.checkoutId ?? ''}
              onChange={(e) => {
                positions.current.clear();
                cy.current?.elements().remove();
                const next = { ...initial(), checkoutId: e.target.value };
                navigate(next);
                setHistory({ entries: [next], at: 0 });
              }}
            >
              {selection.checkoutId && !model.checkouts.some((c) => c.checkoutId === selection.checkoutId) && (
                <option value={selection.checkoutId}>Checkout removed</option>
              )}
              {model.checkouts.map((c) => (
                <option key={c.checkoutId} value={c.checkoutId}>
                  {c.label}
                  {c.mode === 'worktree' ? ` · ${c.checkoutId}` : ''}
                </option>
              ))}
            </select>
          </label>
        )}
      </header>
      {!model.checkouts.length ? (
        <section>
          <p>Enable Code Map to explore this project.</p>
          <button onClick={() => void view?.executeCommand('oxytocin.codeMap.openSettings', model.project?.id)}>
            Code Map settings
          </button>
        </section>
      ) : (
        <>
          <div className="toolbar">
            <div className="mode-tabs" aria-label="Display mode">
              <button
                aria-pressed={knowledge && !listOnly}
                onClick={() => {
                  setListOnly(false);
                  navigate({ ...selection, view: 'knowledge', generation: undefined });
                }}
              >
                Context
              </button>
              <button
                aria-pressed={!knowledge && !listOnly}
                onClick={() => {
                  setListOnly(false);
                  navigate({ ...initial(), checkoutId: selection.checkoutId });
                }}
              >
                Code
              </button>
              <button aria-pressed={listOnly} onClick={() => setListOnly(!listOnly)}>
                Outline
              </button>
            </div>
            <div
              className="search"
              onKeyDown={(e) => {
                if (e.key === 'Enter')
                  navigate({ ...selection, view: 'search', query: searchText, generation: undefined });
              }}
            >
              <input
                aria-label="Search code"
                placeholder="Search symbols or files…"
                value={searchText}
                onChange={(e) => setSearchText(e.target.value)}
              />
              <button
                onClick={() => navigate({ ...selection, view: 'search', query: searchText, generation: undefined })}
              >
                Find
              </button>
            </div>
            <span className="counts">
              {nodes.length} nodes · {edges.length} links
            </span>
          </div>
          <details className="filters">
            <summary>
              Views &amp; filters{' '}
              <span>
                {selection.view}
                {selection.root && 'path' in selection.root ? ` / ${selection.root.path}` : ''}
              </span>
            </summary>
            <nav aria-label="Code Map views">
              {(
                [
                  'overview',
                  'file',
                  'neighborhood',
                  'search',
                  'changes',
                  'impact',
                  'knowledge',
                  'task-context',
                ] as const
              ).map((mode) => (
                <button
                  key={mode}
                  aria-current={selection.view === mode ? 'page' : undefined}
                  disabled={
                    ((mode === 'file' || mode === 'neighborhood') && !selection.root) ||
                    (mode === 'impact' && !selection.root && (!chosen?.path || chosen.kind === 'group'))
                  }
                  onClick={() =>
                    navigate({
                      ...selection,
                      view: mode,
                      generation: undefined,
                      ...(mode === 'impact' && chosen
                        ? {
                            root:
                              chosen.kind === 'symbol'
                                ? { symbolId: chosen.id }
                                : chosen.path
                                  ? { path: chosen.path }
                                  : selection.root,
                          }
                        : {}),
                    })
                  }
                >
                  {mode === 'task-context' ? 'Task context' : mode[0]!.toUpperCase() + mode.slice(1)}
                </button>
              ))}
              <button disabled={history.at === 0} onClick={() => travel(-1)}>
                Back
              </button>
              <button disabled={history.at >= history.entries.length - 1} onClick={() => travel(1)}>
                Forward
              </button>
              <button onClick={() => refresh.current()}>Refresh</button>
              <label>
                <input type="checkbox" checked={listOnly} onChange={(e) => setListOnly(e.target.checked)} />
                List only
              </label>
            </nav>
            {knowledge && (
              <section className="knowledge-controls" aria-label="Learning inspection">
                <p role="note">
                  Reference findings and recorded evidence. Matching evidence does not verify a claim. Reviewed
                  findings, pending proposals and findings needing review have distinct shapes.
                </p>
                <button onClick={() => void view?.executeCommand('oxytocin.codeMap.openLearnings', model.project?.id)}>
                  Open Learnings manager
                </button>
                {selection.view === 'knowledge' ? (
                  <label>
                    Findings{' '}
                    <select
                      aria-label="Learning filter"
                      value={selection.learningState}
                      onChange={(e) =>
                        navigate({
                          ...selection,
                          learningState: e.target.value as Selection['learningState'],
                          generation: undefined,
                        })
                      }
                    >
                      <option value="active">Applicable reviewed</option>
                      <option value="pending">Pending proposals</option>
                      <option value="stale">Needs review</option>
                      <option value="all">All (inspection)</option>
                    </select>
                  </label>
                ) : (
                  <div>
                    <label>
                      Context receipt{' '}
                      <input
                        aria-label="Context receipt"
                        maxLength={200}
                        value={receiptText}
                        onChange={(e) => setReceiptText(e.target.value)}
                      />
                    </label>
                    <button
                      disabled={!receiptText.trim()}
                      onClick={() =>
                        void view?.executeCommand('oxytocin.codeMap.openReceipt', {
                          projectId: model.project!.id,
                          checkoutId: selection.checkoutId ?? model.project!.id,
                          receipt: receiptText.trim(),
                        })
                      }
                    >
                      Open context receipt
                    </button>
                    <p role="status">
                      {!selection.receipt
                        ? 'Enter a receipt returned by oxy_task_context.'
                        : response?.code && response.code !== 'OK'
                          ? `Task context unavailable: ${response.code}. ${response.hint}`
                          : 'Selected items only; the original question is not retained.'}
                    </p>
                  </div>
                )}
                {response?.code === 'MEMORY_OFF' && (
                  <p role="status">Memory is off. Findings remain in the core Learnings manager.</p>
                )}
              </section>
            )}
            {!knowledge && (
              <>
                <div className="controls">
                  <label>
                    Direction
                    <select
                      value={
                        selection.view === 'impact' || selection.view === 'changes' ? 'incoming' : selection.direction
                      }
                      disabled={selection.view === 'impact' || selection.view === 'changes'}
                      onChange={(e) => navigate({ ...selection, direction: e.target.value as Selection['direction'] })}
                    >
                      {['both', 'incoming', 'outgoing'].map((v) => (
                        <option key={v}>{v}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Depth
                    <select
                      value={selection.depth}
                      onChange={(e) => navigate({ ...selection, depth: Number(e.target.value) })}
                    >
                      {[1, 2, 3].map((n) => (
                        <option key={n}>{n}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Evidence
                    <select value={provenance} onChange={(e) => setProvenance(e.target.value)}>
                      {['all', 'syntax', 'binding', 'heuristic'].map((p) => (
                        <option key={p}>{p}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={selection.includeHeuristic}
                      onChange={(e) => navigate({ ...selection, includeHeuristic: e.target.checked })}
                    />
                    Include heuristic edges
                  </label>
                </div>
                <div className="controls" aria-label="Relation filters">
                  {relationTypes.map((rel) => (
                    <label key={rel}>
                      <input
                        type="checkbox"
                        checked={selection.relations.includes(rel)}
                        onChange={(e) => {
                          const relations = e.target.checked
                            ? [...selection.relations, rel]
                            : selection.relations.filter((r) => r !== rel);
                          if (relations.length) navigate({ ...selection, relations });
                        }}
                      />
                      {rel}
                    </label>
                  ))}
                </div>
              </>
            )}
          </details>
          {grouped && (
            <p role="note">
              Potential dependents in indexed code. This list is not exhaustive; missing edges do not prove code is
              unused.
            </p>
          )}
          {changes && (
            <section aria-label="Changed files" className="changed-files">
              <p>
                {changes.comparison === 'worktree-base'
                  ? `Compared with worktree base ${changes.baseCommit?.slice(0, 12)}`
                  : 'Uncommitted changes compared with HEAD'}{' '}
                · {changes.total} changed files. ◆ Changed file · ▰ Potential dependent.
                {changes.truncated || changeRootsTruncated
                  ? ' Change paths truncated; narrow the change set before relying on this view.'
                  : ''}
              </p>
              {!changes.files.length && <p>No changes reported by Git.</p>}
              {changes.files.map((file, i) => {
                const folder = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : '.';
                const previous = changes.files[i - 1]?.path;
                const previousFolder = previous?.includes('/') ? previous.slice(0, previous.lastIndexOf('/')) : '.';
                return (
                  <div key={file.path}>
                    {(i === 0 || previousFolder !== folder) && <strong>{folder}/</strong>}
                    <div>
                      ◆ {file.path} · {file.status}
                      {file.oldPath ? ` (from ${file.oldPath})` : ''}
                      {!rawNodes.some((n) => n.path === file.path) && ' · not in this bounded indexed slice'}
                    </div>
                  </div>
                );
              })}
            </section>
          )}
          <div className="body">
            <section className="content">
              {!listOnly && <div className="graph" ref={graph} aria-label="Code dependency graph" />}
              {!listOnly && (
                <>
                  <div className="graph-caption">
                    {selection.view === 'overview' ? 'PROJECT STRUCTURE' : selection.view.toUpperCase()}
                    <span>Click to inspect · double-click a node in Outline to explore</span>
                  </div>
                  <div className="graph-legend" aria-label="Node types">
                    <span className="group-key">Folder</span>
                    <span className="file-key">File</span>
                    <span className="symbol-key">Symbol</span>
                    {knowledge && <span>◇ Finding</span>}
                  </div>
                  <div className="zoom-controls">
                    <button aria-label="Zoom in" onClick={() => cy.current?.zoom(cy.current.zoom() * 1.2)}>
                      +
                    </button>
                    <button aria-label="Zoom out" onClick={() => cy.current?.zoom(cy.current.zoom() / 1.2)}>
                      −
                    </button>
                    <button
                      aria-label="Fit graph"
                      onClick={() => {
                        const c = cy.current;
                        if (c) {
                          c.fit(undefined, 65);
                          if (c.zoom() > 1.2) {
                            c.zoom(1.2);
                            c.center();
                          }
                        }
                      }}
                    >
                      ⊙
                    </button>
                  </div>
                  {!nodes.length && !busy && (
                    <div className="empty-graph">
                      {selection.view === 'search'
                        ? 'No matches. Try a symbol or file name.'
                        : knowledge
                          ? 'No findings in this view.'
                          : 'No nodes in this scope.'}
                    </div>
                  )}
                </>
              )}
              {listOnly && (
                <div className="list full">
                  <table aria-label="Code Map nodes">
                    <thead>
                      <tr>
                        <th>Node</th>
                        <th>Kind</th>
                        <th>Relations / direction / evidence</th>
                      </tr>
                    </thead>
                    <tbody>
                      {orderedNodes.map((n, i) => (
                        <NodeRow
                          key={n.id}
                          node={n}
                          edges={edges}
                          setSelected={setSelected}
                          expand={expand}
                          folder={
                            grouped
                              ? n.path?.slice(0, n.path.lastIndexOf('/') < 0 ? 0 : n.path.lastIndexOf('/')) || '.'
                              : undefined
                          }
                          previousPath={i ? orderedNodes[i - 1]?.path : undefined}
                          first={i === 0}
                        />
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
            <aside aria-label="Node details">
              {chosen ? (
                <>
                  <h2>{chosen.label}</h2>
                  <p className="path">{chosen.path}</p>
                  <p>
                    {chosen.kind} {chosen.symbolKind}
                  </p>
                  <pre>{chosen.signature}</pre>
                  <p>{chosen.span ? `Lines ${chosen.span[0]}–${chosen.span[2]}` : ''}</p>
                  <p>
                    Incoming: {edges.filter((e) => e.to === chosen.id).length} · Outgoing:{' '}
                    {edges.filter((e) => e.from === chosen.id).length}
                  </p>
                  <p>{chosen.whyIncluded}</p>
                  {edges.some((e) => e.from === chosen.id || e.to === chosen.id) && (
                    <section className="connections" aria-label="Node connections">
                      <h3>Connections</h3>
                      {edges
                        .filter((e) => e.from === chosen.id || e.to === chosen.id)
                        .map((e, i) => {
                          const other = nodes.find((n) => n.id === (e.from === chosen.id ? e.to : e.from));
                          return (
                            <button key={i} onClick={() => setSelected(other?.id)}>
                              {e.from === chosen.id ? '→' : '←'} {other?.label ?? 'Unknown'}
                              <small>
                                {e.rel} · {e.prov}
                                {e.count ? ` ×${e.count}` : ''}
                              </small>
                            </button>
                          );
                        })}
                    </section>
                  )}
                  {chosen.learning && (
                    <section aria-label="Learning details">
                      <p>
                        {chosen.learning.review} · {chosen.learning.admission ?? 'reviewed'} ·{' '}
                        {chosen.learning.applicability.state} · revision {chosen.learning.revision}
                      </p>
                      <p>
                        {chosen.learning.origin.source} · {chosen.learning.origin.role ?? 'user'} ·{' '}
                        {chosen.learning.scope}
                      </p>
                      <p className="learning-body">{chosen.learning.body}</p>
                      <p>{chosen.learning.rationale}</p>
                      <p>{chosen.learning.applicability.reason}</p>
                      {chosen.learning.evidence.map((e, i) => (
                        <p className="path" key={i}>
                          {e.path} · {e.hash}
                        </p>
                      ))}
                    </section>
                  )}
                  {chosen.evidence && <p className="path">Whole-file evidence: {chosen.evidence.hash}</p>}
                  <button
                    disabled={chosen.kind === 'learning' || chosen.kind === 'evidence'}
                    onClick={() => expand(chosen)}
                  >
                    Explore one step
                  </button>
                  <button
                    onClick={() =>
                      navigate({
                        ...selection,
                        view: 'impact',
                        root: chosen.kind === 'symbol' ? { symbolId: chosen.id } : { path: chosen.path! },
                        generation: response?.freshness.generation,
                      })
                    }
                    disabled={
                      !chosen.path ||
                      chosen.kind === 'group' ||
                      chosen.kind === 'learning' ||
                      chosen.kind === 'evidence'
                    }
                  >
                    Show potential dependents
                  </button>
                  <button disabled={!chosen.sha256 || chosen.stale} onClick={() => void open()}>
                    Open in editor
                  </button>
                </>
              ) : (
                <p className="empty-details">Select a node to view details</p>
              )}
            </aside>
          </div>
        </>
      )}
      {busy && <p role="status">Loading map…</p>}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <footer>
        <details>
          <summary>
            {response?.freshness.state ?? 'Unavailable'} · {response?.freshness.coverage.files.indexed ?? 0} indexed
            {response?.truncated ? ' · Partial view' : ''} · Coverage details
          </summary>
          {response ? (
            <>
              {response.truncated ? `Truncated: ${response.reasons.join(', ')}. ` : ''}
              {response.freshness.stale ? 'Snapshot may be stale. ' : ''}Coverage:{' '}
              {response.freshness.coverage.files.indexed} indexed · {response.freshness.coverage.files.unsupported}{' '}
              unsupported · {response.freshness.coverage.files.skipped} skipped ·{' '}
              {response.freshness.coverage.files.failed} failed. Unresolved:{' '}
              {response.freshness.coverage.unresolved.imports} imports · {response.freshness.coverage.unresolved.calls}{' '}
              calls. {response.hint} {response.freshness.warnings.join(' ')}
            </>
          ) : (
            'Code Map is a partial index. Missing edges do not prove code is unused.'
          )}
        </details>
      </footer>
    </main>
  );
}
function NodeRow({
  node: n,
  edges,
  setSelected,
  expand,
  folder,
  previousPath,
  first,
}: {
  node: CodeMapSliceNode & { changeKind: string };
  edges: CodeMapSliceEdge[];
  setSelected: (id: string) => void;
  expand: (node: CodeMapSliceNode) => void;
  folder?: string;
  previousPath?: string;
  first: boolean;
}) {
  const previousFolder =
    previousPath?.slice(0, previousPath.lastIndexOf('/') < 0 ? 0 : previousPath.lastIndexOf('/')) || '.';
  return (
    <>
      {folder && (first || previousFolder !== folder) && (
        <tr>
          <th colSpan={3}>{folder}/</th>
        </tr>
      )}
      <tr key={n.id}>
        <td>
          <button onClick={() => setSelected(n.id)} onDoubleClick={() => expand(n)}>
            {n.changeKind === 'changed' ? '◆ ' : n.changeKind === 'dependent' ? '▰ ' : ''}
            {n.label}
          </button>
        </td>
        <td>
          {n.kind}
          {n.learning && (
            <span>
              {' '}
              · {n.learning.review} · {n.learning.admission ?? 'reviewed'} · {n.learning.applicability.state}
            </span>
          )}
          {n.changeKind === 'changed' ? ' · Changed' : n.changeKind === 'dependent' ? ' · Potential dependent' : ''}
        </td>
        <td>
          {edges
            .filter((e) => e.from === n.id || e.to === n.id)
            .map((e, i) => (
              <div key={i}>
                {e.rel} {e.from === n.id ? 'outgoing' : 'incoming'} · {e.prov}
                {e.count ? ` ×${e.count}` : ''}
              </div>
            ))}
        </td>
      </tr>
    </>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
