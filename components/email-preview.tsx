"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  Loader2,
  Check,
  X,
  Send,
  Pencil,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { cn } from "@/lib/utils";

interface Email {
  id: string;
  subject: string;
  body: string;
  status: string;
  purpose: string | null;
  contact: {
    name: string;
    email: string;
    role: string | null;
  };
  company: {
    name: string;
  };
}

interface EmailPreviewProps {
  email: Email;
}

export function EmailPreview({ email }: EmailPreviewProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [editedSubject, setEditedSubject] = useState(email.subject);
  const [editedBody, setEditedBody] = useState(email.body);
  const router = useRouter();

  const handleSave = async () => {
    setIsLoading(true);
    try {
      const response = await fetch(`/api/emails/${email.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subject: editedSubject,
          body: editedBody,
        }),
      });

      if (!response.ok) throw new Error("Failed to save");
      setIsEditing(false);
      router.refresh();
    } catch (error) {
      console.error("Error saving email:", error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleApprove = async () => {
    setIsLoading(true);
    try {
      const response = await fetch(`/api/emails/${email.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "approved" }),
      });

      if (!response.ok) throw new Error("Failed to approve");
      router.refresh();
    } catch (error) {
      console.error("Error approving email:", error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleReject = async () => {
    if (!confirm("Are you sure you want to delete this draft?")) return;

    setIsLoading(true);
    try {
      const response = await fetch(`/api/emails/${email.id}`, {
        method: "DELETE",
      });

      if (!response.ok) throw new Error("Failed to delete");
      router.refresh();
    } catch (error) {
      console.error("Error deleting email:", error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleSend = async () => {
    if (!confirm(`Send email to ${email.contact.email}?`)) return;

    setIsLoading(true);
    try {
      const response = await fetch("/api/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ emailIds: [email.id] }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || "Failed to send");
      }
      router.refresh();
    } catch (error) {
      console.error("Error sending email:", error);
      alert(error instanceof Error ? error.message : "Failed to send email");
    } finally {
      setIsLoading(false);
    }
  };

  const statusBadgeVariant = {
    draft: "warning" as const,
    approved: "secondary" as const,
    sent: "success" as const,
    failed: "destructive" as const,
  };

  return (
    <Card className={cn(email.status === "sent" && "opacity-75")}>
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <CardTitle className="text-base">{email.contact.name}</CardTitle>
              <Badge variant={statusBadgeVariant[email.status as keyof typeof statusBadgeVariant] || "outline"}>
                {email.status}
              </Badge>
            </div>
            <CardDescription>
              {email.contact.email}
              {email.contact.role && ` • ${email.contact.role}`}
              {" • "}
              {email.company.name}
            </CardDescription>
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setIsExpanded(!isExpanded)}
          >
            {isExpanded ? (
              <ChevronUp className="h-4 w-4" />
            ) : (
              <ChevronDown className="h-4 w-4" />
            )}
          </Button>
        </div>
      </CardHeader>

      <CardContent>
        {isEditing ? (
          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium">Subject</label>
              <Input
                value={editedSubject}
                onChange={(e) => setEditedSubject(e.target.value)}
              />
            </div>
            <div>
              <label className="text-sm font-medium">Body</label>
              <Textarea
                value={editedBody}
                onChange={(e) => setEditedBody(e.target.value)}
                rows={10}
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                onClick={() => {
                  setIsEditing(false);
                  setEditedSubject(email.subject);
                  setEditedBody(email.body);
                }}
              >
                Cancel
              </Button>
              <Button onClick={handleSave} disabled={isLoading}>
                {isLoading && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                Save Changes
              </Button>
            </div>
          </div>
        ) : (
          <>
            <div className="space-y-2">
              <p className="text-sm">
                <span className="font-medium">Subject:</span> {email.subject}
              </p>
              {isExpanded && (
                <div className="mt-4 p-4 bg-muted rounded-lg">
                  <p className="text-sm whitespace-pre-wrap">{email.body}</p>
                </div>
              )}
            </div>

            {email.status !== "sent" && (
              <div className="mt-4 flex items-center gap-2">
                {email.status === "draft" && (
                  <>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setIsEditing(true)}
                    >
                      <Pencil className="h-4 w-4 mr-1" />
                      Edit
                    </Button>
                    <Button
                      size="sm"
                      onClick={handleApprove}
                      disabled={isLoading}
                    >
                      {isLoading ? (
                        <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                      ) : (
                        <Check className="h-4 w-4 mr-1" />
                      )}
                      Approve
                    </Button>
                    <Button
                      size="sm"
                      variant="destructive"
                      onClick={handleReject}
                      disabled={isLoading}
                    >
                      <X className="h-4 w-4 mr-1" />
                      Reject
                    </Button>
                  </>
                )}
                {email.status === "approved" && (
                  <Button size="sm" onClick={handleSend} disabled={isLoading}>
                    {isLoading ? (
                      <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                    ) : (
                      <Send className="h-4 w-4 mr-1" />
                    )}
                    Send Now
                  </Button>
                )}
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
