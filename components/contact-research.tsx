"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  Loader2,
  Search,
  UserPlus,
  Sparkles,
  CheckCircle,
  AlertCircle,
  Mail,
  Clock,
} from "lucide-react";
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
  verified: boolean;
}

interface ResearchStages {
  documentParsing: { found: number; emails: string[] };
  verification: { verified: number; failed: number };
  aiAnalysis?: { used: boolean; reason: string };
}

interface ContactResearchProps {
  companyId: string;
  companyName: string;
}

export function ContactResearch({ companyId, companyName }: ContactResearchProps) {
  const [isResearching, setIsResearching] = useState(false);
  const [results, setResults] = useState<DiscoveredContact[] | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const [stages, setStages] = useState<ResearchStages | null>(null);
  const [timing, setTiming] = useState<{ researchMs: number; totalMs: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [addingContact, setAddingContact] = useState<string | null>(null);
  const router = useRouter();

  const handleResearch = async () => {
    setIsResearching(true);
    setError(null);
    setResults(null);
    setSummary(null);
    setStages(null);
    setTiming(null);

    try {
      const response = await fetch("/api/research-contacts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyId }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Research failed");
      }

      setResults(data.contacts || []);
      setSummary(data.summary);
      setStages(data.stages);
      setTiming(data.timing);
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

  const handleAddAll = async () => {
    if (!results || results.length === 0) return;

    setAddingContact("all");

    try {
      for (const contact of results) {
        await fetch("/api/contacts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: contact.name,
            email: contact.email,
            role: contact.role,
            companyId,
          }),
        });
      }

      setResults([]);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add contacts");
    } finally {
      setAddingContact(null);
    }
  };

  const getConfidenceColor = (confidence: string) => {
    switch (confidence) {
      case "high":
        return "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200";
      case "medium":
        return "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200";
      case "low":
        return "bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200";
      default:
        return "bg-gray-100 text-gray-800";
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
          Discover key contacts at {companyName}
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
              Analyzing document...
            </>
          ) : (
            <>
              <Search className="h-4 w-4 mr-2" />
              Research Contacts
            </>
          )}
        </Button>

        {error && (
          <div className="flex items-start gap-2 text-sm text-destructive bg-destructive/10 p-3 rounded-md">
            <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {/* Research Stages Summary */}
        {stages && (
          <div className="space-y-2 text-sm">
            <div className="flex items-center gap-2 text-muted-foreground">
              <Mail className="h-4 w-4" />
              <span>
                {stages.documentParsing.found} email(s) found in document
              </span>
            </div>
            <div className="flex items-center gap-2 text-muted-foreground">
              <CheckCircle className="h-4 w-4" />
              <span>
                {stages.verification.verified} verified, {stages.verification.failed} unverified
              </span>
            </div>
            {stages.aiAnalysis?.used && (
              <div className="flex items-center gap-2 text-muted-foreground">
                <Sparkles className="h-4 w-4" />
                <span>AI analysis used: {stages.aiAnalysis.reason}</span>
              </div>
            )}
            {timing && (
              <div className="flex items-center gap-2 text-muted-foreground">
                <Clock className="h-4 w-4" />
                <span>Completed in {(timing.totalMs / 1000).toFixed(1)}s</span>
              </div>
            )}
          </div>
        )}

        {summary && !stages && (
          <div className="text-sm text-muted-foreground bg-muted p-3 rounded-md">
            {summary}
          </div>
        )}

        {results && results.length > 0 && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h4 className="text-sm font-medium">
                Discovered Contacts ({results.length})
              </h4>
              <Button
                size="sm"
                variant="outline"
                onClick={handleAddAll}
                disabled={addingContact === "all"}
              >
                {addingContact === "all" ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <>
                    <UserPlus className="h-4 w-4 mr-1" />
                    Add All
                  </>
                )}
              </Button>
            </div>

            {results.map((contact) => (
              <div
                key={contact.email}
                className="flex items-start justify-between p-3 border rounded-lg gap-3"
              >
                <div className="space-y-1 min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium truncate">{contact.name}</span>
                    <Badge
                      variant="outline"
                      className={getConfidenceColor(contact.confidence)}
                    >
                      {contact.confidence}
                    </Badge>
                    {contact.verified && (
                      <Badge variant="outline" className="bg-green-50 text-green-700 dark:bg-green-900 dark:text-green-200">
                        <CheckCircle className="h-3 w-3 mr-1" />
                        Verified
                      </Badge>
                    )}
                  </div>
                  <p className="text-sm text-muted-foreground">{contact.role}</p>
                  <p className="text-xs text-muted-foreground truncate">
                    {contact.email}
                  </p>
                  <p className="text-xs text-muted-foreground/70">
                    Source: {contact.source}
                  </p>
                </div>
                <Button
                  size="sm"
                  onClick={() => handleAddContact(contact)}
                  disabled={addingContact === contact.email || addingContact === "all"}
                  className="flex-shrink-0"
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

        {results && results.length === 0 && !error && (
          <div className="text-sm text-muted-foreground text-center py-4 bg-muted rounded-md">
            <p>No contacts discovered in the research document.</p>
            <p className="text-xs mt-1">
              Try adding email addresses directly to the research content.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
