"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

// Public helper - call this from any button (footer, settings page, etc.) to
// open the analytics preferences panel. Matomo runs cookieless by default in
// this harness (see MatomoAnalytics.tsx), so there is no mandatory pre-consent
// banner - but RGPD/CNIL still requires an easy, always-available way to
// opt out of even anonymous, cookieless audience measurement. This is it.
export function openAnalyticsPreferences() {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event("analytics-preferences-open"));
  }
}

function isOptedOut() {
  return typeof window !== "undefined" && localStorage.getItem("matomo-optout") === "true";
}

export function AnalyticsOptOut() {
  const [visible, setVisible] = useState(false);
  const [optedOut, setOptedOut] = useState(false);

  useEffect(() => {
    setOptedOut(isOptedOut());
    const open = () => setVisible(true);
    window.addEventListener("analytics-preferences-open", open);
    return () => window.removeEventListener("analytics-preferences-open", open);
  }, []);

  function toggle() {
    const next = !optedOut;
    localStorage.setItem("matomo-optout", next ? "true" : "false");
    setOptedOut(next);
    // Lets MatomoAnalytics react without a full reload for anything tracked
    // after this point (the tracker script itself, once loaded, is not
    // torn down - only future pageviews are skipped).
    window.dispatchEvent(new Event("analytics-optout-change"));
  }

  if (!visible) return null;

  return (
    <div className="fixed bottom-4 left-4 z-50 max-w-sm rounded-xl border border-white/10 bg-black/90 px-4 py-3 shadow-lg backdrop-blur-sm">
      <p className="text-xs text-white/60">
        Ce site utilise une mesure d&apos;audience anonyme et sans cookies. Aucune donnée
        personnelle n&apos;est collectée ni partagée.{" "}
        <Link href="/politique-de-confidentialite" className="underline hover:text-white">
          En savoir plus
        </Link>
      </p>
      <div className="mt-2 flex items-center justify-between gap-2">
        <button
          onClick={toggle}
          className="cursor-pointer rounded-md border border-white/20 px-3 py-1 text-xs text-white/60 transition hover:bg-white/10"
        >
          {optedOut ? "Réactiver le suivi anonyme" : "Désactiver le suivi anonyme"}
        </button>
        <button
          onClick={() => setVisible(false)}
          className="cursor-pointer rounded-md bg-white px-3 py-1 text-xs font-medium text-black transition hover:bg-white/90"
        >
          Fermer
        </button>
      </div>
    </div>
  );
}
