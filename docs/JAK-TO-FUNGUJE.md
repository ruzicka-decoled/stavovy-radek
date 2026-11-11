# Jak funguje stavový pruh (stavovy-radek 0.5.0)

Tento dokument popisuje do detailu, co pruh dělá, odkud bere čísla a kdy zasáhne. Vychází výhradně ze zdrojového kódu v tomto repozitáři (`hooks/register.tsx`, `hooks/line.ts`, `.claude-plugin/plugin.json`). Stručný úvod pro uživatele je v [README.md](../README.md).

## Obsah

1. [Co je mod a jak běží](#1-co-je-mod-a-jak-běží)
2. [Životní cyklus a události](#2-životní-cyklus-a-události)
3. [Segmenty pruhu](#3-segmenty-pruhu)
4. [Odpočet mezipaměti (prompt cache)](#4-odpočet-mezipaměti-prompt-cache)
5. [Tlačítko compact](#5-tlačítko-compact)
6. [Hlídač (`guard`)](#6-hlídač-guard)
7. [Nastavení (`userConfig`)](#7-nastavení-userconfig)
8. [Soukromí a bezpečnost](#8-soukromí-a-bezpečnost)
9. [Známá omezení](#9-známá-omezení)
10. [Nasazení v týmu](#10-nasazení-v-týmu)
11. [Řešení potíží a testy](#11-řešení-potíží-a-testy)
12. [Struktura repozitáře](#12-struktura-repozitáře)
13. [Verze](#13-verze)

---

## 1. Co je mod a jak běží

Mod je plugin, který běží uvnitř Claude Code, s oprávněními uživatele (není v izolovaném prostředí, v sandboxu). Mody jsou od Claude Code verze 2.1.286 zapnuté ve výchozím stavu. Tento mod kreslí jediné: pruh nad políčkem pro zprávu.

Proč mod a ne nastavení `statusLine` v `settings.json`: podle komentáře v kódu desktopová aplikace příkaz stavového řádku z nastavení nikdy nespouští, takže by se tam nikdy nenakreslil.

Mod má dvě části:

| Část | Soubor | Úloha |
| --- | --- | --- |
| Hooks modul | `hooks/register.tsx` | Zapojí se do událostí Claude Code (`on(...)`), čte hodnoty z aplikace, drží stav a kreslí pruh. |
| Čistá logika | `hooks/line.ts` | Funkce bez přístupu k aplikaci a bez hodin: nastavení, prahy, barvy, odpočty, čtení odpovědi aplikace, skládání segmentů. Čas přichází vždy jako parametr (milisekundy). Díky tomu se dá celá logika testovat samostatně. |

Soubor `hooks/hooks.json` jen ohlašuje modul: `{ "modules": ["./register.tsx"] }`. Soubor `types/index.d.ts` popisuje tvar hodnot, které mod drží ve svém stavu (`$.state`); `claude plugin validate` podle něj kontroluje, že mod nesahá na jiné klíče.

## 2. Životní cyklus a události

Mod se načte při startu relace (nového okna) a při opětovném načtení pluginů. Po načtení zavolá Claude Code funkci `register(on, options)`, která přečte nastavení (`readSettings`) a zaregistruje háčky na sedm událostí.

| Událost | Co mod udělá |
| --- | --- |
| `session.start` | Vynuluje příznaky (první měření, běžící tah, stav compactu). Zkontroluje uložený odkaz na repozitář. Po `next(e)` vynuluje interní počítadla, spustí 30sekundový časovač (`$.clock.every`) a hned provede první obnovení včetně pomalých čtení. |
| `session.measure` | Uloží zaplnění okna a limity, které hlásí engine (jen jako záložní zdroj, viz oddíl 3). Počítá měření pro diagnostiku. Jestliže se v měření změnila cena (`cost`) nebo zaplnění (`context`), zapíše se to jako poslední aktivita okna (odpověď modelu uprostřed dlouhého tahu obnovuje mezipaměť). **První měření po startu** se jako aktivita nepočítá, jen si mod poznamená, že už jedno viděl; jinak by se obnovené okno tvářilo jako čerstvé. |
| `prompt.submit` | Jen pozoruje. V `try/catch` si zapíše původ zprávy a vždy ji předá dál beze změny, takže ji nemůže zablokovat ani upravit. Zpráva od člověka znovu „natáhne“ hlídač a zruší čekající zhuštění po flush tahu (oddíl 6). |
| `turn.start` | Jen u hlavního tahu (ne u pomocného agenta): nastaví „tah běží“, zapíše poslední aktivitu a čas. Pokud jde o flush tah hlídače, zapamatuje si jeho identifikátor. |
| `turn.complete` | Spočítá tah pro diagnostiku. U hlavního tahu zapíše poslední aktivitu, zruší „tah běží“, přečte znovu využití z enginu, na pozadí si vyžádá čísla z aplikace (bez čekání) a na pozadí předá řízení hlídači (krok 2). |
| `session.compact` | Při jakémkoli zhuštění hlavního rozhovoru (tlačítko, hlídač, ruční `/compact`, automat enginu) ukáže na pruhu „compactuji…“ po dobu zhuštění a ještě 45 s po něm. Zhuštění pomocného agenta a typ `precompute` ignoruje. Výsledek zhuštění vrací beze změny. |
| `ui.render` (komponenta `AbovePrompt`) | Přečte uložené hodnoty, složí segmenty a nakreslí pruh. Když je na místě dotazník (`hasSurvey`) nebo ještě není co ukázat, pustí kreslení dál bez zásahu. |

Kreslicí háček hodnoty jen **čte**; zapisují je ostatní háčky a časovač (zápis do stavu při kreslení aplikace odmítá). Každý zápis proběhne jen tehdy, když se hodnota změnila, takže nezměněný tik nic nepřekreslí. Selhání čtení nikdy nevyleze z háčku ven: zůstane předchozí hodnota a pruh se dál kreslí.

### Časovač

- Každých **30 s** (`REFRESH_MS`) proběhne rychlý tik: přečte využití z enginu, zapíše aktuální čas (díky tomu se odpočet mezipaměti hýbe i bez jakékoli události), uvolní případné podržení tlačítka compact a nechá hlídač posoudit situaci.
- Každý **4. tik** (asi 2 minuty, `APP_EVERY_TICKS`) a při startu proběhne i pomalé čtení: model, složka projektu, adresa repozitáře, příznak pracovního stromu, kontrola diagnostického přepínače a čísla z aplikace.

## 3. Segmenty pruhu

Pořadí zleva doprava: model, `ctx`, `cache`, `5h`, týden, týdenní limity jednotlivých modelů, projekt, pracovní strom, tlačítko compact. Oddělovač je ` │ `. Dokud se pruh nepřipraví poprvé (chybí „teď“), je prázdný a kreslení se přenechá aplikaci.

### Odkud se berou čísla

| Údaj | Zdroj |
| --- | --- |
| Model | `$.session.model()` |
| Složka projektu | `$.session.root()` |
| Adresa repozitáře | `$.session.repo()` |
| Pracovní strom | `$.fs.stat` na `.git` ve složce projektu |
| Zaplnění okna a limity (hlavní zdroj) | Aplikace sama: `$.mcp.call('ccd_session_mgmt', 'get_usage')` – tytéž hodnoty, které ukazuje karta limitů a políčko pro zprávu. Čte se při startu, každé 2 minuty a po každém hlavním tahu. |
| Zaplnění okna a limity (záloha) | `$.session.usage()` a událost `session.measure` |
| Poslední aktivita, „tah běží“ | Události `turn.start`, `turn.complete`, `session.measure` |
| Aktuální čas | `$.clock.now()` |

Důvod dvou zdrojů podle komentáře v kódu: u některých účtů engine ve svých datech limity nenese a zaplnění počítá proti oknu 1 M, takže by se čísla lišila od toho, co ukazuje aplikace. Pravidlo: odečet z aplikace mladší než **5 minut** vyhrává a čísla enginu ho nepřepíšou (zaplnění a limity se posuzují zvlášť). Je-li odečet starší nebo selhal, platí čísla enginu.

### Model

Id modelu bez předpony `claude-` (např. `claude-sonnet-5-5` se ukáže jako `sonnet-5-5`). Tlumená barva. Není-li model znám, segment chybí.

### `ctx` – zaplnění okna

`ctx 42 %` – celé procento, zaokrouhlené **dolů** (aby číslo nikdy nerozporovalo barvu). Barva:

| Zaplnění | Barva |
| --- | --- |
| pod 50 % | zelená |
| od 50 % do 80 % | žlutá |
| od 80 % | červená |

Dokud není hodnota známa, je tam tlumené `ctx –`. Z aplikace se hodnota omezí shora na 100.

### `cache` – mezipaměť

Viz [oddíl 4](#4-odpočet-mezipaměti-prompt-cache).

### Limity: `5h`, týden, týdenní limit modelu

Z odpovědi aplikace (`plan.windows`) se každé okno přiřadí podle popisku:

| Popisek v aplikaci (bez ohledu na velikost písmen) | Druh | Ukáže se jako |
| --- | --- | --- |
| obsahuje „5 h/5-hour“, „five“ nebo „session“ | 5 hodin | `5h 41 %↑ · 2h 13m` |
| „week“ / „7 days“ bez dalšího jména nebo s „all“ | týden, všechny modely | `týden 36 %↑ · 5d 3h` |
| „week“ s dalším jménem, např. „Weekly · Fable“ | týden jednoho modelu | `Fable týd. 12 %↑` |

Další pravidla z kódu:

- Okno se bere jen při stavu `ok` a s číselným, nezáporným procentem; porouchané okno se přeskočí a ostatní se zpracují. Z dvou oken stejného druhu platí první. Druh `spend_limit` (z enginu) a neznámé popisky se nezobrazují.
- Pořadí: `5h`, týden, potom týdenní limity modelů.
- Týdenní limit jednoho modelu se ukáže **jen když je něco využito** (více než 0) a bez údaje o obnovení.
- Procento se zaokrouhluje dolů, barva podle stejné stupnice jako `ctx` (zelená / žlutá od 50 / červená od 80).
- Odpočet obnovení: při zbývajícím čase od jednoho dne `5d 11h` (hodiny dolů), do dne `2h 13m` nebo `47m` (minuty nahoru), po uplynutí času `reset`.
- **Šipka `↑`** za procentem se objeví, když čerpání předbíhá plynutí času: `procento × délka okna > uplynulý čas × 100` (okno 5 hodin nebo 7 dní). Při rovnosti šipka není. Je-li čas obnovení neznámý, není ani šipka, ani odpočet.
- Okno, které účet nehlásí (např. tarif bez limitů), nemá segment.

### Projekt a pracovní strom

- `projekt` je poslední část cesty složky relace. Pokud je adresa repozitáře (`remote`) z GitHubu (`https://github.com/o/r` nebo `git@github.com:o/r`, s `.git` nebo bez), je název odkazem na `https://github.com/o/r`. Adresa s přihlašovacími údaji se nepřijme a odkaz nevznikne; mod si nikdy neukládá surovou adresu, jen odvozený odkaz.
- `wt projekt` se přidá, když je `.git` ve složce **soubor** (v pracovním stromu gitu je `.git` soubor, v hlavním stromu složka).
- Složka pro dočasné soubory relace (scratch) segment nemá: v této verzi rozhraní není dostupná.

## 4. Odpočet mezipaměti (prompt cache)

Mezipaměť rozhovoru drží Claudovi přečtený rozhovor po omezenou dobu od poslední aktivity. Dokud platí, další zpráva nemusí číst celý rozhovor znovu. Pruh odpočítává zbývající minuty od **poslední zaznamenané aktivity**.

**Výpočet:** `zbývá = nahoru( (životnost × 60 000 − (teď − poslední aktivita)) / 60 000 )` minut, shora omezeno na životnost (hodiny, které jdou pozadu, nesmí slíbit víc než jednu životnost).

**Co se počítá jako aktivita:** začátek a konec hlavního tahu a každé měření, ve kterém se hnula cena nebo zaplnění (odpověď modelu; první měření po startu ne). Proto tah, který čeká hodiny na odpověď člověka, odpočítává jako nečinné okno. Za čísly je poznámka `tah běží`, když hlavní tah běží; odpočet tím neovlivní.

**Životnost** (`cacheTtlMinutes`): 60 minut na předplatném, 5 minut u klíče k API. Prahy barev se přepočítají podle ní: `žlutá = round(životnost × 25/60)`, `červená = round(životnost × 10/60)`, aspoň 1 minuta.

| Životnost | Zelená | Žlutá | Červená | Studená |
| --- | --- | --- | --- | --- |
| 60 min | nad 25 min | 25 min a méně | 10 min a méně | 0 min a méně |
| 5 min | nad 2 min | 2 min | 1 min | 0 min a méně |

Zobrazení: `cache 37 min`, po vypršení červené `cache studená` (v angličtině `cache cold`). Pokud poslední aktivita není známa (mod se připojil k oknu, které už nějakou dobu stálo), ukáže se tlumené `cache –`.

## 5. Tlačítko compact

Zhuštění (compact) shrne starší část rozhovoru, uvolní místo v okně a další zpráva vyjde levněji.

### Kdy se tlačítko `→ /compact` ukáže

1. Zaplnění okna je **70 % nebo víc** (žlutá, od 80 % červená). Důvod z komentáře: aplikace sama zhušťuje u 92 %, a ruční zhuštění dřív nechává místo.
2. Nebo **současně**: žádný tah neběží, poslední aktivita je známa, zaplnění je aspoň **30 %** a mezipaměti zbývá tolik, co je červený práh (10 z 60 minut), nebo méně, včetně „studená“. Zhuštění teď zlevní příští zprávu po studené mezipaměti (žlutá).

Jinak tlačítko chybí. Zaplnění neznámé = bez tlačítka. Tlačítko je vždy poslední a nemá oddělovač (na úzkém pruhu se zalomí na vlastní řádek).

### Co přesně stisk spustí

Stisk zavolá `$.command.run({ command: 'compact' })`, tedy skutečný příkaz `/compact`, jako byste ho napsali do políčka. Engine ho řadí do fronty a spustí, až je relace nečinná, takže stisk během tahu nevadí.

### Proč ne jinou cestou

Podle komentářů v kódu byly jiné cesty v aplikaci vyzkoušeny a odmítnuty:

| Cesta | Výsledek |
| --- | --- |
| Slovo „compact“ vložené do rozhovoru | nespustí zhuštění |
| `$.session.compact` | „not available in a headless session yet“ |
| `$.prompt.submit('/compact')` | odmítnuto: text začínající `/` by spustil příkaz jménem uživatele |

### Ochrana proti dvojímu stisku

Po stisku se stav přepne na `running` a tlačítko se změní na prostý text „compactuji…“ (žlutě), takže druhý stisk nemůže zařadit druhé zhuštění. Stav se pustí:

- až háček `session.compact` zaznamená dokončení zhuštění, a **ještě 45 s** po něm (číslo zaplnění se opozdí);
- nebo po **15 minutách** (`COMPACT_FALLBACK_MS`) jako pojistka pro zhuštění, které se nikdy nenahlásí nebo čeká ve frontě za tahem, který nekončí;
- nebo hned, když příkaz skončí chybou (odmítnutí se zapíše do diagnostiky a tlačítko se vrátí).

Stisk zařazený za běžící tah se neřídí návratem příkazu (ten nic neříká o zhuštění); podržení řídí háček `session.compact`.

## 6. Hlídač (`guard`)

Hlídač je jediná věc, kterou mod spustí bez vašeho kliknutí. **Ve výchozím stavu je vypnutý (`off`).** Cíl: okno, které necháte ležet, se zhustí těsně před tím, než mezipaměť vyprší, takže první zpráva po pauze nečte celý rozhovor ze studené mezipaměti.

### Režimy

| Hodnota | Chování |
| --- | --- |
| `off` | Nedělá nic. |
| `compact` | Spustí skutečný `/compact` (stejnou cestou jako tlačítko). |
| `flush-then-compact` | Nejdřív odešle text `flushText` jako vaši vlastní zprávu (tah obnoví mezipaměť a projekt si podle svých pokynů může uložit poznámky), po skončení **toho** tahu spustí `/compact`. |

### Podmínky spuštění (kontrolují se každých 30 s)

Hlídač jedná, jen když platí všechno:

1. Skutečný režim není `off`. Při `cacheTtlMinutes` pod **30** je skutečný režim vždy `off`, ať je nastaveno cokoli (flush tah by se do zbývajícího času nevešel).
2. Čísla jsou z aplikace (odečet z aplikace není starší než 5 minut). V běhu `-p` nebo v terminálové relaci taková čísla nejsou a hlídač nejedná.
3. Neprobíhá zhuštění (`compactState` není `running`).
4. Neběží tah.
5. Poslední aktivita je známa (okno, které mod potkal uprostřed nečinnosti, nikdy nevyhovuje).
6. Zaplnění okna je aspoň **30 %**.
7. Mezipaměti zbývá **nejvýš červený práh a aspoň 2 minuty** (při životnosti 60 min tedy 10 až 2 minuty, tj. přibližně 50. až 58. minuta nečinnosti).
8. Hlídač je „natažený“ (`guardArmed`). Po spuštění se uvolní a natáhne se znovu **až vaší další zprávou**. Okno, ke kterému se nikdo nevrací, se tedy ošetří jednou, ne každou hodinu celou noc.

### Průběh `flush-then-compact`

1. Odešle se `flushText` jako zpráva uživatele (`asUser: true`).
2. První hlavní tah, který nese přesně tento text (bez ohledu na velikost písmen a okolní mezery), se označí jako flush tah.
3. Když tento tah skončí důvodem `answer` (odpovědí), spustí se `/compact`. Přerušený tah, chyba nebo odmítnutí nezhustí nic.
4. Zrušení: když mezitím pošle zprávu člověk, hlídač ustoupí a nezhustí. Když flush tah nezačne nebo neskončí do **20 minut**, hlídač to vzdá a nezhustí nic.

Za zprávu člověka se počítá původ `composer`, `bridge`, `sdk`, `slack-ping`, `auto-continuation` a `unclassified`. Zpráva jiného pluginu (včetně vlastního flush textu), jiné relace, upozornění na pozadí, plánovaná úloha nebo kanál, jakýkoli neznámý původ a zpráva označená jako skrytá (`isMeta`) se nepočítají.

`flushText`: prázdný nebo delší než 500 znaků se nahradí výchozím `compact`.

## 7. Nastavení (`userConfig`)

Definováno v `.claude-plugin/plugin.json`. Neplatná nebo chybějící hodnota spadne na bezpečný výchozí stav (hlídač zůstane vypnutý).

| Klíč | Typ | Výchozí | Co dělá |
| --- | --- | --- | --- |
| `guard` | text: `off`, `compact`, `flush-then-compact` | `off` | Režim hlídače (oddíl 6). |
| `flushText` | text | `compact` | Zpráva, kterou hlídač pošle před zhuštěním v režimu `flush-then-compact`. Jinde se nepoužije. |
| `cacheTtlMinutes` | číslo, 1 až 1440 | `60` | Životnost mezipaměti v minutách: 60 na předplatném, 5 u klíče k API. Škáluje prahy barev odpočtu a tlačítka. Nezaokrouhlené číslo se zaokrouhlí, hodnota nad 1440 se ořízne. |
| `language` | text: `cs`, `en` | `cs` | Jazyk slov na pruhu (týden, tah běží, cache studená, compactuji…). |

**Jak změnit:** Claude Code se na možnosti zeptá při instalaci. Později v okně Claude Code příkazem `/plugin` otevřete detail pluginu `stavovy-radek`. Hodnoty se ukládají do souboru nastavení Claude Code (`settings.json`, část `pluginConfigs`).

Slova podle jazyka:

| | `cs` | `en` |
| --- | --- | --- |
| týdenní limit | `týden` | `week` |
| limit jednoho modelu | `týd.` | `wk` |
| běžící tah | `tah běží` | `turn running` |
| studená mezipaměť | `cache studená` | `cache cold` |
| zhuštění běží | `compactuji…` | `compacting…` |

## 8. Soukromí a bezpečnost

### Co mod čte

- model, složku relace (`$.session.model()`, `$.session.root()`), adresu repozitáře (`$.session.repo()`) a číslo relace (`$.session.id()`, jen pro název diagnostického přepínače),
- zaplnění a limity z enginu (`$.session.usage()`) a z aplikace (`$.mcp.call`),
- existenci souborů přes `$.fs.exists` a typ položky `.git` přes `$.fs.stat`,
- čas (`$.clock.now()`).

Z adresy repozitáře se **uchová jen odvozený odkaz na GitHub** (nebo nic). Surová adresa, která by mohla nést přihlašovací údaje, se neukládá; starší uložená hodnota se při startu překontroluje a případně nahradí.

### Co mod zapisuje

- Vlastní stav pluginu v `$.state` (klíče popsané v `types/index.d.ts`).
- **Diagnostický přepínač pro vývojáře:** jen pokud v pracovní složce existuje soubor `_local/stavovy-radek/diag-<číslo relace>.on`, zapisuje mod při každém tiku soubor `_local/stavovy-radek/pas.json`. Obsahuje text, který pruh ukazuje, počítadla událostí, stav compactu a hlídače, nastavení a zkrácený text případné chyby čtení z aplikace. Přepínač nese číslo jedné relace, aby se víc oken ve stejné složce nepřepisovalo. Přítomnost přepínače se hledá při startu a při pomalém tiku. **Bez tohoto souboru mod nezapisuje nic** a chyba při zápisu diagnostiky se do pruhu nikdy nedostane.

### Co mod nedělá

- **Nevolá síť.** V kódu není žádné `$.http`.
- **Nespouští programy.** V kódu není žádné `$.process`.
- **Nezasahuje do volání nástrojů** a neupravuje zprávy: háček `prompt.submit` zprávu vždy předá dál beze změny.
- Volání `$.mcp.call` míří jen na vestavěný server aplikace `ccd_session_mgmt` a jeho nástroj `get_usage`; jiné volání v kódu není.
- Jediné akce, které mod vyvolá: příkaz `/compact` (po stisku tlačítka, nebo hlídačem, pokud ho zapnete) a v režimu `flush-then-compact` odeslání textu `flushText`.

### Jak si to ověřit

Příkaz `claude plugin validate` vypíše řádky `hooks:` (na které události se mod zapojuje) a `calls:` (jaká volání rozhraní kód obsahuje). Každý si tak může sám ověřit, co mod dělá. Zdroj je celý v tomto repozitáři.

Mod běží s oprávněními uživatele, jako každý jiný mod. `claude --safe-mode` spustí relaci bez nainstalovaných modů.

## 9. Známá omezení

- **Pruh je určený pro okna desktopové aplikace.** Zaplnění a limity se berou z vestavěného serveru aplikace (`ccd_session_mgmt`). Bez něj (běh `-p`, terminálová relace) platí záložní čísla enginu, která u některých účtů nenesou limity a zaplnění počítají proti oknu 1 M; hlídač v takovém případě nejedná.
- **Plugin se načte až v nově otevřeném okně.**
- **Chybějící čísla.** U limitů je pomlčka nebo segment chybí, dokud aplikace čísla nemá (obvykle po první odpovědi). Okno, které nemá známou poslední aktivitu, ukazuje `cache –` a neumí spustit hlídač.
- **Čísla z aplikace se obnovují po 2 minutách** (a po každém hlavním tahu). Odpočet mezipaměti se hýbe po 30 sekundách.
- **Čas v modu je odhad od poslední zaznamenané aktivity.** Aktivitu, o které mod neví (např. práce probíhající mimo hlavní tah), odpočet nezachytí.
- **Hlídač jedná jednou za nepřítomnost** a jen při životnosti mezipaměti aspoň 30 minut. Při 5 minutách (klíč k API) je vždy vypnutý.
- **Stav „compactuji…“ při zhuštění spuštěném jinak než tlačítkem** (ruční `/compact`, automat enginu) závisí na háčku `session.compact`. Na účtech a strojích se vestavěnou pojistkou `sec-default@builtin` (viz oddíl 10) tento háček neběží; pruh, tlačítko i hlídač fungují dál.
- **Správce může mody uživatelů vypnout** volbou `allowManagedModsOnly`; pak pruh neběží vůbec.
- **Složka pro dočasné soubory relace** (scratch) se neukazuje – rozhraní ji v této verzi nenabízí.
- Hlídač v režimu `flush-then-compact` má smysl jen tehdy, když projekt na odeslaný text reaguje (např. uložením poznámek). Jinak použijte `compact`.

## 10. Nasazení v týmu

### Jeden repozitář

Do souboru `.claude/settings.json` toho repozitáře:

```json
{
  "extraKnownMarketplaces": {
    "stavovy-radek": {
      "source": { "source": "github", "repo": "ruzicka-decoled/stavovy-radek" }
    }
  },
  "enabledPlugins": {
    "stavovy-radek@stavovy-radek": true
  }
}
```

- Zdroj pluginů (marketplace) se zaregistruje až poté, co člověk v interaktivní relaci potvrdí důvěru ke složce (workspace trust). V nedůvěryhodné složce se nastavení ignoruje bez hlášky.
- `enabledPlugins` v repozitáři plugin **neinstaluje**. Každý jednou spustí:

```
claude plugin install stavovy-radek@stavovy-radek --scope project
```

Do té doby `/plugin` v záložce Errors hlásí, že plugin je zapnutý v nastavení projektu, ale není nainstalovaný.

### Celá organizace

Stejné klíče (`extraKnownMarketplaces`, `enabledPlugins`) ve spravovaném nastavení (managed settings):

- v administraci claude.ai (Organization settings > Claude Code > Managed settings; vyžaduje roli Owner a plán Team nebo Enterprise),
- nebo přes MDM,
- nebo souborem `managed-settings.json`.

Claude Code pak zdroj pluginů zaregistruje a plugin nainstaluje sám při startu další relace uživatele; vypnutí uživatelem ho nezastaví. Volitelně lze u zdroje přidat `"autoUpdate": true`:

```json
{
  "extraKnownMarketplaces": {
    "stavovy-radek": {
      "source": { "source": "github", "repo": "ruzicka-decoled/stavovy-radek" },
      "autoUpdate": true
    }
  },
  "enabledPlugins": {
    "stavovy-radek@stavovy-radek": true
  }
}
```

### Pojistka u spravovaných účtů

Mod stažený z GitHubu se počítá jako mod **uživatele**, i když ho zapne spravované nastavení. Na účtech Team a Enterprise (přihlášení přes `/login`) nebo na stroji se spravovaným nastavením běží vestavěná pojistka `sec-default@builtin`. U modů uživatele nespouští mimo jiné háčky na `session.compact`, `prompt.compose` a `classic.*`.

Důsledek pro tento mod: háček `session.compact` (stav „compactuji…“ při zhuštění spuštěném jinak než tlačítkem) tam neběží. Pruh, tlačítko i hlídač fungují. Správce může mody uživatelů úplně vypnout volbou `allowManagedModsOnly`; pak pruh neběží vůbec.

## 11. Řešení potíží a testy

| Příznak | Co zkusit |
| --- | --- |
| Pruh není vidět | Otevřít **nové okno** (plugin se načte jen v nové relaci). V `/plugin` zkontrolovat, že je plugin nainstalovaný a zapnutý, a podívat se do záložky **Errors**. |
| Pořád nic | Spustit `claude --debug` a podívat se, zda se plugin načetl. Po změně souborů na disku zkusit `/reload-plugins`. |
| Podezření, že vadí jiný mod | `claude --safe-mode` spustí relaci bez modů. |
| U limitů je pomlčka | Aplikace zatím nemá čísla; obvykle se objeví po první odpovědi. |
| `cache –` | Mod nezná poslední aktivitu okna; po první zprávě se údaj doplní. |
| Chybí tlačítko `→ /compact` | Zatím není potřeba (podmínky v oddíle 5). |
| Hlídač nejedná | Zkontrolovat `guard`, že `cacheTtlMinutes` je aspoň 30, že zaplnění je aspoň 30 % a že se po něm už nepsalo (oddíl 6). |
| Plugin je zapnutý v nastavení projektu, ale není nainstalovaný | Spustit `claude plugin install stavovy-radek@stavovy-radek --scope project` (oddíl 10). |

Kontrola kódu pluginu: `claude plugin validate`.

**Testy** jsou v souborech `hooks/line.test.ts` (čistá logika) a `hooks/register.test.tsx` (háčky). Zdroj je v repozitáři, testy si tedy může projít každý.

## 12. Struktura repozitáře

```
stavovy-radek/
├── .claude-plugin/
│   ├── plugin.json         Manifest pluginu: název, verze 0.5.0, autor, licence a 4 nastavení (userConfig).
│   └── marketplace.json    Zdroj pluginů (marketplace) s jediným pluginem, který leží v kořeni repozitáře.
├── hooks/
│   ├── hooks.json          Ohlašuje hooks modul register.tsx.
│   ├── register.tsx        Zapojení do událostí, čtení z aplikace, stav, tlačítko, hlídač a kreslení pruhu.
│   ├── line.ts             Čistá logika: nastavení, prahy, barvy, odpočty, čtení odpovědi aplikace, segmenty.
│   ├── register.test.tsx   Testy háčků a časovače.
│   └── line.test.ts        Testy čisté logiky.
├── types/
│   └── index.d.ts          Tvar hodnot ve stavu pluginu (podle něj kontroluje claude plugin validate).
├── docs/
│   └── JAK-TO-FUNGUJE.md   Tento dokument.
├── LICENSE                 Licence MIT.
└── README.md               Stručný návod pro uživatele.
```

## 13. Verze

Aktuální verze je **0.5.0** (`.claude-plugin/plugin.json`). Dřívější verze zdroj nepopisuje.
