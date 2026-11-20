import { cache } from "react";
import { cookies } from "next/headers";
import { createI18n, isLocale, LOCALE_COOKIE, resolveLocale } from "./index";

// A language the person chose in the switcher always wins. Without one, the
// installation's DEFAULT_LOCALE applies; an unset or unsupported value falls
// back to English. Read after cookies(), so it is evaluated per request.
export const getI18n = cache(async () => {
  const cookieStore = await cookies();
  const saved = cookieStore.get(LOCALE_COOKIE)?.value;
  return createI18n(
    isLocale(saved) ? saved : resolveLocale(process.env.DEFAULT_LOCALE),
  );
});
