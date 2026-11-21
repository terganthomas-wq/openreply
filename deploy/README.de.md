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
  Leseanfrage bei Meta, egal wie viele Kampagnen es gibt. Auf einem schon
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
- Lehnt Meta die DM zu einem Kommentar (private Antwort, Eröffnungs-DM,
  Folgen-Bitte, Link) oder die Prüfung, ob die Person folgt, mit einem Limit
  ab, pausiert das Tool das Senden für dieses Instagram-Konto: 20 Minuten,
  bei 368 eine Stunde (einstellbar mit `META_THROTTLE_PAUSE_MINUTES` und
  `META_BLOCK_PAUSE_MINUTES`, 1 bis 240 Minuten, in worker.env). Eine
  laufende Pause wird höchstens verlängert, nie verkürzt.
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
- Button-Klicks, Antworten auf DMs, Folgenachrichten und Angebote kennen die
  Pause noch nicht: Bei einem Limit gelten für sie noch die bisherigen
  Wiederholungen nach 5 und 15 Minuten.
- Über Zernio verbundene Konten bleiben, wie sie sind: Zernios eigenes Limit
  (HTTP 429) löst keine Pause aus.

Damit es gar nicht so weit kommt: Bei Tests nicht Dutzende Kommentare in
wenigen Minuten schreiben, und große Abrufe (etwa viele Unterhaltungen auf
einmal) nicht direkt vor einem Test.

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
  sind schon raus. Ein inzwischen gelöschter Kontakt bekommt nichts und wird
  nicht neu angelegt. Ist das Fenster zum Start doch zu (etwa weil der Worker
  stundenlang aus war), steht in *Diagnostics* „Offer skipped: messaging
  window closed“.
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
   anlegen, am besten für 90 Tage. Er kann nur Eintragungen melden, keine
   Kampagnen lesen oder anlegen. Schlüssel laufen spätestens nach 90 Tagen
   ab: rechtzeitig einen neuen anlegen und auf der Landingpage austauschen.
   Mit einem abgelaufenen Schlüssel kommt `401`, die Seite selbst merkt davon
   nichts.
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
  Ohne Schlüssel kommt absichtlich `401`.
- Dashboard: Seite *Diagnostics* und *DM Logs*.
