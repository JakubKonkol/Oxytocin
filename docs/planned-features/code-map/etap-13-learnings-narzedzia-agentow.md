# Etap 13 — learnings: narzędzia agentów i kontekst zadania

> Część planu [Code Map](README.md). Przeczytaj `README.md` (sekcje 5.9, 8.7, 8.10) i etap 12.

## Cel

Agenci dostają kontekst zadania (kod + relacje + pasujące learnings) i mogą zgłaszać learnings oraz feedback przez trzy
nowe narzędzia MCP. Wydanie samodzielne.

## Wymagania wejściowe

- Etap 12 wydany (magazyn i menedżer).

## Zakres

W zakresie: FR-LRN-2 (propozycje agentów), FR-LRN-4, FR-LRN-9; most Ensemble z zakresem wynikającym z roli.

## Narzędzia

Pięć narzędzi strukturalnych z etapu 06 zostaje bez zmian. Nowe są wykrywalne tylko, gdy możliwość jest dostępna; każde
wywołanie sprawdza bieżący stan projektu.

| Narzędzie               | Wejście                                                                                                                              | Wynik i polityka                                                                                                                                                      |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `oxy_task_context`      | Pytanie, opcjonalne ścieżki/ID symboli, wybór checkoutu, `maxChars`, `freshness`.                                                    | Rankowane kotwice kodu, mały wycinek relacji, do trzech obowiązujących learnings, dowody, wykluczenia/ostrzeżenia i nieprzezroczysty receipt. Tylko odczyt. Działa tylko z kodem, gdy pamięć jest off. |
| `oxy_propose_learning`  | Tytuł, rodzaj, treść/uzasadnienie, kotwice/dowody, opcjonalne ID zastępowanego, oczekiwana rewizja, klucz idempotencji.              | ID/rewizja, wynik pending/active, obowiązywanie i powody dopuszczenia. Zapis lokalny; nigdy oznaczone jako read-only.                                                |
| `oxy_learning_feedback` | Receipt, ID/rewizja learnings, wynik (`used`, `irrelevant`, `outdated`, `incorrect`), opcjonalny dowód/powód, klucz idempotencji.     | Zapisany feedback albo element przeglądu; nie może zatwierdzić, usunąć ani awansować zakresu. Zapis lokalny.                                                          |

Limity początkowe: pytanie 2000 znaków; do 8 referencji dowodów/kotwic na propozycję; treść 1500 + uzasadnienie 1200
znaków; 50 propozycji na checkout na godzinę; odpowiedź domyślnie 8000, maks. 24 000 znaków z metadanymi. Za mały budżet
na wymagane metadane → `BUDGET_TOO_SMALL`, nigdy obcięty JSON.

## Składanie kontekstu zadania

1. Autoryzuj i zrekoncyliuj checkout; rozwiąż jawne kotwice i trafienia leksykalne.
2. Rozwiń o jeden krok wspieranymi relacjami w limitach odwiedzin; preferuj różnorodność plików/pakietów.
3. Pobierz kandydatów z pamięci po terminach pytania i wspólnych kotwicach. Wyklucz przed rankingiem: zły zakres, pending,
   rejected, superseded, konfliktowe, nieaktualne.
4. Ranking: dokładne dopasowanie kotwicy i trafność tekstowa, potem ograniczone sygnały świeżości/użycia. Bez embeddingów,
   PageRanka i inferencji semantycznej.
5. Budżet: ok. 70% na wskaźniki kodu/relacje i 30% na learnings, po wymaganych metadanych (niewykorzystane można pożyczyć).
   Odrzucaj całe nisko rankowane elementy — nigdy nie obcinaj proweniencji zachowanego twierdzenia.
6. Zwróć powody włączenia, dowody relacji, świeżość/pokrycie, liczby pominięć i sugestie zawężenia. Pusta wiedza to stan
   normalny. Niekompletny indeks → jawny wynik updating/degraded.

