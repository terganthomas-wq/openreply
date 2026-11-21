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
    const keys = [
      "When should the offer start?",
      "Right after the link",
      "{hours} hours later",
      "Instagram only allows messages up to 24 hours after the person's last tap or DM. At {hours} hours that window is still open. There is no reminder in this mode.",
      "Only for campaigns that start the offer right after the link. Campaigns that start it {hours} hours later send no reminder.",
    ] as const;
    for (const catalog of [zhTW, ptBR, ru, de]) {
      for (const key of keys) expect(catalog[key], key).toBeTruthy();
    }
    const { t } = createI18n("de");
    expect(t("When should the offer start?")).toBe("Wann soll das Angebot starten?");
    expect(t("Right after the link")).toBe("Direkt nach dem Link");
    expect(t("{hours} hours later", { hours: 22 })).toBe("22 Stunden später");
    expect(createI18n("en").t("{hours} hours later", { hours: 22 })).toBe("22 hours later");
  });

  // G2: the offer editor's sign-up feedback, the funnel stage, the contact
  // history and the sign-up key on the API & MCP page.
  it("names the sign-up feedback in every language", () => {
    const keys = [
      "Report the sign-up back",
      "Report sign-ups from the landing page",
      "For a landing page with a sign-up form, for example for your newsletter. The link on the card and in the reminder then gets a personal code (ig=…). Your landing page sends it back as soon as the person has signed up. They then get the tag and, if Instagram still allows it, your message in the chat.",
      "Address for your landing page",
      "Your landing page also needs a key with the access “{access}”.",
      "Create the key under API & MCP",
      "A key runs out after 90 days at the latest. Create a new one in time and replace it on your landing page.",
      "Details for whoever builds your landing page",
      "Copy the value of ig from the address of the landing page into a hidden form field and store it with the sign-up. Once the sign-up is confirmed (with double opt-in: after the click in the confirmation email), your server sends it:",
      "Wait at most 3 seconds for the answer and ignore errors, so the page never breaks. The key stays on the server, never in the page itself.",
      "Message in the chat after the sign-up",
      "Leave it empty to only tag the person.",
      "Instagram allows the message only up to 24 hours after the person's last tap or DM. Whoever signs up later only gets the tag.",
      "Tag after the sign-up: {tag}",
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
    }
    const { t } = createI18n("de");
    expect(t("Report the sign-up back")).toBe("Eintragung zurückmelden");
    expect(t("Report sign-ups")).toBe("Eintragungen melden");
    expect(t("Signed up")).toBe("Eingetragen");
    expect(t("Your landing page also needs a key with the access “{access}”.", { access: t("Report sign-ups") })).toBe(
      "Deine Landingpage braucht dafür einen Schlüssel mit dem Zugriff „Eintragungen melden“."
    );
    expect(t("Tag after the sign-up: {tag}", { tag: "Guide eingetragen" })).toBe(
      "Tag nach der Eintragung: Guide eingetragen"
    );
    expect(createI18n("en").t("Signed up on the landing page: {offer}", { offer: "Guide" })).toBe(
      "Signed up on the landing page: Guide"
    );
  });
});
