"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";

interface Contact {
  id: string;
  name: string;
  email: string;
  role: string | null;
}

interface DraftFormProps {
  companyId: string;
  companyName: string;
  contacts: Contact[];
}

export function DraftForm({ companyId, companyName, contacts }: DraftFormProps) {
  const [purpose, setPurpose] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [progress, setProgress] = useState<string[]>([]);
  const router = useRouter();

  const handleGenerateDrafts = async () => {
    if (!purpose.trim()) return;

    setIsGenerating(true);
    setProgress([]);

    try {
      for (const contact of contacts) {
        setProgress((prev) => [
          ...prev,
          `Drafting email for ${contact.name}...`,
        ]);

        const response = await fetch("/api/draft", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            companyId,
            contactId: contact.id,
            purpose,
          }),
        });

        if (!response.ok) {
          const error = await response.json();
          setProgress((prev) => [
            ...prev,
            `Failed: ${contact.name} - ${error.error}`,
          ]);
        } else {
          setProgress((prev) => [...prev, `Done: ${contact.name}`]);
        }
      }

      setProgress((prev) => [...prev, "All drafts generated!"]);

      // Navigate to emails page after a short delay
      setTimeout(() => {
        router.push("/emails");
      }, 1500);
    } catch (error) {
      setProgress((prev) => [...prev, "Error generating drafts"]);
    } finally {
      setIsGenerating(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Label htmlFor="purpose">Email Purpose / Intent</Label>
        <Textarea
          id="purpose"
          value={purpose}
          onChange={(e) => setPurpose(e.target.value)}
          placeholder={`What's the goal of this outreach to ${companyName}?

Examples:
- Introduce our AI consulting services and schedule a discovery call
- Follow up on our meeting at the conference last week
- Propose a partnership opportunity around their new product launch`}
          rows={6}
          disabled={isGenerating}
        />
        <p className="text-xs text-muted-foreground">
          Be specific about what you want to achieve. This helps Claude write
          more relevant, personalized emails.
        </p>
      </div>

      <div className="bg-muted rounded-lg p-4">
        <h3 className="font-medium mb-2">
          Drafting emails for {contacts.length} contact
          {contacts.length !== 1 ? "s" : ""}:
        </h3>
        <ul className="text-sm text-muted-foreground space-y-1">
          {contacts.map((contact) => (
            <li key={contact.id}>
              {contact.name} ({contact.email})
              {contact.role && ` - ${contact.role}`}
            </li>
          ))}
        </ul>
      </div>

      {progress.length > 0 && (
        <div className="bg-muted rounded-lg p-4">
          <h3 className="font-medium mb-2">Progress:</h3>
          <ul className="text-sm space-y-1">
            {progress.map((message, index) => (
              <li
                key={index}
                className={
                  message.startsWith("Failed")
                    ? "text-destructive"
                    : message.startsWith("Done") || message.includes("All drafts")
                    ? "text-green-600"
                    : "text-muted-foreground"
                }
              >
                {message}
              </li>
            ))}
          </ul>
        </div>
      )}

      <Button
        onClick={handleGenerateDrafts}
        disabled={!purpose.trim() || isGenerating}
        className="w-full"
      >
        {isGenerating ? (
          <>
            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            Generating Drafts...
          </>
        ) : (
          <>
            <Sparkles className="h-4 w-4 mr-2" />
            Generate Email Drafts
          </>
        )}
      </Button>
    </div>
  );
}
