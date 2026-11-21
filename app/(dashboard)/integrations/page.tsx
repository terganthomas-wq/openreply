"use client";

import { useEffect, useState } from "react";
import KeyExpiryNotice, { ACCESS_LABELS, type KeyNeedingAttention } from "@/components/key-expiry-notice";
import { useI18n } from "@/lib/i18n/provider";
import { KEY_EXPIRY_WARNING_DAYS, keyLifetime, type KeyExpiryWarning } from "@/lib/integrations/key-lifetime";
import { ACCESS_SCOPES, keyAccess, type KeyAccess } from "@/lib/integrations/scopes";
import { SIGNUP_CALLBACK_PATH } from "@/lib/offers/signup-link";

// As the keys route lists them; it tells by its own clock whether a key has
// expired or needs a new one soon.
type Key = { id: string; name: string; scopes: string[]; expiresAt: string; revokedAt: string | null;
  expired: boolean; expiryWarning: KeyExpiryWarning | null };
// The three kinds of key the form creates.
type Access = Exclude<KeyAccess, "createOnly">;

// The lifetimes a kind of key may have: a sign-up key up to a year.
const lifetimeOf = (access: Access) => keyLifetime(ACCESS_SCOPES[access]);

// The keys that need a new one, for the notice above the form.
function needingAttention(keys: Key[]): KeyNeedingAttention[] {
  return keys.flatMap(key => key.expiryWarning ? [{ ...key, warning: key.expiryWarning }] : []);
}

