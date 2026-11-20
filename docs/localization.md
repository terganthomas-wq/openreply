# Interface languages

OpenReply defaults to English. Choose **English**, **繁體中文**, **Português (Brasil)**, **Русский** or **Deutsch** in the dashboard
sidebar, under **Settings → Interface language**, or on the sign-in screen.
The choice is stored in a browser cookie for one year and applies to the
dashboard, sign-in screens, workspace invitations, and shared campaign reports.

An installation can set its own default with the `DEFAULT_LOCALE` environment
variable of the web app (`en`, `de`, `zh-TW`, `pt-BR` or `ru`). It applies to
everyone who has not picked a language in the switcher; a saved choice always
wins. Unset or unsupported values mean English. `deploy/make-env.mjs` sets
`DEFAULT_LOCALE=de` for the German installation.

Changing the interface language does not translate campaign names, keywords,
outgoing messages, button text, imported CSV data, or Instagram content. An
unsaved campaign stays in the editor when switching languages. Default outgoing
message content retains its original values in both languages.

New campaigns open with the workspace's default texts: the opening DM, both
follow requests, the link DM and its button, the public replies and the
question-mark filter. A workspace without them gets the built-in set of the
interface language once, the first time someone opens a new campaign. Only
German has one (generic texts with "du", no brand copy); in the other languages
the editor opens blank until an owner or admin uses **Save these texts as
defaults for new campaigns**. From then on the texts belong to the workspace
and stay as they are when anyone changes the interface language; **Reset to
built-in defaults** brings back the built-in set of the current language. They
are stored in `Workspace.messageDefaults` (`lib/campaigns/message-defaults.ts`)
and are never translation keys.

Public marketing, template playbooks, legal pages, authentication emails, and
raw API/provider error details remain in English. Those are outside this
interface translation's scope.

## Adding or changing copy

- `lib/i18n/zh-TW.json` maps English source copy to Traditional Chinese and
  `lib/i18n/pt-BR.json` to Brazilian Portuguese, `lib/i18n/ru.json` to Russian,
  `lib/i18n/de.json` to German (informal "du"). All catalogs must carry exactly
  the same keys; a missing key fails the typecheck. Use complete sentences with
  named placeholders when word order can vary.
- Client components use `useI18n()`; server components use `await getI18n()`.
  `t("Hello, {name}!", { name })` checks both the message key and required
  placeholders at compile time. Never pass user content as a translation key.
- `label(value)` translates known status, role, and weekday display labels.
  Unknown values pass through; stored values and API filters stay unchanged.
- Format dates and numbers with the selected `locale`. Translate input hints,
  not values already entered by the user.
- Remove unused catalog entries when removing UI copy. The catalog tests check
  that translations retain their interpolation fields and contain plain text.

## Rendering and persistence

The locale cookie is validated on the server; missing or unsupported values
fall back to a valid `DEFAULT_LOCALE`, then to English. The variable is read
on the server for each request, not baked into the build. A server action
saves the cookie and re-renders the current route without remounting the
editor. The action sets a same-site, HTTP-only cookie, with the secure flag in
production. There is no translation dependency, new database column, or change
to the sending worker.

Providers live in the localized route layouts, below the root layout. This
keeps the public marketing and template pages statically rendered. Localized
content has a server-rendered `lang` attribute; the provider also updates the
document language while mounted and restores it when leaving these routes.

## Validation

Run the contribution checks in `CONTRIBUTING.md`. The locale unit tests cover
preference validation, persistence, the `DEFAULT_LOCALE` and English fallbacks,
interpolation, and status labels. For browser verification:

1. Start with no locale cookie: sign-in should display English, or the
   `DEFAULT_LOCALE` language when it is set.
2. Switch to Traditional Chinese (and again to Brazilian Portuguese), reload, and navigate to another localized
   route: the selected language, labels, and dates should remain consistent.
3. In the campaign editor, change a message and toggle an option without saving.
   Switch languages: both draft values and the selected post should remain.
4. Switch back to English, including on a narrow viewport using the sidebar.
5. Visit a public marketing page: it should remain English.
