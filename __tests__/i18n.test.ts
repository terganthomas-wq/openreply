import { describe, expect, it } from "vitest";
import { createI18n, resolveLocale } from "../lib/i18n";
import de from "../lib/i18n/de.json";
import ptBR from "../lib/i18n/pt-BR.json";
import ru from "../lib/i18n/ru.json";
import zhTW from "../lib/i18n/zh-TW.json";

describe("interface translations", () => {
  it("keeps English as the default for absent or unsupported preferences", () => {
    for (const value of [undefined, null, "", "fr", "zh-CN", "../zh-TW", "pt", "pt-PT", "ru-RU", "de-DE", "DE", " de"]) {
      expect(resolveLocale(value)).toBe("en");
    }
    expect(resolveLocale("zh-TW")).toBe("zh-TW");
    expect(resolveLocale("pt-BR")).toBe("pt-BR");
    expect(resolveLocale("ru")).toBe("ru");
    expect(resolveLocale("de")).toBe("de");
  });

  it("renders both interface languages from the same keys", () => {
    expect(createI18n("en").t("Campaigns")).toBe("Campaigns");
    expect(createI18n("zh-TW").t("Campaigns")).toBe("自動回覆活動");
  });

  it("allows sentence order to differ between languages", () => {
    const values = { count: 2 };
    expect(createI18n("en").t("{count} connected accounts", values)).toBe(
      "2 connected accounts",
    );
    expect(createI18n("zh-TW").t("{count} connected accounts", values)).toBe(
      "已連接 2 個帳號",
    );
  });

  it("preserves interpolation values verbatim, including user content and zero", () => {
    const { t } = createI18n("zh-TW");
    expect(t("Hello, {name}!", { name: "{count} <b>Alex</b> $&" })).toBe(
      "你好，{count} <b>Alex</b> $&！",
    );
    expect(t("{count} campaigns", { count: 0 })).toBe("0 個活動");
  });

  it("translates display labels without changing stored codes or unknown values", () => {
    const codes = ["SENT", "OWNER", "active", "CUSTOM_STATUS"];
    expect(codes.map(createI18n("zh-TW").label)).toEqual([
      "已傳送",
      "擁有者",
      "啟用中",
      "CUSTOM_STATUS",
    ]);
    expect(codes).toEqual(["SENT", "OWNER", "active", "CUSTOM_STATUS"]);
    expect(createI18n("zh-TW").label("toString")).toBe("toString");
    expect(createI18n("zh-TW").label("__proto__")).toBe("__proto__");
  });

  it("has complete, plain-text translations with matching interpolation fields", () => {
    const placeholders = (text: string) =>
      [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
    for (const catalog of [zhTW, ptBR, ru, de]) {
      for (const [source, translation] of Object.entries(catalog)) {
        expect(translation.trim(), source).not.toBe("");
        expect(placeholders(translation), source).toEqual(placeholders(source));
        expect(source, source).not.toMatch(/&(?:[a-z]+|#\d+);/i);
        expect(translation, source).not.toMatch(/&(?:[a-z]+|#\d+);/i);
      }
    }
  });

  it("keeps the Brazilian Portuguese catalog on exactly the same keys", () => {
    expect(Object.keys(ptBR).sort()).toEqual(Object.keys(zhTW).sort());
  });

  it("renders Brazilian Portuguese with interpolation and display labels", () => {
    const { t, label } = createI18n("pt-BR");
    expect(t("Campaigns")).toBe("Campanhas");
    expect(t("Settings")).toBe("Configurações");
    expect(t("{count} connected accounts", { count: 2 })).toBe(
      ptBR["{count} connected accounts"].replace("{count}", "2"),
    );
    expect(t("{count} campaigns", { count: 0 })).toBe(
      ptBR["{count} campaigns"].replace("{count}", "0"),
    );
    expect(["SENT", "OWNER", "active", "CUSTOM_STATUS"].map(label)).toEqual([
      ptBR["Sent"],
      ptBR["Owner"],
      ptBR["Active"],
      "CUSTOM_STATUS",
    ]);
  });

  it("keeps the Russian catalog on exactly the same keys", () => {
    expect(Object.keys(ru).sort()).toEqual(Object.keys(zhTW).sort());
  });

  it("renders Russian with interpolation and display labels", () => {
    const { t, label } = createI18n("ru");
    expect(t("Campaigns")).toBe("Кампании");
    expect(t("Settings")).toBe("Настройки");
    expect(t("{count} campaigns", { count: 3 })).toBe("Кампаний: 3");
    expect(["SENT", "OWNER", "active", "CUSTOM_STATUS"].map(label)).toEqual([
      ru["Sent"],
      ru["Owner"],
      ru["Active"],
      "CUSTOM_STATUS",
    ]);
  });

  it("keeps the German catalog on exactly the same keys", () => {
    expect(Object.keys(de).sort()).toEqual(Object.keys(zhTW).sort());
  });

  it("renders German with interpolation and display labels", () => {
    const { t, label } = createI18n("de");
    expect(t("Settings")).toBe("Einstellungen");
    expect(t("Campaigns")).toBe("Kampagnen");
    expect(t("{count} campaigns", { count: 3 })).toBe("3 Kampagnen");
    expect(t("Showing {start}–{end} of {total}", { start: 1, end: 25, total: 80 })).toBe(
      "1–25 von 80",
    );
    expect(t("Hello, {name}!", { name: "{count} <b>Alex</b> $&" })).toBe(
      "Hallo, {count} <b>Alex</b> $&!",
    );
    expect(["SENT", "OWNER", "active", "Mon", "CUSTOM_STATUS"].map(label)).toEqual([
      "Gesendet",
      "Inhaber",
      "Aktiv",
      "Mo",
      "CUSTOM_STATUS",
    ]);
  });

  it("addresses people informally in German", () => {
    // R17: the German interface uses "du". Capitalised Sie/Ihnen/Ihr… would be
    // the formal address.
    for (const [source, translation] of Object.entries(de)) {
      expect(translation, source).not.toMatch(/\b(?:Sie|Ihnen|Ihr|Ihre[mnrs]?)\b/);
    }
  });

  // G1: the campaign editor's choice when the offer starts, the preview's
  // marker and the offer editor's note on the reminder.
  it("names when the offer starts in every language", () => {
    const hint =
      "Instagram only allows messages up to 24 hours after the person's last tap or DM. At {hours} hours that window is still open. With “{hours} hours later” there is no reminder.";
    const keys = [
      "When should the offer start?",
      "Right after the link",
      "{hours} hours later",
      hint,
      "Only for campaigns that start the offer right after the link. Campaigns that start it {hours} hours later send no reminder.",
    ] as const;
    for (const catalog of [zhTW, ptBR, ru, de]) {
      for (const key of keys) expect(catalog[key], key).toBeTruthy();
      // The hint shows under either option, so it names the one without a
      // reminder in the words of its label: "this mode" read as the selected
      // one, by default the one that has a reminder.
      expect(catalog[hint], "hint names the late option").toContain(
        catalog["{hours} hours later"]
      );
      expect(catalog, "old hint").not.toHaveProperty([
        "Instagram only allows messages up to 24 hours after the person's last tap or DM. At {hours} hours that window is still open. There is no reminder in this mode.",
      ]);
    }
    const { t } = createI18n("de");
    expect(t("When should the offer start?")).toBe("Wann soll das Angebot starten?");
    expect(t("Right after the link")).toBe("Direkt nach dem Link");
    expect(t("{hours} hours later", { hours: 22 })).toBe("22 Stunden später");
    expect(t(hint, { hours: 22 })).toBe(
      "Instagram erlaubt Nachrichten nur bis 24 Stunden nach dem letzten Tippen oder der letzten DM der Person. Nach 22 Stunden ist dieses Fenster noch offen. Bei „22 Stunden später“ gibt es keine Erinnerung."
    );
    const en = createI18n("en");
    expect(en.t("{hours} hours later", { hours: 22 })).toBe("22 hours later");
    expect(en.t(hint, { hours: 22 })).toContain("With “22 hours later” there is no reminder.");
  });

  // G2: the offer editor's sign-up feedback, the funnel stage, the contact
  // history and the sign-up key on the API & MCP page.
  it("names the sign-up feedback in every language", () => {
    const keys = [
      "Report the sign-up back",
      "Report sign-ups from the landing page",
      "For a landing page with a sign-up form, for example for your newsletter. The link on the card and in the reminder then gets a personal code (ig=…). Your landing page sends it back as soon as the person has signed up. They then get the tag and, if Instagram still allows it, your message in the chat.",
      "Your landing page reports the sign-up to this address",
      "Your landing page also needs a key with the access “{access}”.",
      "Create the key under API & MCP",
      "A key for your landing page lasts up to {days} days. From {warnDays} days before it expires, API & MCP and Diagnostics show a notice when you open them (there is no e-mail): then create a new key and replace it on your landing page.",
      "Details for whoever builds your landing page",
      "Copy the value of ig from the address of the landing page into a hidden form field and store it with the sign-up. Once the sign-up is confirmed (with double opt-in: after the click in the confirmation email), your server sends it:",
      "Wait at most 3 seconds for the answer and ignore errors, so the page never breaks. The key stays on the server, never in the page itself.",
      "Message in the chat after the sign-up",
      "Leave it empty to only tag the person.",
      "Instagram allows the message only up to 24 hours after the person's last tap or DM. Whoever signs up later only gets the tag.",
      "Tag for everyone who signed up: {tag}",
      "Change the tag",
      "After the sign-up on your landing page",
      "Signed up",
      "Fill in all five tags.",
      "Saves the offer messages with their pauses, the button, the confirmations, the card's button, the reminder and the message after the sign-up. Name, card, link and tags are set per offer.",
      "Signed up on the landing page: {offer}",
      "Sign-up confirmed in the chat: {offer}",
      "Sign-up confirmed in the chat",
      "Report sign-ups",
      "Sign-ups",
      "Create a key for {days} days that only reports sign-ups? Your landing page uses it. It cannot read or create campaigns.",
      "A key that only reports sign-ups is for your landing page: it tells this tool who signed up after clicking an offer's link (offers with “Report the sign-up back”). It can do nothing else.",
    ] as const;
    for (const catalog of [zhTW, ptBR, ru, de]) {
      for (const key of keys) expect(catalog[key], key).toBeTruthy();
      // The four tags of before are five now.
      expect(catalog, "old tag count").not.toHaveProperty(["Fill in all four tags."]);
      // The callback address is this tool's, not the landing page's own:
      // the label says what it is for.
      expect(catalog, "old address label").not.toHaveProperty(["Address for your landing page"]);
      // „Tag nach der Eintragung“ read as "the day after the sign-up".
      expect(catalog, "old tag label").not.toHaveProperty(["Tag after the sign-up: {tag}"]);
      // Sign-up keys live up to a year now.
      expect(catalog, "old key lifetime").not.toHaveProperty([
        "A key runs out after 90 days at the latest. Create a new one in time and replace it on your landing page.",
      ]);
      // „warnen dich“ read as "you will be told"; the notice only shows on
      // the two pages, when someone opens them.
      expect(catalog, "old key warning").not.toHaveProperty([
        "A key for your landing page lasts up to {days} days. API & MCP and Diagnostics warn you {warnDays} days before it expires: then create a new one and replace it on your landing page.",
      ]);
    }
    const { t } = createI18n("de");
    expect(t("Report the sign-up back")).toBe("Eintragung zurückmelden");
    expect(t("Report sign-ups")).toBe("Eintragungen melden");
    expect(t("Signed up")).toBe("Eingetragen");
    expect(t("Your landing page reports the sign-up to this address")).toBe(
      "An diese Adresse meldet deine Landingpage die Eintragung"
    );
    expect(t("Your landing page also needs a key with the access “{access}”.", { access: t("Report sign-ups") })).toBe(
      "Deine Landingpage braucht dafür einen Schlüssel mit dem Zugriff „Eintragungen melden“."
    );
    // Worded like the delivery tag's label, so "Tag" cannot read as "day".
    expect(t("Tag for everyone who signed up: {tag}", { tag: "Guide eingetragen" })).toBe(
      "Tag für alle, die sich eingetragen haben: Guide eingetragen"
    );
    expect(t("Tag for everyone who signed up: {tag}", { tag: "x" })).toMatch(
      new RegExp(`^${t("Tag people who got the link").split(",")[0]},`)
    );
    expect(
      t(
        "A key for your landing page lasts up to {days} days. From {warnDays} days before it expires, API & MCP and Diagnostics show a notice when you open them (there is no e-mail): then create a new key and replace it on your landing page.",
        { days: 365, warnDays: 14 }
      )
    ).toBe(
      "Ein Schlüssel für deine Landingpage gilt bis zu 365 Tage. Ab 14 Tagen vor dem Ablauf zeigen API & MCP und die Diagnose einen Hinweis, sobald du sie öffnest (eine E-Mail gibt es nicht). Dann erstell einen neuen Schlüssel und tausch ihn auf deiner Landingpage aus."
    );
    expect(createI18n("en").t("Signed up on the landing page: {offer}", { offer: "Guide" })).toBe(
      "Signed up on the landing page: Guide"
    );
  });

  // R1: Diagnostics on Meta's request limits, the active pause and the
  // events about it, in the reader's language (the worker stores English).
  it("names Meta's request limits in every language", () => {
    const keys = [
      "Sending paused: Instagram limit reached",
      "Instagram refuses messages for a while when too many requests reach it in a short time. What waits goes out on its own once the pause is over.",
      "@{account}: paused until {time}",
      "Waiting: {count}",
      "Instagram limit reached: sending paused until {time}",
      "Instagram limit reached for @{account}: sending paused until {time}",
      "Instagram requests are at {percent}% of the limit. At 100% Instagram refuses messages.",
      "Instagram requests for @{account} are at {percent}% of the limit. At 100% Instagram refuses messages.",
      "The regular search for missed comments stopped early: Instagram limit reached for @{account}. The next search runs as planned.",
    ] as const;
    for (const catalog of [zhTW, ptBR, ru, de]) {
      for (const key of keys) expect(catalog[key], key).toBeTruthy();
    }
    const { t } = createI18n("de");
    expect(t("Instagram limit reached: sending paused until {time}", { time: "14:05" })).toBe(
      "Instagram-Limit erreicht: Senden pausiert bis 14:05"
    );
    expect(t("Sending paused: Instagram limit reached")).toBe(
      "Senden pausiert: Instagram-Limit erreicht"
    );
    expect(t("@{account}: paused until {time}", { account: "studio", time: "14:05" })).toBe(
      "@studio: pausiert bis 14:05"
    );
    expect(
      t("Instagram requests for @{account} are at {percent}% of the limit. At 100% Instagram refuses messages.", {
        account: "studio",
        percent: 85,
      })
    ).toBe(
      "Die Instagram-Anfragen für @studio liegen bei 85 % des Limits. Bei 100 % lehnt Instagram Nachrichten ab."
    );
  });

  // R1-keys: the lifetime of a key and the warning before and after it
  // expires, on the API & MCP page and in Diagnostics.
  it("names expiring keys in every language", () => {
    const keys = [
      "Keys are expiring",
      "Key “{name}” ({access}) expires on {date}.",
      "Key “{name}” ({access}) expired on {date}, but was used in the last {days} days.",
      "An expired key no longer works: your landing page, for example, can no longer report sign-ups. Create a new key in time, replace the old one wherever it is used, then revoke the old one.",
      "An expired key no longer works: your landing page, for example, can no longer report sign-ups. Ask your workspace owner or an admin to create a new key in time and revoke the old one.",
      "Open API & MCP",
      "Expired: {date}",
      "From {days} days before a key expires, this page and Diagnostics show a notice when you open them (there is no e-mail).",
    ] as const;
    for (const catalog of [zhTW, ptBR, ru, de]) {
      for (const key of keys) expect(catalog[key], key).toBeTruthy();
      expect(catalog, "old page note").not.toHaveProperty([
        "This page and Diagnostics warn {days} days before a key expires.",
      ]);
    }
    const { t } = createI18n("de");
    expect(t("Keys are expiring")).toBe("Schlüssel laufen ab");
    expect(
      t("Key “{name}” ({access}) expires on {date}.", {
        name: "Landingpage",
        access: t("Report sign-ups"),
        date: "5.12.2026",
      })
    ).toBe("Der Schlüssel „Landingpage“ (Eintragungen melden) läuft am 5.12.2026 ab.");
    expect(
      t("Key “{name}” ({access}) expired on {date}, but was used in the last {days} days.", {
        name: "Landingpage",
        access: t("Report sign-ups"),
        date: "5.12.2026",
        days: 30,
      })
    ).toBe(
      "Der Schlüssel „Landingpage“ (Eintragungen melden) ist am 5.12.2026 abgelaufen, wurde in den letzten 30 Tagen aber noch benutzt."
    );
    expect(t("Expired: {date}", { date: "5.12.2026" })).toBe("Abgelaufen am 5.12.2026");
    const note = t(
      "From {days} days before a key expires, this page and Diagnostics show a notice when you open them (there is no e-mail).",
      { days: 14 }
    );
    expect(note).toBe(
      "Ab 14 Tagen vor dem Ablauf eines Schlüssels zeigen diese Seite und die Diagnose einen Hinweis, sobald du sie öffnest (eine E-Mail gibt es nicht)."
    );
    // The page names Diagnostics as the menu does.
    expect(note).toContain(t("Diagnostics"));
    // A member sees the notice in Diagnostics but cannot replace a key.
    expect(
      t(
        "An expired key no longer works: your landing page, for example, can no longer report sign-ups. Ask your workspace owner or an admin to create a new key in time and revoke the old one."
      )
    ).toBe(
      "Ein abgelaufener Schlüssel funktioniert nicht mehr: Deine Landingpage kann dann zum Beispiel keine Eintragungen mehr melden. Bitte den Inhaber oder einen Admin deines Workspaces, rechtzeitig einen neuen Schlüssel zu erstellen und den alten zu widerrufen."
    );
  });

  // Every text that sends the reader to the API & MCP page names it as the
  // menu does, in every language.
  it("names the API & MCP page as its menu item does", () => {
    const naming = [
      "Open API & MCP",
      "Create the key under API & MCP",
      "A key for your landing page lasts up to {days} days. From {warnDays} days before it expires, API & MCP and Diagnostics show a notice when you open them (there is no e-mail): then create a new key and replace it on your landing page.",
    ] as const;
    for (const catalog of [zhTW, ptBR, ru, de]) {
      const menu = (catalog as Record<string, string>)["API & MCP"] ?? "API & MCP";
      for (const key of naming) expect(catalog[key], key).toContain(menu);
      // The hint names Diagnostics as the menu does, too.
      expect(catalog[naming[2]], naming[2]).toContain(catalog["Diagnostics"]);
    }
    expect(createI18n("pt-BR").t("Open API & MCP")).toBe("Abrir API e MCP");
    expect(createI18n("ru").t("Open API & MCP")).toBe("Открыть API и MCP");
    expect(createI18n("zh-TW").t("Open API & MCP")).toBe("開啟 API 與 MCP");
  });

  // G1 leftover: with the offer 22 hours later the follow-up message only
  // meets it when it waits that long, and the warning says so.
  it("words the follow-up warning for a late offer in every language", () => {
    const late =
      "The follow-up message comes {minutes} minutes after the link. The offer may have started by then, so the follow-up can land between the offer messages. With {limit} minutes or less it comes before the offer.";
    for (const catalog of [zhTW, ptBR, ru, de]) {
      expect(catalog[late], late).toBeTruthy();
      expect(
        catalog["The follow-up message also goes out after the link, so it can land between the offer messages."]
      ).toBeTruthy();
    }
    expect(createI18n("de").t(late, { minutes: 1300, limit: 1260 })).toBe(
      "Die Folgenachricht kommt 1300 Minuten nach dem Link. Dann kann das Angebot schon laufen, und sie landet womöglich zwischen den Angebotsnachrichten. Mit höchstens 1260 Minuten kommt sie vor dem Angebot."
    );
  });

  // B8: the follow-up goes out only inside Instagram's 24-hour window, which
  // the worker checks right before sending. Above 23 hours the editor warns,
  // and no text says any more that up to 24 hours work.
  it("warns about follow-up delays above 23 hours in every language", () => {
    const warning =
      "It only goes out if the person wrote to you or tapped a button in the 24 hours before. With more than 23 hours that is usually no longer the case.";
    for (const catalog of [zhTW, ptBR, ru, de]) {
      expect(catalog[warning], warning).toBeTruthy();
      expect(catalog["personalizes."]).toBeTruthy();
      expect(catalog, "old hint").not.toHaveProperty([
        "personalizes it. Max 24 hours, to stay inside Instagram's messaging window.",
      ]);
    }
    expect(createI18n("de").t(warning)).toBe(
      "Geht nur raus, wenn die Person dir in den 24 Stunden davor geschrieben oder getippt hat. Bei mehr als 23 Stunden ist das meistens nicht mehr so."
    );
  });
});
