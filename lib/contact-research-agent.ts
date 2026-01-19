import Anthropic from "@anthropic-ai/sdk";
import dns from "dns";
import { promisify } from "util";

const resolveMx = promisify(dns.resolveMx);

// ============================================================================
// TYPES
// ============================================================================

export interface DiscoveredContact {
  name: string;
  email: string;
  role: string;
  confidence: "high" | "medium" | "low";
  source: string;
  verified: boolean;
}

export interface ResearchResult {
  contacts: DiscoveredContact[];
  summary: string;
  stages: {
    documentParsing: { found: number; emails: string[] };
    verification: { verified: number; failed: number };
    aiAnalysis?: { used: boolean; reason: string };
  };
  durationMs: number;
}

interface ExtractedPerson {
  name: string;
  role: string;
  email?: string;
}

// ============================================================================
// STAGE 1: DOCUMENT PARSING (No API calls - pure regex/parsing)
// ============================================================================

/**
 * Extract all email addresses from text
 */
function extractEmails(text: string): string[] {
  const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/gi;
  const matches = text.match(emailRegex);
  return matches ? Array.from(new Set(matches.map((e) => e.toLowerCase()))) : [];
}

/**
 * Extract company domain from text (URLs or email addresses)
 */
function extractDomain(text: string, companyName: string): string | null {
  // Try to find domain from URLs
  const urlRegex = /(?:https?:\/\/)?(?:www\.)?([a-zA-Z0-9-]+\.[a-zA-Z]{2,})(?:\/|$)/gi;
  const urlMatches = Array.from(text.matchAll(urlRegex));

  // Try to find domain from email addresses
  const emailRegex = /@([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/gi;
  const emailMatches = Array.from(text.matchAll(emailRegex));

  const domains = new Set<string>();

  for (const match of urlMatches) {
    const domain = match[1].toLowerCase();
    // Filter out common non-company domains
    if (!isCommonDomain(domain)) {
      domains.add(domain);
    }
  }

  for (const match of emailMatches) {
    const domain = match[1].toLowerCase();
    if (!isCommonDomain(domain)) {
      domains.add(domain);
    }
  }

  // Try to match company name to domain
  const normalizedCompany = companyName.toLowerCase().replace(/[^a-z0-9]/g, "");
  const domainArray = Array.from(domains);
  for (const domain of domainArray) {
    if (domain.includes(normalizedCompany) || normalizedCompany.includes(domain.split(".")[0])) {
      return domain;
    }
  }

  // Return first non-common domain found
  return domainArray.length > 0 ? domainArray[0] : null;
}

function isCommonDomain(domain: string): boolean {
  const common = [
    "gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "aol.com",
    "icloud.com", "mail.com", "protonmail.com", "linkedin.com", "twitter.com",
    "facebook.com", "github.com", "google.com", "microsoft.com", "apple.com",
    "wikipedia.org", "medium.com", "substack.com"
  ];
  return common.includes(domain.toLowerCase());
}

/**
 * Extract people with roles from text
 */
function extractPeopleWithRoles(text: string): ExtractedPerson[] {
  const people: ExtractedPerson[] = [];
  const seenNames = new Set<string>();

  // Pattern: "Name, Title" or "Name - Title" or "Title: Name"
  const patterns = [
    // "John Smith, CEO" or "John Smith - CEO"
    /([A-Z][a-z]+ [A-Z][a-z]+(?:\s[A-Z][a-z]+)?)[,\s-]+(?:the\s+)?(CEO|CTO|CFO|COO|CMO|CIO|CISO|CPO|CRO|VP|Vice President|Director|Head|Manager|President|Founder|Co-Founder|Partner|Chief\s+\w+\s+Officer)(?:\s+of\s+[\w\s]+)?/gi,
    // "CEO John Smith" or "CEO: John Smith"
    /(CEO|CTO|CFO|COO|CMO|CIO|CISO|CPO|CRO|VP|Vice President|Director|Head|Manager|President|Founder|Co-Founder|Partner|Chief\s+\w+\s+Officer)[:\s]+([A-Z][a-z]+ [A-Z][a-z]+(?:\s[A-Z][a-z]+)?)/gi,
    // "led by John Smith"
    /(?:led by|headed by|run by|founded by|started by)\s+([A-Z][a-z]+ [A-Z][a-z]+)/gi,
  ];

  for (const pattern of patterns) {
    const matches = Array.from(text.matchAll(pattern));
    for (const match of matches) {
      let name: string;
      let role: string;

      if (match[1].match(/^[A-Z][a-z]/)) {
        // Name is first
        name = match[1].trim();
        role = match[2]?.trim() || "Executive";
      } else {
        // Role is first
        role = match[1].trim();
        name = match[2]?.trim() || "";
      }

      if (name && !seenNames.has(name.toLowerCase())) {
        seenNames.add(name.toLowerCase());
        people.push({ name, role: normalizeRole(role) });
      }
    }
  }

  return people;
}

function normalizeRole(role: string): string {
  const roleMap: Record<string, string> = {
    "ceo": "CEO",
    "cto": "CTO",
    "cfo": "CFO",
    "coo": "COO",
    "cmo": "CMO",
    "cio": "CIO",
    "ciso": "CISO",
    "cpo": "CPO",
    "cro": "CRO",
    "vp": "VP",
    "vice president": "VP",
    "director": "Director",
    "head": "Head",
    "manager": "Manager",
    "president": "President",
    "founder": "Founder",
    "co-founder": "Co-Founder",
    "partner": "Partner",
  };

  const lower = role.toLowerCase();
  for (const [key, value] of Object.entries(roleMap)) {
    if (lower.includes(key)) {
      return value;
    }
  }
  return role;
}

/**
 * Generate possible email patterns for a person
 */
function generateEmailPatterns(name: string, domain: string): string[] {
  const parts = name.trim().split(/\s+/);
  if (parts.length < 2) {
    return [`${parts[0].toLowerCase()}@${domain}`];
  }

  const firstName = parts[0].toLowerCase();
  const lastName = parts[parts.length - 1].toLowerCase();
  const firstInitial = firstName[0];
  const lastInitial = lastName[0];

  return [
    `${firstName}.${lastName}@${domain}`,
    `${firstName}${lastName}@${domain}`,
    `${firstInitial}${lastName}@${domain}`,
    `${firstName}_${lastName}@${domain}`,
    `${firstName}@${domain}`,
    `${lastName}.${firstName}@${domain}`,
    `${firstInitial}.${lastName}@${domain}`,
  ];
}

// ============================================================================
// STAGE 2: EMAIL VERIFICATION (DNS MX lookup - free & fast)
// ============================================================================

const mxCache = new Map<string, boolean>();

/**
 * Verify if a domain has valid MX records (can receive email)
 */
async function verifyEmailDomain(email: string): Promise<boolean> {
  const domain = email.split("@")[1];
  if (!domain) return false;

  // Check cache
  if (mxCache.has(domain)) {
    return mxCache.get(domain)!;
  }

  try {
    const records = await resolveMx(domain);
    const hasValidMx = records && records.length > 0;
    mxCache.set(domain, hasValidMx);
    return hasValidMx;
  } catch {
    mxCache.set(domain, false);
    return false;
  }
}

/**
 * Verify multiple emails in parallel with timeout
 */
async function verifyEmails(emails: string[], timeoutMs: number = 5000): Promise<Map<string, boolean>> {
  const results = new Map<string, boolean>();

  const verifyWithTimeout = async (email: string): Promise<[string, boolean]> => {
    try {
      const result = await Promise.race([
        verifyEmailDomain(email),
        new Promise<boolean>((_, reject) =>
          setTimeout(() => reject(new Error("timeout")), timeoutMs)
        ),
      ]);
      return [email, result];
    } catch {
      return [email, false];
    }
  };

  const verifications = await Promise.all(emails.map(verifyWithTimeout));
  for (const [email, verified] of verifications) {
    results.set(email, verified);
  }

  return results;
}

// ============================================================================
// STAGE 3: AI ANALYSIS (Only if needed - single focused call)
// ============================================================================

async function aiAnalyzeForContacts(
  companyName: string,
  research: string,
  existingEmails: string[]
): Promise<DiscoveredContact[]> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return [];
  }

  const anthropic = new Anthropic({ apiKey });

  const prompt = `Analyze this company research and identify key contacts to reach out to.

Company: ${companyName}

Research Document:
${research.substring(0, 4000)} ${research.length > 4000 ? "..." : ""}

Already found emails: ${existingEmails.join(", ") || "None"}

Based on this research, identify up to 5 key people who would be good contacts for B2B outreach. For each person, provide:
1. Their full name (if mentioned)
2. Their role/title
3. Their likely email (generate based on company domain if not explicitly stated)

Respond in this exact JSON format only, no other text:
{
  "contacts": [
    {"name": "Full Name", "role": "Title", "email": "email@domain.com", "confidence": "high|medium|low"}
  ],
  "domain": "company.com"
}`;

  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      messages: [{ role: "user", content: prompt }],
    });

    const content = response.content[0];
    if (content.type !== "text") {
      return [];
    }

    // Extract JSON from response
    const jsonMatch = content.text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return [];
    }

    const parsed = JSON.parse(jsonMatch[0]);
    return (parsed.contacts || []).map((c: { name: string; role: string; email: string; confidence?: string }) => ({
      name: c.name,
      email: c.email,
      role: c.role,
      confidence: (c.confidence as "high" | "medium" | "low") || "medium",
      source: "AI Analysis",
      verified: false,
    }));
  } catch (error) {
    console.error("AI analysis error:", error);
    return [];
  }
}

