# Betrieb dieser Installation

Diese Kopie von OpenReply läuft für **ein** Instagram-Konto mit eigener Meta-App
(Unified Login, siehe `docs/setup.md`) auf kostenlosen Diensten. Alle Teile
stehen in Frankfurt, soweit der Dienst das anbietet.

| Teil | Dienst | Hinweise |
| --- | --- | --- |
| Web-App, Webhook, Crons | Vercel | Region `fra1` (vercel.json). Variablen nur für *Production*. |
| PostgreSQL | Neon Free | Rechenleistung fest auf 0,25 CU. 100 CU-Stunden pro Monat. |
| Redis | Redis Cloud Free | Eviction-Policy `noeviction`. Kein TLS im Gratis-Tarif. |
| Worker | Oracle Cloud Always Free (Ubuntu 24.04, Node 24, pm2) | Fragt die Datenbank nur alle 30 Minuten ab, damit Neon schlafen kann. |
| Login-Mails | Resend | Ohne eigene Domain nur an die Adresse des Resend-Kontos. |
| Kartenbilder der Angebote | Vercel Blob | Optional, siehe unten. Setzt `BLOB_READ_WRITE_TOKEN` selbst. |

## Meta-App (Unified Login)

Neue Meta-Apps bieten seit Oktober 2026 nur noch „API setup with Unified login“.
Eingerichtet ist:

- Anwendungsfall „Messaging und Content auf Instagram verwalten“, App gehört
  einem Business-Portfolio.
- Login-Konfiguration (Facebook Login for Business): Systemnutzer-Token, läuft
  nie ab, Asset nur Instagram-Konten, Rechte `instagram_basic`,
  `instagram_manage_comments`, `instagram_manage_messages`,
  `instagram_manage_insights`, `business_management`. Ohne `business_management`
  sieht der Token kein Instagram-Konto.
- Weiterleitung `https://<domain>/api/instagram/callback`, Webhook
  `https://<domain>/api/webhook` mit den Feldern comments, messages,
  messaging_postbacks und messaging_seen.
- Jedes verbundene Instagram-Konto braucht ohne App-Review die Rolle
  „Instagram-Tester“ (Einladung in Instagram unter Apps und Websites annehmen).
- Variablen: `META_APP_ID`, `META_LOGIN_CONFIG_ID`, `FACEBOOK_APP_SECRET`.

Getestet am 20.11.2026 mit Standardzugriff und einem Instagram-Konto ohne
App-Rolle: Kommentare, Nachrichten und Button-Klicks kommen an. Follow-Gate und
öffentliche Antwort funktionieren. Voraussetzung ist, dass das verbundene Konto
bei Meta für `comments`, `messages` und `messaging_postbacks` angemeldet ist.
Die App erledigt das beim Verbinden. Verbindungen von vor diesem Stand einmal
neu verbinden.

## Testen und Eigenheiten von Instagram

- Pro Kommentar gibt es genau eine automatische DM (private Antwort).
- Bei Nicht-Followern landet die DM unter „Anfragen“.
- Buttons in DMs („Ich folge dir ✅“, „Link öffnen“) zeigt Instagram nur in der
  App, nicht im Browser.
- Hat eine Person die erste DM nicht beantwortet (im Test zusätzlich gelöscht),
  lehnt Meta weitere private Antworten an sie ab, auch unter anderen Beiträgen:
  Fehler 100 mit Untercode 2534025, „Der Kommentar ist für private Antworten
  ungültig“. Sobald die Person selbst schreibt oder einen Button tippt, geht es
  wieder. Testkonten deshalb Anfragen annehmen lassen, nicht löschen.
- Die öffentliche Antwort („Schau in deine DMs“) kommt nach der DM und nur,
  wenn die DM rausging.
- Für Tests eine Kampagne mit einem Stichwort nutzen, das niemand zufällig
  schreibt (z. B. FOLGETEST). Bei „jeder Beitrag“ durchsucht der Worker alle
  30 Minuten die neuesten Beiträge und darin die Kommentare der letzten 72
  Stunden. Wie viele Beiträge, steht in `COMMENT_POLL_MEDIA_LIMIT`
  (1 bis 50, ohne Angabe 10; `deploy/make-env.mjs` schreibt 30 in
  worker.env). Bei etwa zehn Beiträgen am Tag reichen 10 Beiträge nur einen
  Tag zurück: Ein 35 Stunden alter Kommentar unter dem elftneuesten Reel
  wurde so nie gefunden. Das Alter eines Beitrags zählt dabei nicht, auch ein
  altes Reel bekommt neue Kommentare. Jeder Beitrag kostet pro Durchlauf eine
  Leseanfrage bei Meta, egal wie viele Kampagnen es gibt. Pro Durchlauf
  nimmt sich jede Kampagne höchstens 30 neue Kommentare vor
  (`COMMENT_POLL_MAX_PER_SWEEP`), über alle ihre Beiträge zusammen und die
  ältesten zuerst; der Rest kommt im nächsten Durchlauf dran. Auf einem schon
  laufenden Server kommt der Wert erst an, wenn du `worker.env` neu
  erzeugst (`node deploy/make-env.mjs <ordner>`) und hochlädst
  (`bash deploy/oracle/upload-env.sh <server-ip> <ordner>/worker.env`).
- Die Warte-Nachricht beim Follow-Gate steht in `FOLLOW_RECHECK_ACK_MESSAGE`
  (worker.env, über `deploy/make-env.mjs`).

### Meta-Limits: Wenn Instagram „zu viele Anfragen“ meldet

