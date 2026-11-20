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

Unter Standardzugriff kommen laut Erfahrungsberichten Kommentar-Webhooks an,
`messages`/`messaging_postbacks` aber oft nicht. Kampagnen deshalb mit dem Link
direkt in der ersten DM bauen (ohne Button davor, ohne Follow-Gate).

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
