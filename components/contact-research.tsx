"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Search, UserPlus, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

interface DiscoveredContact {
  name: string;
  email: string;
  role: string;
  confidence: "high" | "medium" | "low";
  source: string;
}

interface ContactResearchProps {
  companyId: string;
  companyName: string;
}

export function ContactResearch({ companyId, companyName }: ContactResearchProps) {
  const [isResearching, setIsResearching] = useState(false);
  const [results, setResults] = useState<DiscoveredContact[] | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [addingContact, setAddingContact] = useState<string | null>(null);
  const router = useRouter();

  const handleResearch = async () => {
    setIsResearching(true);
    setError(null);
    setResults(null);
    setSummary(null);

    try {
      const response = await fetch("/api/research-contacts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyId }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || "Research failed");
      }

      const data = await response.json();
      setResults(data.discoveredContacts || []);
      setSummary(data.summary);
    } catch (err) {
      setError(err instanceof Error ? err.message : "An error occurred");
    } finally {
      setIsResearching(false);
    }
  };

  const handleAddContact = async (contact: DiscoveredContact) => {
    setAddingContact(contact.email);

    try {
      const response = await fetch("/api/contacts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: contact.name,
          email: contact.email,
          role: contact.role,
          companyId,
        }),
      });

      if (!response.ok) {
        throw new Error("Failed to add contact");
      }

      // Remove added contact from results
      setResults((prev) =>
        prev ? prev.filter((c) => c.email !== contact.email) : null
      );
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add contact");
    } finally {
      setAddingContact(null);
    }
  };

  const getConfidenceBadgeVariant = (confidence: string) => {
    switch (confidence) {
      case "high":
        return "success";
      case "medium":
        return "warning";
      case "low":
        return "secondary";
      default:
        return "secondary";
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Sparkles className="h-5 w-5 text-muted-foreground" />
          <CardTitle>AI Contact Research</CardTitle>
        </div>
        <CardDescription>
          Use AI to discover key contacts at {companyName}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Button
          onClick={handleResearch}
          disabled={isResearching}
          className="w-full"
          variant="outline"
        >
          {isResearching ? (
            <>
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              Researching contacts...
            </>
          ) : (
            <>
              <Search className="h-4 w-4 mr-2" />
              Research Key Contacts
            </>
          )}
        </Button>

        {error && (
          <div className="text-sm text-destructive bg-destructive/10 p-3 rounded-md">
            {error}
          </div>
        )}

        {summary && (
          <div className="text-sm text-muted-foreground bg-muted p-3 rounded-md">
            {summary}
          </div>
        )}

        {results && results.length > 0 && (
          <div className="space-y-3">
            <h4 className="text-sm font-medium">Discovered Contacts</h4>
            {results.map((contact) => (
              <div
                key={contact.email}
                className="flex items-center justify-between p-3 border rounded-lg"
              >
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{contact.name}</span>
                    <Badge variant={getConfidenceBadgeVariant(contact.confidence) as "success" | "warning" | "secondary"}>
                      {contact.confidence}
                    </Badge>
                  </div>
                  <p className="text-sm text-muted-foreground">{contact.role}</p>
                  <p className="text-xs text-muted-foreground">{contact.email}</p>
                </div>
                <Button
                  size="sm"
                  onClick={() => handleAddContact(contact)}
                  disabled={addingContact === contact.email}
                >
                  {addingContact === contact.email ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <>
                      <UserPlus className="h-4 w-4 mr-1" />
                      Add
                    </>
                  )}
                </Button>
              </div>
            ))}
          </div>
        )}

        {results && results.length === 0 && (
          <div className="text-sm text-muted-foreground text-center py-4">
            No additional contacts discovered. Try adding contacts manually.
          </div>
        )}
      </CardContent>
    </Card>
  );
}
