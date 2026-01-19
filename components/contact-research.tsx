"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import {
  Loader2,
  Search,
  UserPlus,
  Sparkles,
  CheckCircle,
  AlertCircle,
  Clock,
  Globe,
  Phone,
  Mail,
  Timer,
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
  phone: string | null;
  role: string;
  confidence: "high" | "medium" | "low";
  source: string;
  verified: boolean;
}

interface ResearchStages {
  pagesVisited: string[];
  contactsFound: number;
  emailsVerified: number;
  phonesFound: number;
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
  const [elapsedTime, setElapsedTime] = useState(0);
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const router = useRouter();

  // Timer effect for progress indicator
  useEffect(() => {
    if (isResearching) {
      setElapsedTime(0);
      timerRef.current = setInterval(() => {
        setElapsedTime((prev) => prev + 1);
      }, 1000);
    } else {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    }

    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
      }
    };
  }, [isResearching]);

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
          phone: contact.phone,
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
            phone: contact.phone,
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
              Researching website...
            </>
          ) : (
            <>
              <Search className="h-4 w-4 mr-2" />
              Research Contacts
            </>
          )}
        </Button>

        {/* Progress indicator during research */}
        {isResearching && (
          <div className="space-y-3 border rounded-lg p-4 bg-muted/30">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-sm font-medium">
                <Timer className="h-4 w-4 text-blue-500 animate-pulse" />
                <span>Research in progress...</span>
              </div>
              <div className="text-sm font-mono text-muted-foreground">
                {elapsedTime}s
              </div>
            </div>

            {/* Progress bar */}
            <div className="w-full h-2 bg-muted rounded-full overflow-hidden">
              <div
                className="h-full bg-blue-500 transition-all duration-1000 ease-out"
                style={{
                  width: `${Math.min((elapsedTime / 50) * 100, 95)}%`,
                }}
              />
            </div>

            <div className="text-xs text-muted-foreground space-y-1">
              <p>
                {elapsedTime < 5 && "Connecting to company website..."}
                {elapsedTime >= 5 && elapsedTime < 12 && "Browsing pages for contacts..."}
                {elapsedTime >= 12 && elapsedTime < 20 && "Detecting email patterns..."}
                {elapsedTime >= 20 && elapsedTime < 30 && "Applying patterns to executives..."}
                {elapsedTime >= 30 && elapsedTime < 40 && "Verifying emails via OSINT..."}
                {elapsedTime >= 40 && "Finalizing results..."}
              </p>
              <p className="text-muted-foreground/60">
                This typically takes 20-45 seconds
              </p>
            </div>
          </div>
        )}

        {error && (
          <div className="flex items-start gap-2 text-sm text-destructive bg-destructive/10 p-3 rounded-md">
            <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {/* Research Stages Summary */}
        {stages && (
          <div className="space-y-3 text-sm border rounded-lg p-3 bg-muted/50">
            <div className="font-medium text-xs uppercase text-muted-foreground">
              Research Summary
            </div>

            <div className="flex items-center gap-2 text-muted-foreground">
              <Globe className="h-4 w-4 text-blue-500" />
              <span>Browsed {stages.pagesVisited.length} page(s)</span>
            </div>

            <div className="flex items-center gap-2 text-muted-foreground">
              <Mail className="h-4 w-4 text-purple-500" />
              <span>
                Found {stages.contactsFound} contact(s), {stages.emailsVerified} verified
              </span>
            </div>

            {stages.phonesFound > 0 && (
              <div className="flex items-center gap-2 text-muted-foreground">
                <Phone className="h-4 w-4 text-green-500" />
                <span>{stages.phonesFound} phone number(s) found</span>
              </div>
            )}

            {timing && (
              <div className="flex items-center gap-2 text-muted-foreground">
                <Clock className="h-4 w-4" />
                <span>Completed in {(timing.totalMs / 1000).toFixed(1)}s</span>
              </div>
            )}

            {stages.pagesVisited.length > 0 && (
              <div className="mt-2 pt-2 border-t">
                <div className="text-xs text-muted-foreground mb-1">Pages visited:</div>
                <div className="space-y-1">
                  {stages.pagesVisited.slice(0, 5).map((url, i) => (
                    <div key={i} className="text-xs text-muted-foreground/70 truncate">
                      • {url}
                    </div>
                  ))}
                  {stages.pagesVisited.length > 5 && (
                    <div className="text-xs text-muted-foreground/50">
                      ...and {stages.pagesVisited.length - 5} more
                    </div>
                  )}
                </div>
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
                  <div className="flex items-center gap-1 text-xs text-muted-foreground">
                    <Mail className="h-3 w-3" />
                    <span className="truncate">{contact.email}</span>
                  </div>
                  {contact.phone && (
                    <div className="flex items-center gap-1 text-xs text-muted-foreground">
                      <Phone className="h-3 w-3" />
                      <span>{contact.phone}</span>
                    </div>
                  )}
                  <p className="text-xs text-muted-foreground/70 truncate">
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
            <p>No contacts discovered on the company website.</p>
            <p className="text-xs mt-1">
              The website may not have publicly listed contact information.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