export default function IntegrationsPage() {
  const { t, locale } = useI18n();
  const [keys, setKeys] = useState<Key[]>([]);
  const [name, setName] = useState("");
  const [days, setDays] = useState(lifetimeOf("read").defaultDays);
  const [access, setAccess] = useState<Access>("read");
  const [token, setToken] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  // Each kind starts at its own default lifetime: a year for a sign-up key.
  function selectAccess(next: Access) {
    setAccess(next);
    setDays(lifetimeOf(next).defaultDays);
  }

  async function load() {
    const response = await fetch("/api/integrations/keys");
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    setKeys(data.keys);
  }

  useEffect(() => { void Promise.resolve().then(load).catch(e => setNotice(e.message)); }, []);

  async function create() {
    const question = access === "write"
      ? t("Create a read-and-write workspace key for {days} days? Anyone with this key can read your campaigns and create new ones.", { days })
      : access === "signups"
        ? t("Create a key for {days} days that only reports sign-ups? Your landing page uses it. It cannot read or create campaigns.", { days })
        : t("Create a read-only workspace key for {days} days? Anyone with this key can read your campaigns.", { days });
    if (!window.confirm(question)) return;
    setBusy(true); setToken(""); setNotice("");
    try {
      const response = await fetch("/api/integrations/keys", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, days, scopes: ACCESS_SCOPES[access] }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      setToken(data.token);
      await load();
    } catch (error) { setNotice((error as Error).message); }
    finally { setBusy(false); }
  }

  async function revoke(key: Key) {
    if (!window.confirm(t("Revoke this key? Connected clients will lose access immediately."))) return;
    setBusy(true); setNotice("");
    try {
      const response = await fetch(`/api/integrations/keys?id=${encodeURIComponent(key.id)}`, { method: "DELETE" });
      if (!response.ok) throw new Error((await response.json()).error);
      setToken("");
      await load();
    } catch (error) { setNotice((error as Error).message); }
    finally { setBusy(false); }
  }

  return <div className="mx-auto max-w-4xl space-y-6 p-6">
    <h1 className="text-2xl font-semibold">{t("API & MCP")}</h1>
    <p className="text-muted">{t("Workspace-scoped keys. A read-only key lists and reads campaigns. A read-and-write key can also create campaigns; they start paused unless the request switches them on. No key can change or delete existing campaigns. Only admins and owners can manage keys.")}</p>
    <p className="text-muted">{t("A key that only reports sign-ups is for your landing page: it tells this tool who signed up after clicking an offer's link (offers with “Report the sign-up back”). It can do nothing else.")}</p>
    {notice && <p role="status">{notice}</p>}
    <KeyExpiryNotice keys={needingAttention(keys)} />
    <section className="space-y-3 rounded border border-border p-4">
      <label className="block">{t("Key name")}<input maxLength={100} disabled={busy} className="w-full rounded border border-border p-2" value={name} onChange={e => setName(e.target.value)} /></label>
      <label className="block">{t("Access")}<select disabled={busy} value={access} onChange={e => selectAccess(e.target.value as Access)} className="ml-3 max-w-full rounded border border-border p-2">
        <option value="read">{t(ACCESS_LABELS.read)}</option>
        <option value="write">{t(ACCESS_LABELS.write)}</option>
        <option value="signups">{t(ACCESS_LABELS.signups)}</option>
      </select></label>
      <label className="block">{t("Key lifetime")}<select disabled={busy} value={days} onChange={e => setDays(Number(e.target.value))} className="ml-3 rounded border border-border p-2">
        {lifetimeOf(access).choices.map(value => <option key={value} value={value}>{t("{days} days", { days: value })}</option>)}
      </select></label>
      <p className="text-sm text-muted">{t("Applies only to new keys. Existing expiration dates do not change.")}</p>
      <p className="text-sm text-muted">{t("This page and Diagnostics warn {days} days before a key expires.", { days: KEY_EXPIRY_WARNING_DAYS })}</p>
      <button disabled={busy || !name.trim()} onClick={create} className="rounded bg-accent px-4 py-2 text-white disabled:opacity-50">{t("Create key for {days} days", { days })}</button>
      {token && <div role="status" className="space-y-2">
        <p>{t("Shown once. Store securely; never put keys in URLs, screenshots or GitHub.")}</p>
        <input aria-label={t("New service key")} type="password" readOnly value={token} className="w-full rounded border border-border p-2" />
        <button onClick={() => navigator.clipboard.writeText(token).catch(() => setNotice(t("Could not copy key. Use a secure HTTPS connection.")))}>{t("Copy")}</button>
        <button className="ml-4" onClick={() => setToken("")}>{t("Hide key")}</button>
      </div>}
    </section>
    <section className="space-y-3">{keys.map(key => {
      // Scopes that are no kind (the keys route stores none) show as stored.
      const access = keyAccess(key.scopes);
      const date = new Date(key.expiresAt).toLocaleDateString(locale);
      return <div key={key.id} className={`rounded border p-4 ${key.expiryWarning ? "border-warning/30" : "border-border"}`}>
        <strong className="break-words">{key.name}</strong>
        <p className="text-sm">{access ? t(ACCESS_LABELS[access]) : key.scopes.join(" + ")} · <span className={key.expiryWarning ? "text-warning" : undefined}>
          {key.expired ? t("Expired: {date}", { date }) : t("Expires: {date}", { date })}</span></p>
        {key.revokedAt ? <span>{t("Revoked")}</span> : <button disabled={busy} onClick={() => revoke(key)} className="text-red-500">{t("Revoke key")}</button>}
      </div>;
    })}</section>
    <section className="space-y-2 text-sm">
      <h2 className="font-semibold">{t("Connection")}</h2>
      <p>MCP: <code>/api/mcp</code> · REST: <code>/api/v1/campaigns</code> · {t("Sign-ups")}: <code className="break-all">{SIGNUP_CALLBACK_PATH}</code></p>
      <p>{t("Streamable HTTP with an Authorization: Bearer header. This server does not provide OAuth; use a client that supports custom headers.")}</p>
      <p>{t("Campaign lists are limited to 100. Use get_campaign for complete settings and destination links; clicks are raw requests, not unique recipients.")}</p>
      <p>{t("Read-and-write keys create campaigns by POST to the REST address or with the MCP tool create_campaign. Every field you leave out gets your default texts, as a new campaign in the editor does.")}</p>
    </section>
  </div>;
}