Meta begrenzt, wie viele Anfragen eine App in einem gleitenden Zeitfenster
stellen darf. Am 21.11.2026 kam nach etwa 25 privaten Antworten in 9 Minuten
(dazu rund 50 aufwendige Abrufe von Unterhaltungen und die Testläufe vom
Morgen) auf jede Anfrage der App nur noch „(#4) Application request limit
reached“, auch auf `GET /me`. Lesen von Beiträgen, Kommentaren und
Unterhaltungen ging weiter. Die Sperre hielt ungefähr eine Stunde: Neue
Versuche nach 5 und 15 Minuten scheiterten, 20 Minuten später gingen zwei
Nachrichten durch und die nächsten drei wieder nicht, etwa 50 Minuten nach
dem letzten aufwendigen Abruf ging alles wieder.

Was das Tool daraus macht:

- Als Limit zählen Metas Fehler 4, 17, 32, 613, 80002 und 80006 (zu viele
  Anfragen) und 368 (vorübergehend gesperrt). Bei einem Limit wurde nichts
  verschickt, die Nachricht kann also später raus. Vorher galten 32, 613,
  80002 und 80006 als „vielleicht zugestellt“ und wurden nie wiederholt.
- Lehnt Meta eine Nachricht (etwa die DM zu einem Kommentar: private
  Antwort, Eröffnungs-DM, Folgen-Bitte, Link) oder die Prüfung, ob die
  Person folgt, mit einem Limit ab, pausiert das Tool das Senden für dieses
  Instagram-Konto: 20 Minuten, bei 368 eine Stunde (einstellbar mit
  `META_THROTTLE_PAUSE_MINUTES` und `META_BLOCK_PAUSE_MINUTES`, 1 bis 240
  Minuten, in worker.env). Eine laufende Pause wird höchstens verlängert,
  nie verkürzt.
- Während der Pause fragt das Tool für die DMs zu Kommentaren nicht bei Meta
  an. Der Kommentar wartet im DM-Protokoll als „Ausstehend“ und kommt nach
  der Pause von selbst wieder dran, verteilt über die Minute danach, damit
  nicht alles auf einmal rausgeht. Der abgelehnte Versuch zählt nicht zu den
  drei Versuchen, die ein Kommentar hat. Erst nach 12 Pausen hintereinander
  (bei 20 Minuten etwa 4 Stunden) gibt das Tool auf, dann steht der
  Kommentar wie bisher auf „Fehlgeschlagen“, mit dem Grund. Doppelt geht
  dabei nichts raus: Vor dem Senden belegt jeder Versuch den Kommentar in
  der Datenbank, und nur einer kommt durch.
- Die öffentliche Antwort unter dem Kommentar kommt wie bisher erst nach der
  DM, also auch erst nach der Pause.
- Die regelmäßige Suche nach verpassten Kommentaren lässt ein pausiertes
  Konto aus, bis die Pause vorbei ist. Meldet Meta beim Lesen selbst ein
  Limit, bricht der Durchlauf an dieser Stelle ab (ein Eintrag in
  *Diagnose*), der nächste läuft wie geplant.
- *Diagnose* zeigt oben „Senden pausiert: Instagram-Limit erreicht“ mit dem
  Konto, der Uhrzeit, bis wann, und wie viele Nachrichten warten
  („Wartend“). In der Zeitleiste steht einmal pro Pause „Instagram-Limit für
  @konto erreicht: Senden pausiert bis …“, mit der Uhrzeit in deiner
  Zeitzone. Als Grund speichert der Worker beim wartenden Kommentar
  „Instagram request limit; next try at … UTC“ (der Worker rechnet in UTC).
- Schon vorher warnt die *Diagnose*: Meta meldet bei jeder Antwort, wie viel
  des Limits verbraucht ist. Ab 80 % schreibt der Worker höchstens alle 10
  Minuten pro Konto einen Eintrag mit den Prozentwerten.
- Das eigene Stundenlimit für private Antworten (750 pro Stunde und Konto)
  gilt weiter wie bisher.
- Genauso warten alle Nachrichten im Chat: nach einem Button-Klick (die
  Prüfung, ob die Person folgt, die Folgen-Bitte, der Link), die Antworten
  auf DMs, die Folgenachricht und alle Nachrichten der Angebote, auch Karte,
  Erinnerung und die Bestätigung nach der Eintragung. Instagram erlaubt
  Nachrichten nur bis 24 Stunden nach dem letzten Tippen oder der letzten DM
  der Person. Eine Nachricht wartet deshalb nur, wenn dieses Fenster nach der
  Pause noch offen ist. Sonst steht der Link oder die DM-Antwort im
  DM-Protokoll auf „Fehlgeschlagen“, und ein Angebot endet mit
  „Nachrichtenfenster geschlossen“.
- Auch im Chat geht dabei nichts doppelt raus: Die wartende Nachricht belegt
  vor dem Senden denselben Eintrag in der Datenbank wie der erste Versuch,
  und nur einer kommt durch. Hat die Person den Link nach der Pause schon auf
  anderem Weg bekommen, schickt ihr wartender Button-Klick ihn nicht noch
  einmal.
- Erst nach 12 Pausen hintereinander gibt das Tool auf: Link oder
  DM-Antwort stehen dann auf „Fehlgeschlagen“, ein Angebot endet mit
  „Rate-Limit“. Das gilt auch für einen Link, der hinter der Prüfung wartet,
  ob die Person folgt. Die Warte-Nachricht beim Follow-Gate fällt während
  einer Pause einfach weg.
- Geht ein wartender Link oder eine wartende DM-Antwort nach der Pause nicht
  mehr raus, steht der Eintrag im DM-Protokoll ebenfalls auf
  „Fehlgeschlagen“, mit dem Grund: wenn du die Kampagne in der Zwischenzeit
  pausiert oder geändert hast (etwa ihre Stichwörter oder die Antwort auf
  DMs), oder wenn die Prüfung nach der Pause kein Folgen mehr findet (dann
  bekommt die Person wieder die Folgen-Bitte). „Ausstehend“ bleibt dabei
  nichts hängen: Solange ein Link wartet, schickt das Tool ihn dieser Person
  nicht auf anderem Weg, etwa wenn sie die Eröffnungs-DM nur liest und nicht
  tippt.
- Über Zernio verbundene Konten bleiben, wie sie sind: Zernios eigenes Limit
  (HTTP 429) löst keine Pause aus.

Damit es gar nicht so weit kommt: Bei Tests nicht Dutzende Kommentare in
wenigen Minuten schreiben, und große Abrufe (etwa viele Unterhaltungen auf
einmal) nicht direkt vor einem Test.

## Manuell senden

Die Seite *Kommentare* im Menü (nur für Inhaber und Admins) zeigt die
Kommentare unter deinen 15 neuesten Beiträgen aus den letzten 7 Tagen, die
neuesten zuerst. „Mehr laden“ nimmt jeweils 15 Beiträge dazu, bis 60. Deine
eigenen Kommentare stehen nicht drin, Antworten unter einem Kommentar sind
keine eigene Zeile. Zuerst siehst du nur die Kommentare „Ohne DM“, mit „Alle“
auch die, zu denen schon eine DM rausging.

Pro Kommentar steht da:

- „DM gesendet · Kampagne“ (mit „von Hand“, wenn du sie hier geschickt hast,
  oder „nicht bestätigt“, wenn Meta unklar geantwortet hat), sonst „Keine DM“
  und darunter, wie der letzte Versuch ausging.
- „Du hast geantwortet“, wenn dein Konto unter dem Kommentar öffentlich
  geantwortet hat.
- „Frage“, wenn der Kommentar ein Fragezeichen hat: Kampagnen mit
  Fragen-Filter lassen ihn von selbst aus.
- „Passt zu: Kampagne“, wenn eine Kampagne ihn von selbst beantworten würde.
  Die Seite rechnet das wie der Worker: Keyword als ganzes Wort (sofern die
  Kampagne nichts anderes sagt), Fragen-Filter, und eine Kampagne für genau
  diesen Beitrag geht vor einer für alle Beiträge.

Darunter wählst du die Kampagne (vorausgewählt ist die passende, sonst
keine) und tippst „DM senden“. Gedacht ist das für Kommentare ohne das genaue
Keyword („kallt“, „Guide bitte“, das Keyword mitten in einem längeren Wort),
für Kommentare, die du erst von Hand beantwortet hast, und für jemanden, der
unter deiner Antwort nach dem Guide fragt (dann schickst du die DM zu seinem
ursprünglichen Kommentar).

- Die DM geht raus wie bei einem Kommentar mit Keyword, mit allem, was die
  Kampagne danach macht: Follow-Gate, Link, Tag, Folgenachricht, Angebote.
  Auch eine pausierte Kampagne lässt sich so senden; die Seite sagt dazu,
  dass sie pausiert ist. Tippt die Person danach auf den Button der DM
  (etwa „Ich folge“), bekommt sie den Link wie bei einer aktiven Kampagne.
  Für alle anderen bleibt die Kampagne pausiert.
- „Öffentlich antworten“ postet die öffentliche Antwort der Kampagne unter
  den Kommentar. Es ist an, außer wenn du dort schon geantwortet hast. Lässt
  du es aus, postet auch später kein automatischer Durchlauf die Antwort zu
  diesem Kommentar, auch nicht, während die DM noch unterwegs ist oder wenn
  Instagram sie ablehnt. Erst wenn du die DM noch einmal mit Haken schickst,
  kommt die Antwort.
- Nach dem Tippen steht in der Zeile „Wird gesendet …“, nach ein paar
  Sekunden das Ergebnis aus dem DM-Protokoll. Dort steht bei solchen DMs
  „(manuell)“ als Keyword. Schickst du mehrere DMs kurz hintereinander,
  gehen sie im Abstand von 20 Sekunden raus, damit Instagram keinen Schwall
  bekommt; die Zeile sagt dann, gegen wann.

Was nicht geht, und warum:

- Instagram erlaubt pro Kommentar genau eine DM (private Antwort). Ging schon
  eine raus, auch mit einer anderen Kampagne, oder vielleicht (unklare
  Antwort von Meta), ist „DM senden“ gesperrt. Schickt der Worker in dem
  Moment selbst eine DM zu demselben Kommentar, wartet einer von beiden auf
  den anderen: Doppelt geht nichts raus. Lehnt Instagram die andere DM ab,
  geht die wartende kurz danach raus.
- Instagram erlaubt die DM nur bis 7 Tage nach dem Kommentar. Ältere
  Kommentare zeigt die Seite nicht.
- Hat Instagram die DM einer Kampagne zu einem Kommentar dreimal abgelehnt,
  ist mit dieser Kampagne Schluss (wie bei den automatischen Versuchen).
- Während einer Meta-Pause (siehe *Meta-Limits* oben) liest die Seite nichts
  und zeigt, bis wann die Pause dauert. Danach lädt sie die Kommentare von
  selbst neu.
- Höchstens 15 DMs von Hand pro Stunde und Konto, egal, wer klickt, und 30
  pro Minute und Person. Am 21.11.2026 haben etwa 25 private Antworten und
  50 Abrufe in einer Stunde das Meta-Limit gerissen, danach ging eine Stunde
  lang gar nichts mehr raus.
- Nur für Konten, die über die eigene Meta-App verbunden sind, nicht über
  Zernio.

Was das bei Meta kostet: Ein Aufruf der Seite liest einmal die Beiträge und
je Beitrag einmal die neuesten 50 Kommentare, bei 15 Beiträgen also
höchstens 16 Leseanfragen; Beiträge ohne einen einzigen Kommentar liest sie
gar nicht. Die App hebt die Antworten 60 Sekunden lang auf: Wer die Seite
in dieser Zeit neu lädt oder mehr lädt, fragt Meta nur nach dem, was noch
fehlt. Im Hintergrund liest die Seite nichts; nach dem Senden fragt sie nur
das DM-Protokoll ab. „DM senden“ liest den einen Kommentar noch einmal bei
Instagram nach (unter welchem Beitrag, wie alt, von wem) und legt die DM dann
in die Warteschlange des Workers, der sie verschickt.

Beim Ausrollen muss auch der Worker aktualisiert werden (siehe *Updates*).
Solange noch der alte Worker läuft, lehnt die Seite „DM senden“ ab („Der
Versand-Dienst ist noch nicht auf dem neuesten Stand“): Der alte Worker
würde den Kommentar sonst wie einen normalen behandeln und mit der Kampagne
beantworten, die von selbst passt, oder gar nicht.

## Verbindung verloren

Am 25.11.2026 hat Meta der App nach dem Verknüpfen von Instagram mit Facebook
still und leise den Zugriff auf das Konto entzogen: Jede Anfrage scheiterte
mit „Object … does not exist, cannot be loaded due to missing permissions“
(Fehler 100/33), es kamen keine Webhooks mehr, und trotzdem stand überall
„Verbunden“. Vier Stunden lang ging keine DM raus, ohne dass es jemand
merkte. Seitdem prüft der Worker die Verbindung selbst.

So erkennt das Tool es:

- Bei jedem Durchlauf der Kommentar-Suche (alle 30 Minuten,
  `COMMENT_POLL_INTERVAL_MS`) fragt der Worker jedes über die eigene
  Meta-App verbundene Konto einmal kurz bei Meta ab
  (`/{ig-id}?fields=id,username`), auch ein Konto ohne aktive Kampagne. Das
  ist eine sehr kleine Anfrage, zwei pro Stunde und Konto.
- Als „verloren“ zählen nur eindeutige Antworten: ein ungültiger oder
  widerrufener Zugang (Fehler 190, 102, 463, 467), fehlende Berechtigungen
  (10, 200 bis 299) und „Konto nicht gefunden“ (100/33). Ein Meta-Limit,
  ein Netzwerkfehler, eine Störung bei Meta (5xx) oder andere Fehler zählen
  nicht.
- Erst zwei solche Antworten hintereinander, mindestens einen Durchlauf
  auseinander, gelten als Unterbrechung: Ein kurzer Aussetzer löst keinen
  Alarm aus. Bei 30 Minuten weißt du es also 30 bis 60 Minuten nach dem
  Verlust. „Unterbrochen seit“ nennt die Zeit der ersten fehlgeschlagenen
  Prüfung.
- Während einer Meta-Pause (siehe *Meta-Limits* oben) fragt der Worker
  nicht nach und meldet auch keine Unterbrechung.
- Über Zernio verbundene Konten prüft das Tool nicht.

Was dann passiert:

- Alle Inhaber und Admins des Workspaces bekommen eine E-Mail an die
  Adresse, mit der sie sich anmelden: „Instagram-Verbindung unterbrochen:
  OpenReply sendet gerade keine DMs“, mit der Uhrzeit (deutsche Zeit), was
  das bedeutet, den üblichen Ursachen und den drei Schritten zum
  Neu-Verbinden mit einem Link auf die Einstellungen. Mitglieder bekommen
  sie nicht. Ist die Verbindung 24 Stunden später noch weg, kommt genau eine
  Erinnerung. Höchstens eine Warn-E-Mail in 24 Stunden pro Konto, auch wenn
  die Verbindung mehrmals abreißt; die Entwarnung „wieder da“ (siehe unten)
  kommt zusätzlich. Reißt die Verbindung nach einer Entwarnung wieder ab,
  kommt die Warnung sofort, damit deine letzte E-Mail nicht „wieder da“
  sagt, während nichts rausgeht; das aber höchstens einmal in 24 Stunden.
  Die E-Mail enthält weder Tracking noch Zugangsdaten (in Resend das
  Öffnungs- und Klick-Tracking der Domain ausgeschaltet lassen).
- Oben auf jeder Seite des Dashboards steht ein roter Hinweis
  „Instagram-Verbindung unterbrochen“ mit dem Grund und „Neu verbinden“.
  In den *Einstellungen* steht beim Konto „Verbindung unterbrochen seit …“
  statt „Verbunden“, mit dem Grund. Die *Diagnose* listet die Unterbrechung oben auf, mit Grund,
  Meta-Code und ob die E-Mail raus ist. Auf der Seite *Kommentare* ist
  „DM senden“ gesperrt, bis du neu verbunden hast.
- `GET /api/health` meldet sie unter `checks.instagram` mit
  `"status": "degraded"` und der Liste der Konten. Der HTTP-Status und der
  oberste `status` bleiben, wie sie sind: Ein externer Monitor schlägt
  deshalb nicht an. Wer darauf reagieren will, liest `checks.instagram`.

So verbindest du neu (Inhaber oder Admin, etwa zwei Minuten):

1. *Einstellungen* öffnen (der Link in der E-Mail führt direkt hin).
2. „Neu verbinden“ oder „Mit eigener Meta-App verbinden“ tippen und bei
   Meta anmelden.
3. Das Instagram-Konto wählen und, falls es mit einer Facebook-Seite
   verknüpft ist, auch diese Seite. Alle Berechtigungen erlauben.

Ist Instagram mit einer Facebook-Seite verknüpft (etwa für Musik über
Metricool), stellt Meta Button-Tipps, DMs und Lesebestätigungen nur zu,
wenn die App auch die Seite hat. Fehlt sie, kommen Kommentare weiter an,
aber nach der ersten DM passiert nichts mehr, ohne Fehlermeldung (so am
25./26.11.2026). Die Anmelde-Konfiguration der Meta-App braucht dafür die
Asset-Art „Seiten“ und die Rechte `pages_show_list` und
`pages_read_engagement`; nach einer Änderung dort einmal neu verbinden.

Danach ist die Unterbrechung sofort vorbei, Hinweis und Sperre
verschwinden. Ohne Neu-Verbinden endet sie mit der ersten Prüfung, die
wieder durchkommt. In beiden Fällen holt der Worker gleich danach die
Kommentare aus der Zwischenzeit nach, genau einmal pro Unterbrechung:

- Er liest deine Beiträge (die neuesten 300) und bei jedem Beitrag, zu dem
  eine aktive Kampagne passt und der Kommentare hat, die Kommentare ab dem
  Beginn der Unterbrechung minus 45 Minuten (höchstens 500 Seiten mit je 50
  Kommentaren). Was dabei liegen bleibt (ältere Beiträge, Beiträge über der
  Grenze, Beiträge, die Meta nicht hergibt), steht in der *Diagnose* und in
  der E-Mail danach.
- Jeder Kommentar, der zu einer aktiven Kampagne passt (Keywords als ganzes
  Wort, Fragen-Filter, Kampagne des Beitrags vor „jeder Beitrag“, wie bei
  der normalen Suche), höchstens 7 Tage alt ist, nicht von dir selbst ist
  und noch keine DM bekommen hat, bekommt seine DM: eine alle 2,5 Minuten,
  also höchstens 24 pro Stunde, damit auch nach einer langen Unterbrechung
  kein Schwall an Meta geht. Jeder Kommentar bekommt dabei höchstens eine
  DM, wie immer.
- Meldet Meta schon 60 % eines Limits, warten die nachgeholten DMs, bis
  wieder Luft ist: Neue Kommentare und Leute, die gerade auf einen Button
  tippen, gehen vor. Trifft eine Meta-Pause das Nachholen, reihen sich die
  wartenden DMs danach im selben Abstand wieder ein, statt alle auf einmal
  rauszugehen.
- Reißt die Verbindung wieder ab, während nachgeholte DMs noch warten, geht
  keine davon raus, und keine verbraucht einen ihrer drei Versuche. Das
  Nachholen nach dieser Unterbrechung oder die normale Suche schickt sie
  später, und auf der Seite *Kommentare* kannst du sie von Hand senden.
- Kommentare, auf die du in der Zwischenzeit schon selbst geantwortet hast,
  bekommen keine automatische DM (vielleicht hast du den Guide schon von
  Hand geschickt). Diese Kommentare stehen in der E-Mail und in der
  *Diagnose* mit Name, Text, Uhrzeit und Link zum Beitrag. Soll jemand davon die DM doch noch
  bekommen, schick sie auf der Seite *Kommentare* mit „DM senden“.
- Während einer Meta-Pause liest der Worker nichts und macht nach der Pause
  dort weiter, wo er aufgehört hat. Dasselbe, wenn Meta ein Limit meldet,
  der Worker neu startet oder Meta schon 60 % eines Limits meldet. Nach 24
  Stunden hört er mit dem auf, was er hat.
- Solange das Nachholen läuft und bis die letzte nachgeholte DM raus ist,
  lässt die normale Suche nach verpassten Kommentaren dieses Konto aus,
  damit nichts doppelt angestoßen wird.

Ist alles nachgeholt, bekommen alle Inhaber und Admins die E-Mail
„Instagram-Verbindung wieder da: OpenReply sendet wieder DMs“: wie lange die
Verbindung weg war, wie viele Kommentare ihre DM jetzt bekommen, die Liste
der Kommentare, auf die du selbst geantwortet hast, und der Link zur Seite
*Kommentare*. Auch die *Diagnose* zeigt das sieben Tage lang. Die E-Mail
kommt einmal; ist die Verbindung bis dahin schon wieder weg oder ging sie 24
Stunden lang nicht raus, kommt sie nicht mehr.

Neu verbinden musst du immer, wenn sich bei der Verknüpfung etwas ändert:
Instagram mit Facebook verknüpft oder davon getrennt, Änderungen im
Unternehmensportfolio (Meta Business Suite), die App in Instagram unter
„Apps und Websites“ entfernt, Passwort- oder Sicherheitsänderungen.

Damit die E-Mail rausgeht, braucht der Worker die E-Mail-Einstellungen:
`deploy/make-env.mjs` schreibt `RESEND_API_KEY`, `EMAIL_FROM` und
`DEFAULT_LOCALE=de` jetzt auch in `worker.env`; die Adresse für den Link in
der E-Mail steht dort schon als `NEXTAUTH_URL`. Auf einem schon laufenden
Server erst `worker.env` neu erzeugen (`node deploy/make-env.mjs <ordner>`)
und hochladen (`bash deploy/oracle/upload-env.sh <server-ip>
<ordner>/worker.env`). Fehlen die Einstellungen, schreibt der Worker einmal
pro Start eine Warnung in die *Diagnose* und schickt keine E-Mail; der
Hinweis im Dashboard kommt trotzdem. Ohne eigene Domain in Resend
(Absender `onboarding@resend.dev`) kommt die E-Mail, wie die Login-Mails,
nur an der Adresse deines Resend-Kontos an. Läuft die Anmeldung über einen
eigenen SMTP-Server (`EMAIL_SERVER`), schickt der Worker auch die E-Mail
darüber.

### Nachrichten kommen nicht an

Am 25./26.11.2026 kamen nach dem Verknüpfen von Instagram mit einer
Facebook-Seite 21 Stunden lang zwar alle Kommentare an, aber keine
Button-Tipps, keine DMs und keine Lesebestätigungen. Jede erste DM ging raus,
doch wer auf „Ja, schick ihn mir“ getippt hat, bekam nichts. Die Prüfung oben
blieb grün, weil das Konto und seine Kommentare lesbar waren, und niemand
merkte etwas. Seitdem achtet der Worker auch darauf.

So erkennt das Tool es, ganz ohne Anfrage an Meta, nur aus der eigenen
Datenbank:

- Bei jedem Durchlauf der Kommentar-Suche (alle 30 Minuten) schaut der
  Worker bei jedem über die eigene Meta-App verbundenen Konto nach, wer eine
  erste DM (die mit dem Button) bekommen hat und ob danach irgendetwas aus
  den DMs angekommen ist: ein Button-Tipp, eine DM (nicht die Kopie deiner
  eigenen), eine Lesebestätigung oder eine Reaktion, auch als „Standby“,
  wenn gerade eine andere App die Unterhaltungen bekommt. Kommentare zählen
  nicht.
- „Still“ ist eine Prüfung, wenn mindestens 3 verschiedene Leute vor 12 bis
  18 Stunden ihre erste DM bekommen haben und seit der ersten davon nichts
  mehr angekommen ist. Erst zwei stille Prüfungen hintereinander, mindestens
  einen Durchlauf auseinander, gelten als Störung. „Seit“ nennt die Zeit, zu
  der zuletzt etwas aus den DMs ankam.
- Es zählen nur erste DMs: nicht der Link nach einem Tipp, keine Antworten
  auf DM-Keywords, keine DMs, bei denen unklar ist, ob sie ankamen, und nur
  DMs nach dem Ende der letzten Unterbrechung der Verbindung.
- Keine Prüfung, solange die Verbindung unterbrochen ist oder die
  Verbindungsprüfung oben gerade einmal fehlgeschlagen ist (dann kommt
  ohnehin nichts an), solange eine Meta-Pause läuft und solange das Konto
  keine aktive Kampagne mit erster DM hat.

Die Grenzen sind an den echten Daten vom 20. bis 26.11.2026 eingestellt.
Die Störung hätte das Tool am 26.11. zwischen 10:22 und 10:51 Uhr gemeldet,
je nachdem, auf welche Minute die Durchläufe fallen (um 10:30 Uhr bei
Durchläufen zur vollen und zur halben Stunde), also gut 12 Stunden nach den
ersten DMs ohne Antwort und rund eine Stunde, bevor sie behoben war. Davor
hätte es nie angeschlagen, auch nicht in ruhigen Nächten. Am knappsten war
die Nacht vom 24. auf den 25.11.: Fünf Leute bekamen zwischen 13:06 und
23:17 Uhr ihre erste DM, und 24 Stunden lang kam nichts zurück, bis um 08:16
Uhr eine Lesebestätigung eintraf. Eine stille Prüfung hätte es frühestens 93
Minuten danach gegeben. Ein falscher Alarm ist schlimmer als ein paar
Stunden Verzögerung; deshalb sind die Grenzen eher vorsichtig.

Ändern lassen sie sich in `worker.env`, nötig ist das nicht:
`MESSAGING_SILENCE_MIN_PEOPLE` (wie viele Leute, Standard 3, erlaubt 2 bis
10), `MESSAGING_SILENCE_MIN_AGE_HOURS` (wie alt ihre erste DM mindestens
ist, Standard 12, erlaubt 4 bis 36) und `MESSAGING_SILENCE_WINDOW_HOURS`
(wie alt höchstens, Standard 6 mehr als das Mindestalter, also 18; erlaubt
1 bis 48 mehr). Werte außerhalb setzt der Worker auf die nächste Grenze,
Unsinniges auf den Standard, und schreibt das einmal pro Start in die
*Diagnose*. Weniger Leute oder kürzere Zeiten melden früher, aber auch öfter
falsch.

Was dann passiert, genau wie bei der unterbrochenen Verbindung:

- Alle Inhaber und Admins bekommen die E-Mail „Instagram gibt keine
  Button-Tipps weiter: Nach der ersten DM passiert nichts“: seit wann, was
  das heißt, die üblichen Ursachen und wie du es behebst, mit dem Link auf die
  Einstellungen. Ist nach 24 Stunden immer noch nichts angekommen, kommt
  genau eine Erinnerung. Höchstens eine solche Warnung in 24 Stunden pro
  Konto; kommt nach einer Entwarnung wieder eine Störung, warnt das Tool
  sofort, aber höchstens einmal in 24 Stunden. Die E-Mails zur unterbrochenen
  Verbindung zählen dabei nicht mit. Gleiche Einstellungen, gleicher Versand.
- Oben auf jeder Seite steht ein roter Hinweis „Instagram gibt keine
  Button-Tipps weiter“ mit den Ursachen und „Neu verbinden“. In den
  *Einstellungen* steht beim Konto „Seit … keine Button-Tipps, DMs und
  Lesebestätigungen“, oben „Nachrichten kommen nicht an“ statt „Verbunden“.
  Die *Diagnose* listet die Störung mit der E-Mail. Ist gleichzeitig die
  Verbindung unterbrochen, zeigt das Dashboard nur das.
- `GET /api/health` meldet sie unter `checks.instagram` mit
  `"status": "degraded"` und der Liste `silences` (Grund
  `messaging-silence`). HTTP-Status und oberster `status` bleiben, wie sie
  sind.
- DMs gehen weiter raus, „DM senden“ auf der Seite *Kommentare* geht auch.

Die üblichen Ursachen und was du tust:

1. Instagram wurde mit einer Facebook-Seite verknüpft oder davon getrennt:
   neu verbinden und dabei die Seite mit auswählen (siehe oben).
2. In Instagram ist „Zugriff auf Nachrichten erlauben“ ausgeschaltet:
   einschalten.
3. In der Meta Business Suite ist unter „Weiterleiten von Unterhaltungen“
   eine andere App als Standard für Instagram eingetragen: deine eigene
   Meta-App dort als Standard eintragen.

Vorbei ist die Störung mit dem ersten Button-Tipp, der ersten DM, Reaktion
oder Lesebestätigung, die wieder ankommt: sofort, wenn sie ankommt, sonst
mit dem nächsten Durchlauf. Neu verbinden allein beendet sie nicht, erst
etwas, das wirklich ankommt.

Gleich danach sucht der Worker die Button-Tipps, die in der Störung verloren
gegangen sind, genau einmal pro Störung:

- Er schaut sich alle an, die in der Störung eine erste DM bekommen haben
  und seitdem weder noch einmal getippt noch den Link bekommen haben. Wer
  nach der Störung selbst noch einmal getippt hat, hat seine Antwort schon.
  Höchstens 50 Leute, die mit der neuesten ersten DM zuerst; alle weiteren
  zählen als „nicht nachgesehen“. Kampagnen, die du inzwischen pausiert
  hast, lässt er aus, außer du hast der Person die DM von Hand geschickt.
- Ihre Unterhaltungen findet er in der Liste deiner Unterhaltungen bei Meta,
  die neuesten zuerst. Eine Unterhaltung, in der nach der ersten DM nichts
  mehr kam, liest er gar nicht, jede andere einmal. Zwischen zwei Anfragen
  an Meta liegen mindestens 5 Sekunden, damit es nicht wie am 21.11. zu
  viele auf einmal werden.
- Ein verlorener Tipp ist eine Nachricht der Person, deren Text genau die
  Beschriftung eines Buttons der Kampagne ist (der ersten DM oder der Bitte,
  dir zu folgen) und die nach ihrer ersten DM kam. So zeigt Instagram einen
  Tipp in der Unterhaltung an.
- Für jeden solchen Tipp macht OpenReply weiter, als wäre er gleich
  angekommen: Folge-Check, Link und was danach kommt wie gewohnt, mit dem
  Tipp als Beginn von Instagrams 24 Stunden. Die ältesten Tipps zuerst, dann
  etwa einer alle 2,5 Minuten. Den Link bekommt dabei niemand doppelt: Hat
  die Person inzwischen noch einmal getippt oder den Link schon bekommen,
  schickt OpenReply nichts.
- Instagram erlaubt eine Antwort nur bis 24 Stunden nach dem Tipp. Bleibt
  davon keine Stunde mehr, schickt OpenReply nichts, sondern nennt dir die
  Person. Ebenso, wenn du die Kampagne inzwischen pausiert hast.
- Während einer Meta-Pause liest der Worker nichts. Meldet Meta schon 60 %
  eines Limits, wartet er 15 Minuten. Nach einem Neustart macht er dort
  weiter, wo er war. Nach 24 Stunden hört er mit dem auf, was er hat.

Ist die Suche fertig, bekommen alle Inhaber und Admins die Entwarnung
„Instagram gibt wieder Button-Tipps an OpenReply weiter“: wie lange die
Störung dauerte, bei wie vielen verlorenen Tipps es jetzt weitergeht, bei
wem es zu spät war (Name, Kampagne, Uhrzeit des Tipps; schreib diesen Leuten
am besten selbst in Instagram), wie viele die erste DM bekommen, aber nicht
getippt haben, und bei wem OpenReply nicht nachsehen konnte. Die *Diagnose*
zeigt dasselbe sieben Tage lang; solange die Suche läuft, steht dort
„OpenReply sucht gerade nach Button-Tipps, die in dieser Zeit verloren
gegangen sind …“.

## Zugangsdaten

Nie in dieses Repository. Alle Werte stehen in einem Ordner außerhalb des Repos:

```bash
node deploy/make-env.mjs <ordner>
```

- `<ordner>/meine-zugangsdaten.env` füllst du aus (Vorlage beim ersten Lauf).
- `<ordner>/.intern.env` enthält die app-internen Schlüssel. **Nie löschen oder
  neu erzeugen:** Ein neuer `ENCRYPTION_KEY` macht alle verbundenen
  Instagram-Konten unbrauchbar. Zusätzlich im Passwort-Manager sichern.
- `vercel.env` kommt in Vercel unter Settings → Environment Variables,
  `worker.env` per `deploy/oracle/upload-env.sh` auf den Server.
- `vercel.env` enthält `DEFAULT_LOCALE=de`: Dashboard und Anmeldung sind auf
  Deutsch, bis jemand im Sprachmenü eine andere Sprache wählt. Fehlt die
  Variable in Vercel (Projekt von vor dieser Änderung), bleibt die Oberfläche
  englisch: ergänzen und neu deployen.

## Kartenbilder hochladen (Vercel Blob)

Das Bild auf der Karte eines Angebots lädst du im Angebots-Editor hoch. Es
liegt in Vercel Blob und ist öffentlich lesbar, weil Instagram es selbst
abruft.

- Einmalig in Vercel im Projekt unter *Storage* einen Blob-Store anlegen
  (Region möglichst Frankfurt) und mit dem Projekt verbinden, mindestens für
  *Production*. Vercel setzt dabei `BLOB_READ_WRITE_TOKEN` selbst. Die
  Variable gehört weder in `vercel.env` noch auf den Worker-Server: Der Worker
  schickt Instagram nur die öffentliche Adresse des Bilds. Danach neu
  deployen, damit die App die Variable sieht.
- Ohne die Variable zeigt der Editor wie bisher ein Feld für einen Link auf
  das Bild, und das Hochladen antwortet mit `503`.
- Erlaubt sind JPG, PNG und WebP bis 5 MB, am besten quadratisch mit
  1080 × 1080 Pixeln. Vercel nimmt pro Anfrage höchstens 4,5 MB an und lehnt
  größere Dateien ab, auch wenn sie unter 5 MB liegen.
- Die Dateien liegen unter `offers/<Workspace-ID>/`. Ersetzt oder entfernst
  du ein Bild und speicherst das Angebot, löscht die App die alte Datei,
  ebenso beim Löschen eines Angebots, das noch niemand bekommen hat.
  Archivierte Angebote behalten ihr Bild, weil verschickte Karten es weiter
  zeigen. Hochgeladene, aber nie gespeicherte Bilder bleiben liegen; die
  kannst du bei Bedarf in Vercel unter *Storage* löschen.

## Angebote: direkt nach dem Link oder 22 Stunden später

Im Kampagnen-Editor unter *Nach dem Link* legst du bei „Wann soll das Angebot
starten?“ pro Kampagne fest, wann das Lead-Magnet-Angebot kommt:

- **Direkt nach dem Link** (Standard, wie bisher): Die Angebotsnachrichten
  folgen Sekunden nach dem Link. Wer nicht tippt, bekommt die Erinnerung.
- **22 Stunden später** (wie in der Anleitung „Automation 2“): Das Angebot
  startet 22 Stunden nach dem Tippen oder der DM, die zum Link geführt hat,
  abgerundet auf die volle oder halbe Stunde, damit die Datenbank seltener
  aufwacht. Instagrams 24-Stunden-Fenster ist dann noch offen. Es gibt keine
  Erinnerung: Wer nicht tippt, bekommt danach nichts mehr.
- Schon geplante späte Starts behalten ihre Zeit, auch wenn du die Kampagne
  zurück auf „Direkt nach dem Link“ stellst. Schaltest du bei der Kampagne
  die Angebote aus oder löschst du die Kampagne, startet keins der geplanten
  Angebote mehr. Eine pausierte Kampagne startet sie trotzdem, denn die Links
  sind schon raus. Ein inzwischen gelöschter Kontakt bekommt nichts, und der
  späte Start legt ihn nicht neu an. Schreibt oder tippt die Person danach
  wieder, entsteht ein neuer Kontakt; der bekommt das Angebot aus der alten
  Unterhaltung nicht. Ist das Fenster zum Start doch zu (etwa weil der
  Worker stundenlang aus war), steht in *Diagnostics*
  „Offer skipped: messaging window closed“.
- Eine Folgenachricht der Kampagne kommt bei „22 Stunden später“ vor dem
  Angebot, solange sie höchstens 1260 Minuten (21 Stunden) nach dem Link
  geplant ist. Erst darüber kann sie zwischen die Angebotsnachrichten fallen,
  und nur dann warnt der Editor davor.
- Die späten Starts warten als verzögerte Jobs in Redis (einige hundert Bytes
  pro Person). Erst wenn auch der Worker aktualisiert ist (siehe *Updates*),
  starten Angebote 22 Stunden später, vorher weiter direkt.
- Über die API und MCP heißt das Feld `offerDelayHours`, mit `0` oder `22`
  (siehe `docs/integrations.md`).

## Eintragungen von der Landingpage zurückmelden

Trägt sich jemand nach einem Klick auf die Karte eines Angebots auf deiner
Landingpage ein (etwa für den Newsletter mit Double-Opt-in), kann die
Landingpage das an dieses Tool zurückmelden. Die Person bekommt dann den Tag
„<Angebot> eingetragen“ und, solange Instagram es erlaubt, deine Bestätigung im
Chat, zum Beispiel „Danke fürs Eintragen! Ich habe dir gerade alles per E-Mail
geschickt 📩“. Im Funnel auf der Seite *Angebote* zählt die Stufe
„Eingetragen“ mit, im Verlauf des Kontakts steht die Eintragung.

So richtest du es ein:

1. Im Angebots-Editor unter *Eintragung zurückmelden* den Schalter
   einschalten. Ab dann hängt das Tool beim Klick auf den Link der Karte oder
   der Erinnerung einen persönlichen Code an die Adresse deiner Landingpage:
   `https://deine-seite.de/guide?utm_source=instagram&ig=AbCd…` (24 Zeichen,
   nur Buchstaben, Ziffern, `-` und `_`). Die übrige Adresse bleibt, wie sie
   ist; ein `ig`, das schon drinsteht, wird ersetzt. Der Code entsteht beim
   ersten Klick der Person und bleibt danach gleich. Ohne den Schalter geht
   der Link genau so raus wie eingetragen.
2. Unter *API & MCP* einen Schlüssel mit dem Zugriff „Eintragungen melden“
   anlegen. Er kann nur Eintragungen melden, keine Kampagnen lesen oder
   anlegen, und gilt bis zu 365 Tage (so ist er voreingestellt; zur Wahl
   stehen 90, 180 und 365 Tage). Schlüssel für Kampagnen gelten weiter
   höchstens 90 Tage. Mit einem abgelaufenen Schlüssel kommt `401`, die
   Seite selbst merkt davon nichts. Deshalb zeigen *API & MCP* und *Diagnose*
   ab 14 Tagen vor dem Ablauf einen Hinweis mit Name und Datum des
   Schlüssels, und nach dem Ablauf weiter, solange er in den letzten 30
   Tagen noch benutzt wurde. Der Hinweis erscheint nur, wenn du eine der
   beiden Seiten öffnest; eine E-Mail gibt es nicht. Dann einen neuen
   Schlüssel anlegen, auf der Landingpage austauschen und den alten
   widerrufen; ein widerrufener Schlüssel warnt nicht mehr. Mitglieder ohne
   Admin-Rechte sehen den Hinweis in der *Diagnose* auch. Weil sie keine
   Schlüssel anlegen können, bittet er sie, den Inhaber oder einen Admin zu
   fragen, und zeigt keinen Link zu *API & MCP*.
3. Die Landingpage übernimmt `ig` aus ihrer Adresse in ein verstecktes
   Formularfeld, speichert den Wert zusammen mit der noch unbestätigten
   Eintragung und meldet ihn erst, wenn die Eintragung bestätigt ist (beim
   Double-Opt-in nach dem Klick in der Bestätigungsmail). Gemeldet wird vom
   Server aus, nie per JavaScript im Browser: Dort wäre der Schlüssel
   öffentlich, und Anfragen aus einer fremden Seite lehnt das Tool ab.

Die Meldung ist genau diese Anfrage:

```bash
curl -X POST https://<domain>/api/offers/signup \
  --max-time 3 \
  -H "Authorization: Bearer <schlüssel>" \
  -H "Content-Type: application/json" \
  -d '{"token": "<wert von ig>"}'
```

Antworten:

- `200 {"data":{"alreadyRecorded":false}}`: Eintragung gespeichert, Tag
  gesetzt, die Bestätigung im Chat ist unterwegs (wenn das Angebot eine hat).
- `200 {"data":{"alreadyRecorded":true}}`: Dieser Code wurde schon gemeldet,
  es passiert nichts mehr. Mehrfach melden schadet also nicht.
- `404 {"error":"Unknown token"}`: Code unbekannt, etwa aus einem anderen
  Workspace, bei einem Angebot mit ausgeschalteter Rückmeldung oder von einem
  gelöschten Kontakt.
- `400`: Body nicht genau `{"token": "…"}` mit einem gültigen Code. `401`:
  Schlüssel fehlt, ist falsch, widerrufen oder abgelaufen. `403`: Schlüssel
  ohne „Eintragungen melden“ oder Anfrage aus einem Browser auf einer anderen
  Seite. `415`: ohne `Content-Type: application/json`. `429`: mehr als 120
  Meldungen pro Minute mit einem Schlüssel. `503`: Ratenbegrenzung (Redis)
  nicht erreichbar.

Die Antwort kommt sofort; die Nachricht im Chat schickt der Worker kurz
danach. Sie geht nur raus, solange Instagrams 24-Stunden-Fenster offen ist,
gerechnet ab dem letzten Tippen oder der letzten DM der Person. Wer sich
später einträgt (etwa weil die Bestätigungsmail erst am nächsten Tag
angeklickt wird), bekommt nur den Tag. Die Nachricht geht höchstens einmal
raus und zählt zu den DMs des Monats. Warum eine nicht rausging, steht unter
*Diagnose* („Sign-up confirmation not sent: …“). Lässt du das Textfeld im
Editor leer, gibt es nur den Tag.

PHP, Schritt für Schritt. Der Schlüssel steht in einer Datei außerhalb des
Web-Roots, nie im Code der Seite und nie im Git:

```php
<?php
// /home/kunde/openreply-config.php (außerhalb des Web-Roots)
return [
    'url' => 'https://<domain>/api/offers/signup',
    'key' => 'orp_…', // Schlüssel mit „Eintragungen melden“
];
```

```php
<?php
// Formular der Landingpage: den Code aus der Adresse übernehmen.
$ig = (isset($_GET['ig']) && preg_match('/^[A-Za-z0-9_-]{1,64}$/', $_GET['ig'])) ? $_GET['ig'] : '';
?>
<form method="post" action="/eintragen.php">
  <input type="email" name="email" required>
  <input type="hidden" name="ig" value="<?= htmlspecialchars($ig, ENT_QUOTES) ?>">
  <button type="submit">Eintragen</button>
</form>
```

In `eintragen.php` speicherst du `$_POST['ig']` (geprüft wie oben) zusammen
mit der E-Mail-Adresse und dem Bestätigungs-Code der noch offenen Eintragung.
Nach dem Klick in der Bestätigungsmail rufst du diese Funktion mit dem
gespeicherten Wert auf und kannst ihn danach löschen:

```php
<?php
const OPENREPLY_CONFIG = '/home/kunde/openreply-config.php';

// Meldet eine bestätigte Eintragung. Wartet höchstens 3 Sekunden und
// ignoriert jeden Fehler: Die Seite darf daran nie scheitern.
function openreply_eintragung_melden(string $ig): void
{
    try {
        if (!preg_match('/^[A-Za-z0-9_-]{1,64}$/', $ig) || !function_exists('curl_init')
            || !is_readable(OPENREPLY_CONFIG)) {
            return;
        }
        $config = require OPENREPLY_CONFIG;
        if (!is_array($config) || empty($config['url']) || empty($config['key'])) {
            return;
        }
        $ch = curl_init($config['url']);
        curl_setopt_array($ch, [
            CURLOPT_POST => true,
            CURLOPT_HTTPHEADER => [
                'Authorization: Bearer ' . $config['key'],
                'Content-Type: application/json',
            ],
            CURLOPT_POSTFIELDS => json_encode(['token' => $ig]),
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_CONNECTTIMEOUT => 3,
            CURLOPT_TIMEOUT => 3,
        ]);
        curl_exec($ch); // Antwort bewusst nicht ausgewertet
    } catch (\Throwable $e) {
        // ignorieren
    }
}
```

Datenschutz: In die Datenschutzerklärung der Landingpage gehört, dass die
Eintragung mit dem Instagram-Kontakt verknüpft wird. Der Link aus der
Instagram-Nachricht trägt einen persönlichen Code, und die Seite meldet nach
der Bestätigung an dieses Tool, dass sich die Person eingetragen hat (nur den
Code, keine E-Mail-Adresse). Löschst du einen Kontakt (*Kontakte* → *Kontakt
löschen*), verschwindet sein Code mit ihm; eine spätere Meldung bekommt
`404`. Die Adresse mit `ig=` landet auch in den Logs und der Webanalyse der
Landingpage; wer das nicht will, entfernt den Parameter dort nach dem
Übernehmen.

Bestehende Angebote haben die Rückmeldung aus. Ihr Tag für die Eintragung
heißt nach dem Update „<Name> eingetragen“ (bei einem Angebot, dessen Tag
„angeboten“ auf Englisch „<Name> offered“ heißt: „<Name> signed up“) und
lässt sich im Editor unter *Tags* ändern. Bestätigungen im Chat schickt erst
der aktualisierte Worker (siehe *Updates*); ein älterer verwirft sie, Tag und
Funnel zählen trotzdem. Deshalb die Rückmeldung erst einschalten, wenn auch
der Worker aktualisiert ist.

## Worker-Server einrichten

```bash
# auf dem Server, einmalig
bash setup-worker.sh https://github.com/<konto>/openreply.git main
# auf dem Mac: Einstellungen hochladen und Worker starten
bash deploy/oracle/upload-env.sh <server-ip> <ordner>/worker.env
```

## Updates

1. Änderung nach `main` pushen. Vercel baut neu und führt dabei die
   Datenbank-Migrationen aus.
2. Erst danach auf dem Server: `bash ~/openreply/deploy/oracle/update-worker.sh`

Neuerungen des Originalprojekts holen: `git fetch upstream && git merge upstream/main`,
dann testen (`npm run typecheck && npm test`) und wie oben ausrollen.

## Prüfen, ob alles läuft

- Server: `pm2 status` und `pm2 logs openreply-worker` (erwartet: `[DM Worker] Started`)
- Gesamtzustand: `GET /api/health` mit `Authorization: Bearer <CRON_SECRET>`.
  Ohne Schlüssel kommt absichtlich `401`. Eine unterbrochene
  Instagram-Verbindung steht unter `checks.instagram` (siehe *Verbindung
  verloren*).
- Dashboard: Seite *Diagnostics* und *DM Logs*.
