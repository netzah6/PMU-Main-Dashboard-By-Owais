import { Suspense } from "react";
import { EsignDesk } from "@/components/agreement/EsignDesk";

export default function EsignPage() {
  return (
    <Suspense fallback={null}>
      <EsignDesk />
    </Suspense>
  );
}
