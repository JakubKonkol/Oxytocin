# Etap 14 — learnings: wizualizacja i ewaluacja longitudinalna

> Część planu [Code Map](README.md). Przeczytaj `README.md` (sekcje 5.9 FR-LRN-8, 8.9, 8.10) i etapy 09, 12, 13.

## Cel

Wizualizator pokazuje learnings przy ich kotwicach (widoki Knowledge i Task context) za nowym uprawnieniem
`code-map.knowledge.read`, a tryby Review i Automatic zostają zmierzone ewaluacją longitudinalną. Tryb Automatic jest
dostępny w produkcie tylko, jeśli przejdzie swoją bramkę.

## Wymagania wejściowe

- Etapy 13 i 09 zrobione.

## Zadania

### 14.1 Nakładka w wizualizatorze

- Uprawnienie `code-map.knowledge.read` w `src/shared/domain/plugin.ts`; drobne podbicie plugin API (np. 0.2.x) z wpisem
  w changelogu API. Wycinki mieszane wymagają obu uprawnień; bez uprawnienia wiedzy nic nie wycieka przez etykiety ani
  liczby.
- Widok **Knowledge**: węzły learnings połączone z kotwicami kodu/dowodów, filtry stale/pending; wiedza dopuszczona
  automatycznie wygląda inaczej niż przejrzana i inaczej niż fakty strukturalne; nieaktualne rekordy domyślnie ukryte poza
  trybem inspekcji. Przycisk otwierający menedżer Learnings (udokumentowane polecenie rdzenia).
- Widok **Task context**: użytkownik otwiera aktywny receipt udokumentowanym poleceniem rdzenia; zapytanie
  `context-receipt` rekonstruuje wybrane elementy tylko, póki nazwana generacja kodu i rewizja pamięci są dostępne; inaczej
  `SNAPSHOT_CHANGED` lub `RECEIPT_EXPIRED` (jawny stan „unavailable”). Pokazuje wybrane ID, dowody i powody włączenia — nie
  oryginalny prompt. Wyłączenie/usunięcie pamięci lub odwołanie checkoutu unieważnia receipts.
- Wycinek `knowledge` w `src/code-map-host/query/slice.ts`.

### 14.2 Ewaluacja longitudinalna

- Co najmniej 10 sekwencji zadań, po ≥ 3 osobne sesje: odkryj nieoczywiste ograniczenie, rozwiąż powiązane zadanie, zmień
  odpowiedni kod/konfigurację i rozwiąż zadanie następcze. Także niepowiązane późniejsze zadania i błędne wspomnienia.
  Odpowiedzi referencyjne, zakres i testy walidacyjne ustalone przed uruchomieniem.
- Ramiona (ten sam klient/model/ustawienia):

  | Ramię    | Włączone                                         | Co izoluje                                         |
  | -------- | ------------------------------------------------ | -------------------------------------------------- |
  | Baseline | Zwykłe narzędzia, niezmienione instrukcje.       | Wydajność bazowa agenta.                           |
  | A        | Tylko narzędzia struktury.                       | Korzyść indeksu bez pamięci.                       |
  | B-review | A + learnings przejrzane przez użytkownika.      | Korzyść ponownego użycia i koszt przeglądu.         |
  | B-auto   | A + automatyczne dopuszczanie.                   | Jakość przechwytywania i w pełni automatyczne użycie. |

- ≥ 3 powtórzenia na sekwencję/ramię, świeże izolowane magazyny, losowa kolejność ramion, ten sam stan startowy
  repozytorium. Późniejsza sesja używa tylko learnings wygenerowanych wcześniej w tym samym przebiegu; żadnych rozwiązań
  referencyjnych ani korekt z innych ramion w pamięci. Narzut pierwszej sesji raportowany osobno i zamortyzowany.
- Mierz: sukces zadań, powtarzane błędy, faktyczne tokeny wejścia/wyjścia/cache, opóźnienie, zajętość, liczby propozycji,
  odrzuceń/duplikatów, precyzję przydatnych learnings, recall wyszukiwania, użycia złego zakresu/nieaktualnych, czas
  korekt i minuty przeglądu. Źródło każdej metryki kosztu i brakujące dane raportowane; liczba użyć ani `znaki / 4` to nie
  oszczędności.
- Bramki wydania: zero wpisów ze złego checkoutu i znanych unieważnionych w deterministycznych testach wyszukiwania; brak
  regresji poprawności względem A; ≥ 80% wyemitowanych learnings ocenionych jako trafne i przydatne wg rubryki; oraz
  albo 10% niższa mediana kosztu eksploracji w powiązanych zadaniach następczych, albo udokumentowana redukcja
  powtarzanych błędów — z kosztami całych sekwencji i czasem przeglądu. Trafność ≠ prawdziwość; szkodliwe fałszywe
  twierdzenia raportowane osobno.
- Zawsze publikuj przypadki, w których pamięć podniosła koszt lub spowodowała błędy. Jeśli Automatic nie przejdzie — ogranicz
  go/popraw i powtórz ewaluację na nowych, niezanieczyszczonych fixture; do tego czasu tryb Automatic nie jest oferowany
  (to decyzja produktowa wynikająca z bramki, nie feature flag).

## Testy

- Plugin fixture z `code-map.read`, ale bez `code-map.knowledge.read`: wycinki mieszane nie ujawniają wiedzy.
- E2E rozszerzenie `code-map-visualizer.spec.ts`: z pamięcią off; z wiedzą pending/active/stale; z usuniętym checkoutem
  Ensemble; otwarcie receipt i jego wygaśnięcie.

## Kryteria ukończenia

- [ ] Widoki Knowledge/Task context dostępne tylko z możliwościami learnings; uprawnienia przetestowane.
- [ ] Tryby Review i Automatic mają osobne wyniki longitudinalne z narzutem przechwytywania i przypadkami szkodliwymi
      (`results/<data>-learning-evaluation.md`).
- [ ] Tryb Automatic oferowany tylko, jeśli przeszedł bramkę.
- [ ] `npm run check` + E2E zielone.

## Commity i CHANGELOG

- `feat(code-map): show learnings next to their code in the visualizer`
- `docs(code-map): publish the learning evaluation`

CHANGELOG (`### Added`):

> **Code Map Visualizer:** a Knowledge view shows learnings next to the code they are anchored to, by review state, and
> a Task context view shows what an agent received and why.

## Pułapki

- Brak transkryptów, globalnej pamięci preferencji, embeddingów i ukrytych kosztów modeli — także w nakładce.
- Instrukcje projektu pozostają źródłem reguł; learnings to dane referencyjne z dowodami.
