# stavovy-radek

Stavový pruh nad políčkem, do kterého píšete Claudovi. Na jednom řádku ukáže, kolik máte zbývající paměti okna, jak dlouho ještě platí mezipaměť rozhovoru a kolik už jste vyčerpali z limitů.

Verze 0.5.1 · licence MIT · jen pruh, nic dalšího.

## Co to je

Malý doplněk (plugin, též „mod") pro Claude Code. Nad políčkem pro zprávu přibude pruh, například:

```
fable-5-2 │ ctx 42 % │ cache 37 min │ týden 36 % · 5d 3h │ projekt │ → /compact
```

| Část | Co znamená | Barvy |
| --- | --- | --- |
| `fable-5-2` | Model, se kterým právě mluvíte. | tlumená |
| `ctx 42 %` | Kolik procent okna rozhovoru je zaplněno. | zelená do 50 %, žlutá do 80 %, červená od 80 % |
| `cache 37 min` | Kolik minut ještě platí mezipaměť rozhovoru. Dokud je platná, Claude nemusí číst celý rozhovor znovu, takže je to levnější a rychlejší. Když zrovna běží odpověď, je za číslem poznámka `tah běží`. | zelená nad 25 minut, žlutá od 25 níž, červená od 10 níž, červeně „cache studená“ po vypršení (při jiné životnosti se hranice přepočítají ve stejném poměru) |
| `týden 36 % · 5d 3h` | Kolik procent týdenního limitu je využito a za jak dlouho se obnoví. Když čerpáte rychleji, než plyne čas, objeví se šipka `↑`. Stejně se ukáže i limit za posledních 5 hodin (`5h`) a případně týdenní limit jednotlivého modelu. | podle míry využití (jako `ctx`) |
| `projekt` | Název složky, ve které pracujete (u pracovního stromu gitu ještě `wt` a název). Je-li to repozitář z GitHubu, je název odkaz na něj. | |
| `→ /compact` | Tlačítko. Objeví se, když je okno zaplněné na 50 % a více, nebo když mezipaměť brzy vyprší (bez ohledu na to, kolik procent okna je zaplněno). Kliknutím se spustí zhuštění rozhovoru (příkaz `/compact`). | žlutá nebo červená |

Část, pro kterou zrovna není číslo, se ukáže jako pomlčka nebo se vynechá.

Úplný technický popis, jak každá část vzniká: [docs/JAK-TO-FUNGUJE.md](docs/JAK-TO-FUNGUJE.md).

## Co potřebujete

Claude Code, který umí pluginy (mody zapnuté ve výchozím stavu jsou od verze 2.1.286). Pruh je určený pro okna desktopové aplikace Claude Code.

## Instalace z GitHubu

V okně Claude Code napište:

```
/plugin install stavovy-radek --marketplace ruzicka-decoled/stavovy-radek
```

Claude Code přidá zdroj pluginů (marketplace) a plugin nainstaluje. Zeptá se na rozsah instalace a na nastavení; když si nejste jistí, nechte výchozí hodnoty.

Stejné ve dvou krocích:

```
/plugin marketplace add ruzicka-decoled/stavovy-radek
/plugin install stavovy-radek@stavovy-radek
```

V terminálu totéž bez lomítka, jako `claude plugin …`:

```
claude plugin marketplace add ruzicka-decoled/stavovy-radek
claude plugin install stavovy-radek@stavovy-radek
```

**Plugin se načte až v nově otevřeném okně (nové relaci).** Pruh se tedy objeví po otevření nového okna.

## Instalace ze ZIPu

1. Na stránce repozitáře klikněte na `Code` → `Download ZIP` a stažený soubor rozbalte do složky, kterou si necháte. Složku po instalaci nemažte ani nepřesouvejte, plugin z ní běží.
2. V příkazové řádce přidejte rozbalenou složku jako zdroj pluginů (místo `CESTA` napište, kde složka leží):

```
claude plugin marketplace add CESTA/stavovy-radek-main
```

(GitHub pojmenuje rozbalenou složku `stavovy-radek-main`.)

3. Nainstalujte z ní plugin:

```
claude plugin install stavovy-radek@stavovy-radek
```

4. Otevřete nové okno.

## Nastavení

Plugin má čtyři možnosti. Výchozí hodnoty jsou rozumné, měnit je nemusíte.

| Možnost | Výchozí | Co dělá |
| --- | --- | --- |
| `guard` | `off` | Hlídač nečinného okna. Hodnoty `off`, `compact`, `flush-then-compact`. Popis je níže. |
| `flushText` | `compact` | Text krátké zprávy, kterou hlídač pošle v režimu `flush-then-compact`. |
| `cacheTtlMinutes` | `60` | Jak dlouho platí mezipaměť rozhovoru. Na předplatném 60, u klíče k API 5. Pod hodnotou 30 hlídač nezasahuje. |
| `language` | `cs` | Jazyk slov na pruhu: `cs` česky, `en` anglicky. |

Možnosti změníte v okně Claude Code příkazem `/plugin`: otevřete detail pluginu `stavovy-radek`.

### Hlídač (`guard`)

Ve výchozím stavu je vypnutý. Pruh sám nic nespouští, jen ukazuje čísla a tlačítko.

- `compact`: když necháte okno ležet, mezipaměť má před vypršením 10 minut nebo méně (bez ohledu na zaplnění okna), pruh sám spustí zhuštění rozhovoru. Udělá to jednou za vaši nepřítomnost.
- `flush-then-compact`: nejdřív pošle jako vy krátkou zprávu (text z `flushText`), aby si váš projekt mohl podle svých pokynů uložit poznámky, a potom zhustí rozhovor. Má smysl jen tehdy, když váš projekt na tu zprávu reaguje. Jinak použijte `compact`.

## Co pruh dělá a co ne

- Čísla o využití čte z aplikace, ve které běží.
- Sám nedělá žádné požadavky na internet.
- Nespouští žádné programy.
- Nezasahuje do volání nástrojů.
- Jediné, co může udělat, je tlačítko `→ /compact` (po kliknutí) a hlídač, pokud ho zapnete.

## Aktualizace

Nejdřív obnovte zdroj, potom plugin:

```
claude plugin marketplace update stavovy-radek
claude plugin update stavovy-radek@stavovy-radek
```

U instalace ze ZIPu rozbalte novou verzi přes původní složku. V obou případech pak otevřete nové okno.

## Odinstalace

```
claude plugin uninstall stavovy-radek@stavovy-radek
```

U instalace ze ZIPu můžete potom smazat i rozbalenou složku.

## Když něco nejde

- Pruh není vidět: plugin není nainstalovaný nebo zapnutý, nebo se ještě nenačetl. Otevřete nové okno, v `/plugin` zkontrolujte, že je zapnutý, a podívejte se do záložky Errors.
- U limitů je pomlčka: aplikace zatím nemá čísla. Obvykle se objeví po první odpovědi.
- Tlačítko `→ /compact` chybí: zatím není potřeba. Objeví se, až bude okno plné nebo mezipaměť bude vypršet.

Další postupy (nasazení v týmu, ladění) jsou v [docs/JAK-TO-FUNGUJE.md](docs/JAK-TO-FUNGUJE.md).

## Licence

MIT, viz [LICENSE](LICENSE).

---

English summary

1. A status band above the prompt box in Claude Code: model, context fill, prompt-cache countdown, weekly and 5-hour limits, project, and a compact button. Pure status band, nothing else.
2. Install with `/plugin install stavovy-radek --marketplace ruzicka-decoled/stavovy-radek`, or in two steps: `/plugin marketplace add ruzicka-decoled/stavovy-radek`, then `/plugin install stavovy-radek@stavovy-radek`. Open a new window afterwards.
3. Options: `guard` (off, compact, flush-then-compact), `flushText`, `cacheTtlMinutes`, `language`.
4. It reads usage numbers from the app, makes no network requests, starts no processes and hooks no tool calls.
5. The only actions it can take are the compact button and the optional idle safeguard. License: MIT. Full description (Czech): [docs/JAK-TO-FUNGUJE.md](docs/JAK-TO-FUNGUJE.md).
