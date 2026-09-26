# 05 — Obszar centralny i silnik układu (dockview)

Wymagania: **R-TERM-2** (podziały pion/poziom), **R-TERM-4** (panele pluginów w podziałach), wsparcie **R-WS-3**.

## 1. Wybór biblioteki

`dockview-react` 8.3.1 (ADR-006). Kluczowe cechy wykorzystywane:
- `DockviewReact` — siatka grup z tabami, podziały, drag&drop paneli/grup, maksymalizacja grupy, floating groups, serializacja `toJSON()`/`fromJSON()`.
- `renderer: 'always'` (per panel lub `defaultRenderer`) — zawartość panelu montowana raz w kontenerze nakładkowym i pozycjonowana nad grupą; przy ukryciu dostaje `display/visibility: hidden` zamiast odłączenia. **Wymagane dla iframe'ów** (przeniesienie iframe w DOM przeładowuje go) i korzystne dla xterm (brak re-parentingu, zachowany scroll).
- `PaneviewReact` — zwijane, przeciągalne sekcje sidebara (Projekty, Zmiany, widoki wtyczek).
- Motyw przez zmienne CSS `--dv-*` mapowane na nasze tokeny.

> Importy i nazwy CSS zweryfikować w spike S3 (pakiet `dockview-react` zależy od `dockview` → `dockview-core`; arkusz stylów zwykle `dockview-core/dist/styles/dockview.css` lub re-export z `dockview-react`).

## 2. Konfiguracja `DockviewReact` (per projekt)

```tsx
<DockviewReact
  className="oxy-dockview"
  components={panelComponents}            // { terminal: TerminalPanel, diff: DiffPanel, plugin: PluginPanel, welcome: WelcomePanel, missing: MissingPanel }
  tabComponents={{ default: OxyTab }}     // tytuł + badge + StatusDot + close
  defaultTabComponent={OxyTab}
  rightHeaderActionsComponent={GroupActions}   // split →, split ↓, maksymalizuj, ⋯
  watermarkComponent={EmptyWorkspace}     // gdy brak paneli: szybkie akcje (nowy terminal, agent, …)
  defaultRenderer="always"
  singleTabMode="fullwidth"               // pojedynczy panel = nagłówek jak tytuł karty (prototyp)
  disableFloatingGroups={false}           // floating dozwolone (M7 polish); popout do nowych okien — wyłączone (API popout nie używane)
  onReady={e => onDockviewReady(projectId, e.api)}
  onDidDrop={handleExternalDrop}          // drop plików z drzewa Zmian → otwarcie diffu
/>
```

`onDockviewReady`: zapamiętaj `api` w `workspaceStore` (per projekt), przywróć układ (§6), podłącz `api.onDidLayoutChange` (zapis, debounce 1 s), `api.onDidActivePanelChange` (fokus, tytuł okna, `activePanelId`).

## 3. Rejestr typów paneli

```ts
// src/renderer/src/features/layout/panel-registry.ts
export type PanelKind = 'terminal' | 'diff' | 'plugin' | 'welcome' | 'missing';

export interface PanelParams {
  terminal: { terminalId: string };
  diff: { projectId: string; path: string; oldPath?: string; preview: boolean };
  plugin: { pluginId: string; panelType: string; instanceId: string; params?: unknown };
  welcome: {};
  missing: { reason: string; descriptor: PanelDescriptor };
}
```

- `params` dockview trzymają tylko identyfikatory; pełny opis panelu jest w `WorkspaceState.panels[panelId]` (deskryptor z [03 §7](03-projects-workspace.md)) — pozwala odtworzyć terminal po restarcie z nowym `terminalId`.
- Id paneli: `term-<nanoid>`, `diff-<hash(path)>`, `plg-<pluginId>-<panelType>-<nanoid>`.
- **Panel wtyczki** (`PluginPanel`) renderuje `PluginFrame` (iframe) — szczegóły w [07 §7](07-plugin-engine.md). Typy paneli wtyczek pochodzą z `contributes.panels` (np. `markdown.preview`, `usage.dashboard`); `singleton: 'project' | 'global' | false` decyduje, czy otwarcie istniejącego fokusuje zamiast tworzyć nowy.

## 4. Operacje na układzie

