"use client";

import { useParams } from "next/navigation";
import OfferEditor from "@/components/offer-editor";

export default function EditOfferPage() {
  const params = useParams<{ id: string }>();
  // Keyed by the id, so moving between two offers' editors starts afresh.
  return <OfferEditor key={params.id} mode="edit" offerId={params.id} />;
}
