# Rozvrhár

Plánovač semestra pre vysokoškolákov. Nahráš rozvrh v PDF, zadáš testy a zadania tak,
ako sú v sylabe („12. týždeň“), a termíny skúšok. Rozvrhár:

- **prepočíta týždne semestra na dátumy** (aj so sviatkami a týždňami, ktoré sa nepočítajú),
- **dá test na tvoju hodinu** – „test v 12. týždni“ = tvoje cvičenie z toho predmetu v 12. týždni,
- **vyberie najlepšie termíny skúšok** – aby si mal na každú dosť času, ťažké predmety viac,
  a podľa možnosti ti ostal opravný termín,
- **naplánuje dni učenia** pred každou skúškou,
- **pošle všetko do Google Kalendára** (vlastný kalendár, hodiny ako opakované udalosti)
  **a do TickTicku** (testy, „začni sa pripravovať“, prihlásenie na skúšku, učenie),
- funguje ako **PWA** (dá sa nainštalovať na mobil, beží aj offline),
- s **prihlásením cez Google** sa dáta synchronizujú medzi zariadeniami (Google Drive, skrytý priečinok aplikácie).

Všetko beží v prehliadači – PDF sa nikam neposiela, žiadny vlastný server (okrem malej proxy pre TickTick).

## Ako na to

Na úvodnej obrazovke pretiahni naraz všetko, čo máš:

| Čo nahráš | Čo z toho Rozvrhár zistí |
|---|---|
| **Časový harmonogram fakulty** | začiatok a koniec výučby, počet týždňov, skúškové obdobie, dni voľna |
| **Rozvrh (napr. z MAIS-u)** | predmety, hodiny, typ (P / CL / CN / S), miestnosti, vyučujúcich |
| **Podmienky zápočtu, sylabus** | testy, odovzdania zadaní, zápočet („6. týždeň“) a termíny skúšok – priradí ich správnemu predmetu |

„Zápočtový test I. v 6. týždni“ sa tak sám zmení na *Ut 27.10. 09:10 – tvoje cvičenie z OS*.
Ak niečo nesedí, dá sa to opraviť v záložkách Predmety a Rozvrh, alebo celý import vrátiť jedným klikom.

## Spustenie lokálne

```bash
python -m http.server 8080
```

Potom otvor <http://localhost:8080>. Na vyskúšanie je v `samples/` ukážkový rozvrh.

Testy logiky (Node 20+):

```bash
npm test
```

## Nasadenie na GitHub Pages

1. Pushni repozitár na GitHub.
2. *Settings → Pages → Build and deployment → Deploy from a branch*, vetva `main`, priečinok `/ (root)`.
3. Aplikácia bude na `https://<používateľ>.github.io/<repo>/`.

## Google prihlásenie + Kalendár

1. V [Google Cloud Console](https://console.cloud.google.com/) vytvor projekt.
2. *APIs & Services → Library*: zapni **Google Calendar API** a **Google Drive API**.
3. *OAuth consent screen*: typ **External**, pridaj scopes
   `calendar.app.created`, `drive.appdata`, `openid`, `email`, `profile`.
   Kým je appka v režime *Testing*, pridaj svoj e-mail medzi **Test users**.
4. *Credentials → Create credentials → OAuth client ID → Web application*.
   Do **Authorized JavaScript origins** pridaj `https://<používateľ>.github.io` (a `http://localhost:8080` na testovanie).
5. Client ID vlož do `js/config.js` (`googleClientId`) alebo v appke do *Export → Nastavenia → Prepojenia*.

Appka používa scope `calendar.app.created` – vidí a mení **iba kalendár, ktorý sama vytvorila**, nie tvoje ostatné kalendáre.

## TickTick

TickTick pri prihlásení vyžaduje *client secret*, ktorý nemôže byť v prehliadači. Preto je v `worker/`
malá Cloudflare Worker proxy (zadarmo):

1. Na <https://developer.ticktick.com/manage> vytvor aplikáciu. Ako **OAuth redirect URL** nastav
   `https://rozvrhar-ticktick.<tvoj-subdoména>.workers.dev/callback`.
2. V `worker/wrangler.toml` nastav `ALLOWED_ORIGINS` na adresu, kde beží appka.
3. Nasaď:
   ```bash
   cd worker
   npx wrangler deploy
   npx wrangler secret put TICKTICK_CLIENT_ID
   npx wrangler secret put TICKTICK_CLIENT_SECRET
   ```
4. URL workera vlož do `js/config.js` (`ticktickProxy`) alebo v appke do nastavení.

Bez proxy môžeš úlohy skopírovať ako text alebo použiť export `.ics`.

## Ako sa vyberajú termíny skúšok

Prejdú sa všetky kombinácie termínov (nikdy dve skúšky v jeden deň, nikdy v dni, keď nemôžeš).
Každá skúška má čas na učenie od predošlej skúšky; potrebný počet dní závisí od náročnosti (alebo ho zadáš ručne).
Najviac váži, aby žiadna skúška nebola „na poslednú chvíľu“, potom celkový čas na prípravu
(ťažšie a viackreditové predmety majú väčšiu váhu) a či ti po termíne ostane opravný.
Termín, na ktorý si už prihlásený, zamkneš a zvyšok sa prepočíta.

## Čítanie PDF

PDF sa číta cez [pdf.js](https://mozilla.github.io/pdf.js/). Podporované sú:

- mriežka – dni v riadkoch alebo stĺpcoch, časy v hlavičke (`7:30–9:00`, `7:30` / `8:15`, alebo len hodiny `7 8 9 …`),
- zoznam – `Pondelok` a pod tým riadky `07:30 - 09:00 Predmet Prednáška BC300`.

Rozpoznáva typ hodiny, miestnosť, vyučujúceho a párne/nepárne týždne. Výsledok vždy skontroluj –
dá sa upraviť priamo v tabuľke. Naskenované PDF (obrázok) prečítať nevie; vtedy vlož rozvrh ako text.

## Štruktúra

```
index.html, css/, icons/, manifest.webmanifest, sw.js   PWA
js/app.js              UI
js/weeks.js, dates.js  týždne semestra, sviatky, dátumy
js/planner.js          umiestnenie testov, výber termínov skúšok, plán učenia
js/outputs.js, ics.js  udalosti a úlohy, export .ics
js/timetable-parse.js  rozpoznanie rozvrhu z PDF / textu
js/doc-parse.js        harmonogram fakulty, podmienky zápočtu / sylaby
js/google.js           prihlásenie, Drive sync, Google Kalendár
js/ticktick.js         TickTick API
worker/                Cloudflare Worker pre TickTick OAuth
tests/                 testy (node --test)
```

## Licencia

MIT
