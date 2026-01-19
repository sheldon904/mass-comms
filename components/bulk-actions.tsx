"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, CheckCircle, Send } from "lucide-react";
import { Button } from "@/components/ui/button";

interface Email {
  id: string;
  status: string;
}

interface BulkActionsProps {
  emails: Email[];
  action: "approve" | "send";
}

export function BulkActions({ emails, action }: BulkActionsProps) {
  const [isLoading, setIsLoading] = useState(false);
  const router = useRouter();

  const handleBulkApprove = async () => {
    if (!confirm(`Approve all ${emails.length} draft emails?`)) return;

    setIsLoading(true);
    try {
      for (const email of emails) {
        await fetch(`/api/emails/${email.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: "approved" }),
        });
      }
      router.refresh();
    } catch (error) {
      console.error("Error in bulk approve:", error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleBulkSend = async () => {
    if (!confirm(`Send all ${emails.length} approved emails?`)) return;

    setIsLoading(true);
    try {
      const response = await fetch("/api/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ emailIds: emails.map((e) => e.id) }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || "Failed to send");
      }

      const result = await response.json();
      alert(
        `Sent ${result.summary.sent} emails successfully. ${
          result.summary.failed > 0
            ? `${result.summary.failed} failed.`
            : ""
        }`
      );
      router.refresh();
    } catch (error) {
      console.error("Error in bulk send:", error);
      alert(error instanceof Error ? error.message : "Failed to send emails");
    } finally {
      setIsLoading(false);
    }
  };

  if (emails.length === 0) return null;

  return (
    <div className="flex items-center justify-between p-4 bg-muted rounded-lg">
      <span className="text-sm text-muted-foreground">
        {emails.length} email{emails.length !== 1 ? "s" : ""} in queue
      </span>
      {action === "approve" ? (
        <Button onClick={handleBulkApprove} disabled={isLoading}>
          {isLoading ? (
            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
          ) : (
            <CheckCircle className="h-4 w-4 mr-2" />
          )}
          Approve All
        </Button>
      ) : (
        <Button onClick={handleBulkSend} disabled={isLoading}>
          {isLoading ? (
            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
          ) : (
            <Send className="h-4 w-4 mr-2" />
          )}
          Send All
        </Button>
      )}
    </div>
  );
}
