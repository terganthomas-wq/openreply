import ContactsView from "@/components/contacts-view";

// A repeated parameter counts with its first value.
function firstValue(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? "";
}

/**
 * Contacts. Links can open the list filtered: the Offers page's funnel tiles
 * pass ?tag=, and ?q= starts a search.
 */
export default async function ContactsPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const params = await searchParams;
  const tag = firstValue(params.tag);
  const query = firstValue(params.q);
  // Keyed by them, so following another such link while the list is open
  // starts it afresh instead of keeping the filters typed before.
  return (
    <ContactsView
      key={JSON.stringify([tag, query])}
      initialTag={tag}
      initialQuery={query}
    />
  );
}
