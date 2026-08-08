// Goes to: apps/web/src/app/admin/agents/[name]/trigger-form.tsx
//
// Client island for triggering an agent run on-demand. Submits via the tRPC
// mutation; the agent's Scaleway Serverless Job picks it up on its next
// scheduled tick (a few minutes, not seconds - see entry.ts and router.ts).
//
// Used in agent-detail.tsx.

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "~/trpc/react";
import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";
import { toast } from "sonner";

export function TriggerForm({ agentName }: { agentName: string }) {
  const router = useRouter();
  const [prompt, setPrompt] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const triggerMutation = api.agentDashboard.triggerManual.useMutation();

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!prompt.trim()) return;
    setSubmitting(true);
    try {
      const result = await triggerMutation.mutateAsync({ agentName, prompt });
      toast.success(
        `Demande envoyée, l’agent va la prendre en charge d’ici quelques minutes (id ${result.triggerId.slice(0, 8)})`,
      );
      setPrompt("");
      // Refresh the invocations list after a couple of minutes (giving the
      // Job time to wake up on its next tick and finish the run for short ones).
      setTimeout(() => router.refresh(), 120_000);
    } catch (e) {
      toast.error(`Échec : ${e instanceof Error ? e.message : "erreur inconnue"}`);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-2">
      <Textarea
        placeholder="Que doit faire l’agent ?"
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        rows={2}
        disabled={submitting}
        className="resize-none text-sm"
      />
      <Button type="submit" disabled={submitting || !prompt.trim()} size="sm" className="w-full cursor-pointer">
        {submitting ? "Envoi..." : "Lancer maintenant"}
      </Button>
    </form>
  );
}