**Receipts** identyfikują wyemitowane ID/rewizje, checkout i generację (bez promptu i transkryptu); trzymane w ograniczonej
pamięci ok. 30 min, związane z dostępnym kontekstem MCP/roli; nieznane, wygasłe i z innego checkoutu odrzucane. Trwała
diagnostyka zapisuje tylko liczby/czasy/klasy błędów.

Przykładowy kształt odpowiedzi (poglądowy; produkcyjny schemat wymaga też pokrycia, pełnego tekstu twierdzeń, zakresów i
diagnostyki budżetu):

```json
{
  "checkoutKey": "checkout-a",
  "generation": "g42",
  "memoryRevision": 17,
  "freshness": { "stale": false, "verification": "metadata" },
  "code": [{ "symbolId": "symbol-a", "path": "src/example.ts", "reason": "exact anchor" }],
  "relations": [],
  "learnings": [
    {
      "id": "learning-1",
      "revision": 2,
      "origin": "agent",
      "review": "automatic",
      "applicability": "current",
      "evidence": [{ "path": "src/example.ts", "hash": "sha256:..." }]
    }
  ],
  "receipt": "opaque-short-lived-id",
  "truncated": false
}
```

Odpowiedzi kontekstu przypinają `(checkoutKey, generation, memoryRevision)`; późniejsze unieważnienie nie może zostawić
zcache'owanej odpowiedzi dla odczytu `latest`. Nie trzymaj czytelnika generacji w nieskończoność z powodu otwartego panelu.

## Zadania

1. `src/main/services/mcp/code-map-learning-tools.ts` (nowy) — trzy narzędzia, zod po obu stronach, budżety, polityki.
2. Składanie kontekstu w hoście (`src/code-map-host/memory/context.ts`) i receipts (`memory/receipts.ts`).
3. Most Ensemble: allowlista narzędzi learnings z zakresem wynikającym z roli.
4. Zaktualizowany blok instrukcji (etap 07) i tekst do skopiowania: „propose only reusable, evidence-backed findings”.

## Testy

- Walidacja obu stron granicy, budżety (`BUDGET_TOO_SMALL`), rate limity, idempotencja.
- Receipts: wygasłe, nieznane, z innego checkoutu odrzucane; feedback `incorrect`/`outdated` zawiesza zwykłe użycie w
  checkoutcie i tworzy element przeglądu; powtarzany/fałszowany feedback ograniczony.
- Wołający Hub podający się za innego autora/rolę: pochodzenie zapisuje faktyczny kontekst uwierzytelnienia.
- Odwołanie roli Ensemble; usunięty/zmergowany worktree: odczyty/zapisy ustają; brak automatycznego awansu.
- Wpis z zakresem projektu pasuje do jednego worktree, a do drugiego nie: obowiązywanie liczone osobno.
- Pamięć wyłączona/niedostępna przy składaniu kontekstu: wynik tylko z kodem jawnie podaje stan pamięci.
- Integracja `tests/integration/mcp-hub.test.ts`: prawdziwe wywołania HTTP trzech narzędzi.
- E2E: fałszywy klient MCP — propozycja → (review) akceptacja w menedżerze → `oxy_task_context` zwraca learning →
  edycja dowodu → learning znika z kontekstu.

## Kryteria ukończenia

- [ ] Trzy narzędzia walidują obie strony granicy, przestrzegają budżetów/polityk i wiążą się z właściwym checkoutem.
- [ ] Późniejsza niezależna sesja ponownie używa obowiązującej wiedzy; zmienione dowody blokują nieaktualne użycie.
- [ ] `npm run check` + integracja + E2E zielone.

## Commity i CHANGELOG

- `feat(code-map): give agents task context with applicable learnings`
- `feat(code-map): let agents propose learnings and report feedback`

CHANGELOG (`### Added`):

> **Code Map learnings for agents:** `oxy_task_context` returns the relevant code, a few relations and applicable
> learnings; agents propose evidence-backed learnings with `oxy_propose_learning` and report whether one helped with
> `oxy_learning_feedback`. In Review mode (the default) you accept proposals before agents reuse them.
