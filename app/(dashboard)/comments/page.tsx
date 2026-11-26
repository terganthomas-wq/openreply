import CommentsView from "@/components/comments-view";

/**
 * Kommentare: the recent comments and "DM senden" for a campaign's DM by
 * hand (M1, components/comments-view.tsx). Owners and admins only; the API
 * refuses everyone else and the page says so.
 */
export default function CommentsPage() {
  return <CommentsView />;
}