| Operacja | Implementacja (dockview API) | Skrót |
|---|---|---|
| Nowy terminal w aktywnej grupie | `terminals:create` → `api.addPanel({ id, component: 'terminal', params, title, position: { referenceGroup: api.activeGroup } })` | Ctrl+Shift+T |
| Podziel w prawo | nowy terminal (ten sam profil, cwd = bieżący cwd terminala lub rootPath) → `addPanel({ position: { referencePanel: active.id, direction: 'right' } })` | Alt+Shift+= |
| Podziel w dół | jw. `direction: 'below'` | Alt+Shift+- |
| Zamknij panel | potwierdzenie wg reguł terminala → `panel.api.close()` → dla terminala `terminals:kill` | Ctrl+Shift+W |
| Maksymalizuj/przywróć | `api.maximizeGroup(group)` / `api.exitMaximizedGroup()` | Ctrl+Shift+Enter |
| Fokus sąsiada | wyliczenie grupy w kierunku z geometrii `group.element.getBoundingClientRect()` → `group.api.setActive()` + fokus panelu | Alt+strzałki |
| Zmiana rozmiaru | `group.api.setSize({ width/height ± 5% })` | Alt+Shift+strzałki |
| Przenieś panel | drag&drop tabu / nagłówka (natywne dockview) | — |
| Zmień nazwę | dwuklik na tabie → input inline → `terminals:rename` + `panel.api.setTitle` | — |
| Otwórz diff | panel `diff` w trybie **preview** (kursywa w tabie): pojedynczy klik w drzewie Zmian zastępuje istniejący panel preview; dwuklik lub edycja → `preview=false` (przypięty) | Enter w drzewie |
| Otwórz panel wtyczki | `oxy.ui.openPanel` / polecenie → `addPanel({ component: 'plugin', params, position })` z uwzględnieniem `singleton` | — |

**Pozycja nowych paneli nie-terminalowych** (diff, podgląd markdown): jeśli istnieje grupa oznaczona jako „grupa podglądu” (ostatnio użyta dla diff/preview) → tam; inaczej podział w prawo od aktywnej grupy (terminal agenta zostaje widoczny obok diffu — typowy przepływ „agent pracuje / przeglądam zmiany”).

## 5. Nagłówek/tab panelu (`OxyTab`)

- Terminal: ikona profilu, tytuł (`userTitle` > nazwa agenta > tytuł OSC > nazwa profilu), badge rodzaju (AGENT AI / PROCES / SHELL / ZAKOŃCZONY), `StatusDot` stanu agenta, ikona dzwonka (BEL w tle), ikona ⟳ (`envStale`), cienki pasek postępu OSC 9;4 pod nagłówkiem.
- Diff: ikona typu pliku, nazwa pliku, status (A/M/D/R) kolorem, kursywa w trybie preview, tooltip = ścieżka względna.
- Wtyczka: ikona i tytuł z manifestu lub ustawiony przez wtyczkę (`view.title = …`), opcjonalny badge (`view.badge`).
- Środkowy klik na tabie = zamknij (z tymi samymi potwierdzeniami).
- Menu kontekstowe tabu: Close · Close others · Close all in group · Split right / Split down · Move to new floating group · Rename · (terminal) Restart.

## 6. Serializacja i przywracanie

- **Zapis:** `api.toJSON()` + `panels` (deskryptory) + `activePanelId` → `WorkspaceState` ([03 §7](03-projects-workspace.md)). Debounce 1 s; flush przy przełączeniu projektu i wyjściu.
- **Odczyt:**
  1. Walidacja wersji `WorkspaceState.version` (migracje w main).
  2. Dla każdego deskryptora terminala: jeśli `terminalId` istnieje w rejestrze main (proces żyje — np. reload renderera, rehydratacja z LRU) → użyj; inaczej (restart aplikacji) → `terminals:create` z profilem/cwd/`restoreFrom` i podmień `terminalId` w params.
  3. `api.fromJSON(dockviewJson)` — komponenty zamontują się z właściwymi params. Nieznane `component` (np. usunięta wtyczka) → przed `fromJSON` zamień w JSON na `missing` z zachowanym deskryptorem.
  4. Jeśli `fromJSON` rzuci (uszkodzony JSON) → log + zapis kopii `.corrupt` + układ domyślny (jeden terminal) + toast.
- Rozmiary grup zapisywane przez dockview w JSON (proporcje przeliczane przy zmianie rozmiaru okna).

## 7. Drag & drop — pułapki

- **Iframe'y połykają zdarzenia myszy/drag**: gdy trwa przeciąganie (dockview `onWillDragPanel`/`onWillDragGroup` lub globalne `dragstart` na dokumencie), dodaj klasę `oxy-dragging` do `<body>`, a CSS `body.oxy-dragging iframe { pointer-events: none; }`; zdejmij na `dragend`/`drop`/`mouseup` (+ timeout bezpieczeństwa 5 s).
- **xterm i DnD plików**: `dragover` nad terminalem pokazuje nakładkę „Drop to paste paths” — nie koliduje z DnD paneli, bo dockview używa własnych typów danych w `dataTransfer` (rozróżniaj po `dataTransfer.types`).
- **Drop z drzewa Zmian na obszar centralny**: `onDidDrop` z własnym typem `application/x-oxytocin-change` → otwarcie diffu w miejscu upuszczenia; na terminal → wklejenie ścieżki.
- **Zmiana rozmiaru sashem nad iframe'em**: ta sama klasa `oxy-dragging` podczas `pointerdown` na sashu.