// ============================================================================
// MAIN RESEARCH FUNCTION
// ============================================================================

export interface ContactResearchParams {
  companyName: string;
  companyResearch: string;
  companyDomain?: string;
}

export async function researchContacts(
  params: ContactResearchParams
): Promise<ResearchResult> {
  const startTime = Date.now();
  const { companyName, companyResearch } = params;

  const contacts: DiscoveredContact[] = [];
  const stages: ResearchResult["stages"] = {
    documentParsing: { found: 0, emails: [] },
    verification: { verified: 0, failed: 0 },
  };

  // -------------------------------------------------------------------------
  // STAGE 1: Document Parsing (fast, no API calls)
  // -------------------------------------------------------------------------

  // Extract emails directly from document
  const documentEmails = extractEmails(companyResearch);
  stages.documentParsing.emails = documentEmails;
  stages.documentParsing.found = documentEmails.length;

  // Extract domain
  const domain = params.companyDomain || extractDomain(companyResearch, companyName);

  // Extract people with roles
  const people = extractPeopleWithRoles(companyResearch);

  // For people without emails, generate possible patterns
  const emailsToVerify = new Set(documentEmails);

  if (domain) {
    for (const person of people) {
      // Check if we already have their email
      const hasEmail = documentEmails.some(
        (e) => e.toLowerCase().includes(person.name.split(" ")[0].toLowerCase())
      );

      if (!hasEmail) {
        // Generate most likely email pattern (just first.last@domain)
        const patterns = generateEmailPatterns(person.name, domain);
        if (patterns.length > 0) {
          emailsToVerify.add(patterns[0]); // Most common pattern
          person.email = patterns[0];
        }
      } else {
        // Find their existing email
        person.email = documentEmails.find(
          (e) => e.toLowerCase().includes(person.name.split(" ")[0].toLowerCase())
        );
      }
    }
  }

  // -------------------------------------------------------------------------
  // STAGE 2: Email Verification (DNS MX lookup)
  // -------------------------------------------------------------------------

  const allEmails = Array.from(emailsToVerify);
  const verificationResults = await verifyEmails(allEmails, 3000);

  for (const [email, verified] of Array.from(verificationResults.entries())) {
    if (verified) {
      stages.verification.verified++;
    } else {
      stages.verification.failed++;
    }
  }

  // Add verified emails from document as contacts
  for (const email of documentEmails) {
    const verified = verificationResults.get(email) ?? false;
    const matchingPerson = people.find(
      (p) => p.email?.toLowerCase() === email.toLowerCase()
    );

    contacts.push({
      name: matchingPerson?.name || extractNameFromEmail(email),
      email,
      role: matchingPerson?.role || "Contact",
      confidence: verified ? "high" : "medium",
      source: "Research Document",
      verified,
    });
  }

  // Add people with generated emails
  for (const person of people) {
    if (person.email && !documentEmails.includes(person.email.toLowerCase())) {
      const verified = verificationResults.get(person.email) ?? false;
      contacts.push({
        name: person.name,
        email: person.email,
        role: person.role,
        confidence: verified ? "medium" : "low",
        source: "Generated Pattern",
        verified,
      });
    }
  }

  // -------------------------------------------------------------------------
  // STAGE 3: AI Analysis (only if we found nothing)
  // -------------------------------------------------------------------------

  if (contacts.length === 0 && process.env.ANTHROPIC_API_KEY) {
    stages.aiAnalysis = { used: true, reason: "No contacts found in document" };

    const aiContacts = await aiAnalyzeForContacts(
      companyName,
      companyResearch,
      documentEmails
    );

    // Verify AI-suggested emails
    const aiEmails = aiContacts.map((c) => c.email).filter(Boolean);
    const aiVerification = await verifyEmails(aiEmails, 3000);

    for (const contact of aiContacts) {
      contact.verified = aiVerification.get(contact.email) ?? false;
      if (contact.verified) {
        contact.confidence = "medium";
      }
      contacts.push(contact);
    }
  } else {
    stages.aiAnalysis = { used: false, reason: "Contacts found in document" };
  }

  // -------------------------------------------------------------------------
  // Build summary
  // -------------------------------------------------------------------------

  const durationMs = Date.now() - startTime;
  const verifiedCount = contacts.filter((c) => c.verified).length;

  let summary = `Found ${contacts.length} contact(s) for ${companyName}. `;
  summary += `${stages.documentParsing.found} email(s) extracted from document. `;
  summary += `${verifiedCount} verified via MX lookup. `;
  if (stages.aiAnalysis?.used) {
    summary += `AI analysis was used to identify additional contacts.`;
  }

  return {
    contacts: contacts.slice(0, 10), // Limit to 10 contacts
    summary,
    stages,
    durationMs,
  };
}

/**
 * Try to extract a name from an email address
 */
function extractNameFromEmail(email: string): string {
  const localPart = email.split("@")[0];

  // Handle common patterns
  const patterns = [
    /^([a-z]+)\.([a-z]+)$/i,     // first.last
    /^([a-z]+)_([a-z]+)$/i,      // first_last
    /^([a-z])[a-z]*([a-z]+)$/i,  // flast or firstlast
  ];

  for (const pattern of patterns) {
    const match = localPart.match(pattern);
    if (match) {
      const firstName = match[1].charAt(0).toUpperCase() + match[1].slice(1);
      const lastName = match[2].charAt(0).toUpperCase() + match[2].slice(1);
      return `${firstName} ${lastName}`;
    }
  }

  // Fallback: capitalize the local part
  return localPart.charAt(0).toUpperCase() + localPart.slice(1);
}