## 8. Fokus

- Aktywny panel (dockview) = panel z fokusem klawiatury. Przy `onDidActivePanelChange`: terminal → `term.focus()`; diff → fokus edytora Monaco; wtyczka → `iframe.focus()` + wiadomość `focus` do SDK.
- Klik w dowolne miejsce panelu aktywuje go (dockview robi to dla nagłówka; dla treści — `pointerdown` w kontenerze → `panel.api.setActive()`).
- Po przełączeniu projektu fokus wraca do `activePanelId` tego projektu.
- Tytuł okna: `<nazwa projektu> — <tytuł aktywnego panelu> — Oxytocin` (prefiks `(n)` przy agentach czekających).

## 9. Sidebar (PaneviewReact)

- Sekcje: `core.projects` (min 120 px), `core.changes` (min 160 px), następnie widoki wtyczek ze slotu `sidebar` wg `order` (Usage Monitor: `order: 300`).
- Każda sekcja: zwijanie, zmiana wysokości, przeciąganie w celu zmiany kolejności, ukrywanie (menu ⋯ na nagłówku sidebara: lista sekcji z checkboxami).
- Stan (kolejność, rozmiary, zwinięcia, ukryte) zapisywany globalnie (`userData/ui-state.json`), nie per projekt.
- Widoki wtyczek w Paneview też muszą mieć stały element DOM (Paneview nie przenosi elementów między rodzicami przy zmianie kolejności? — **zweryfikować w S3**; jeśli iframe się przeładowuje przy reorderze, zastosować wzorzec nakładki: iframe w stałym kontenerze pozycjonowany absolutnie nad placeholderem pane'a, jak `renderer: 'always'`).

## 10. Stylizacja (mapowanie tokenów)

```css
.oxy-dockview {
  --dv-background-color: var(--bg-app);
  --dv-group-view-background-color: var(--bg-card);
  --dv-tabs-and-actions-container-background-color: var(--bg-card);
  --dv-activegroup-visiblepanel-tab-background-color: var(--bg-focus-tint);
  --dv-inactivegroup-visiblepanel-tab-background-color: var(--bg-card);
  --dv-tab-divider-color: var(--border-subtle);
  --dv-separator-border: var(--border-default);
  --dv-paneview-active-outline-color: var(--border-focus);
  --dv-drag-over-background-color: color-mix(in srgb, var(--accent) 18%, transparent);
  --dv-drag-over-border-color: var(--accent);
}
/* spaced cards, as in the prototype */
.oxy-dockview .dv-groupview { border: 1px solid var(--border-subtle); border-radius: var(--radius-card); overflow: hidden; }
.oxy-dockview .dv-groupview.dv-active-group { border-color: var(--border-focus); box-shadow: 0 0 0 1px color-mix(in srgb, var(--border-focus) 35%, transparent); }
/* dashed separator */
.oxy-dockview .dv-split-view-container > .dv-sash-container > .dv-sash { background: transparent; }
.oxy-dockview .dv-sash::after { content: ''; position: absolute; inset: 50% 0 auto 0; border-top: 1px dashed var(--border-default); }
```
(Nazwy klas/zmiennych dockview zweryfikować z wersją 8.3 — powyższe to intencja.)

## 11. Testy i kryteria akceptacji (M2)

- [ ] Podział w prawo i w dół tworzy nowe terminale z tym samym profilem; oba działają niezależnie (E2E).
- [ ] Przeciągnięcie panelu terminala do innej grupy nie resetuje bufora ani procesu; przeciągnięcie panelu wtyczki nie przeładowuje iframe'a (licznik `load` w iframe = 1).
- [ ] Maksymalizacja/przywrócenie, nawigacja Alt+strzałki, zmiana rozmiaru skrótami.
- [ ] Układ (3 grupy, 5 paneli, różne rozmiary) zapisuje się i odtwarza po restarcie; panel nieznanej wtyczki → placeholder „missing”.
- [ ] Diff w trybie preview jest zastępowany kolejnym kliknięciem; dwuklik przypina.
- [ ] Sidebar: zwijanie/zmiana kolejności sekcji trwała po restarcie.
