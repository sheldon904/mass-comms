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
    aiExtraction: { found: number; method: string };
    verification: { verified: number; failed: number };
    emailGeneration?: { generated: number };
  };
  durationMs: number;
}

interface ExtractedContact {
  name: string;
  role: string;
  email: string | null;
  confidence: "high" | "medium" | "low";
}

// ============================================================================
// STAGE 1: AI-POWERED CONTACT EXTRACTION (Claude with tool_use)
// ============================================================================

/**
 * Use Claude with tool_use to intelligently extract contacts from document.
 * This guarantees structured output and understands semantic context.
 */
async function extractContactsWithAI(
  companyName: string,
  research: string
): Promise<{ contacts: ExtractedContact[]; domain: string | null }> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.log("No ANTHROPIC_API_KEY - returning empty contacts");
    return { contacts: [], domain: null };
  }

  const anthropic = new Anthropic({ apiKey });

  // Define the extraction tool with strict schema
  const extractionTool: Anthropic.Tool = {
    name: "extract_contacts",
    description: `Extract real people and their contact information from a company research document.

IMPORTANT RULES:
1. Only extract REAL PEOPLE with actual names (First Last format)
2. Do NOT extract job titles or descriptions as names (e.g., "Regional Vice President" is NOT a name)
3. Names must be 2-3 words in typical human name format
4. Only include emails that are EXPLICITLY written in the document
5. If no email is found for a person, set email to null
6. Confidence levels:
   - "high": Person's name AND email explicitly in document
   - "medium": Person's name in document but no email found
   - "low": Person mentioned indirectly or title only

EXAMPLES OF GOOD EXTRACTIONS:
- "John Smith, CEO" → name: "John Smith", role: "CEO"
- "led by Sarah Johnson" → name: "Sarah Johnson", role: "Executive"
- "contact: mike@company.com" → include this email if Mike is mentioned

EXAMPLES OF BAD EXTRACTIONS (DO NOT DO):
- "Multiple Vice Presidents" → NOT a name, skip it
- "Regional Director" → NOT a name, skip it
- "CEO and team" → NOT a name, skip it
- "Mace Hirt as" → Parsing error, should be "Mace Hirt"`,
    input_schema: {
      type: "object" as const,
      properties: {
        contacts: {
          type: "array",
          description: "List of extracted contacts",
          items: {
            type: "object",
            properties: {
              name: {
                type: "string",
                description: "Full name of the person (First Last format, 2-3 words)"
              },
              role: {
                type: "string",
                description: "Job title or role (CEO, VP Sales, Director, etc.)"
              },
              email: {
                type: ["string", "null"],
                description: "Email address if explicitly found in document, otherwise null"
              },
              confidence: {
                type: "string",
                enum: ["high", "medium", "low"],
                description: "Confidence level based on extraction rules"
              }
            },
            required: ["name", "role", "email", "confidence"]
          }
        },
        company_domain: {
          type: ["string", "null"],
          description: "Company's email domain if found (e.g., 'acme.com' from emails or website URLs)"
        }
      },
      required: ["contacts", "company_domain"]
    }
  };

  // Truncate research to avoid token limits while keeping relevant content
  const truncatedResearch = research.length > 6000
    ? research.substring(0, 6000) + "\n...[truncated]"
    : research;

  const prompt = `Analyze this company research document and extract key contacts.

Company: ${companyName}

Research Document:
---
${truncatedResearch}
---

Extract all real people mentioned with their roles and any email addresses found.
Remember: Only extract actual human names (First Last format), not job titles or descriptions.
If you find emails in the document, include them. Otherwise set email to null.
Also extract the company's email domain if visible from any emails or website URLs.`;

  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      tools: [extractionTool],
      tool_choice: { type: "tool", name: "extract_contacts" },
      messages: [{ role: "user", content: prompt }]
    });

    // Extract the tool use result
    const toolUse = response.content.find(
      (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
    );

    if (!toolUse || toolUse.name !== "extract_contacts") {
      console.log("No tool use in response");
      return { contacts: [], domain: null };
    }

    const input = toolUse.input as {
      contacts: ExtractedContact[];
      company_domain: string | null;
    };

    // Validate and filter contacts
    const validContacts = (input.contacts || []).filter(contact => {
      // Must have a name with 2-3 words
      const nameParts = contact.name.trim().split(/\s+/);
      if (nameParts.length < 2 || nameParts.length > 4) {
        console.log(`Filtered out invalid name: "${contact.name}" (wrong word count)`);
        return false;
      }

      // Name parts should look like names (capitalized, reasonable length)
      const looksLikeName = nameParts.every(part =>
        part.length >= 2 &&
        part.length <= 20 &&
        /^[A-Z][a-z]+$/.test(part)
      );

      if (!looksLikeName) {
        console.log(`Filtered out invalid name: "${contact.name}" (doesn't look like a name)`);
        return false;
      }

      // Filter out obvious non-names
      const nonNamePatterns = [
        /^(multiple|several|various|regional|senior|junior|assistant)/i,
        /\b(vice president|director|manager|team|group|department)\b$/i,
        /\b(and|or|the|with)\b/i
      ];

      if (nonNamePatterns.some(pattern => pattern.test(contact.name))) {
        console.log(`Filtered out non-name: "${contact.name}"`);
        return false;
      }

      return true;
    });

    return {
      contacts: validContacts,
      domain: input.company_domain
    };
  } catch (error) {
    console.error("AI extraction error:", error);
    return { contacts: [], domain: null };
  }
}

// ============================================================================
// STAGE 2: EMAIL DOMAIN VERIFICATION (DNS MX lookup - free & fast)
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
 * Verify a domain has MX records
 */
async function verifyDomain(domain: string): Promise<boolean> {
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
async function verifyEmails(
  emails: string[],
  timeoutMs: number = 5000
): Promise<Map<string, boolean>> {
  const results = new Map<string, boolean>();

  const verifyWithTimeout = async (
    email: string
  ): Promise<[string, boolean]> => {
    try {
      const result = await Promise.race([
        verifyEmailDomain(email),
        new Promise<boolean>((_, reject) =>
          setTimeout(() => reject(new Error("timeout")), timeoutMs)
        )
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
// STAGE 3: SMART EMAIL PATTERN GENERATION
// ============================================================================

/**
 * Generate email address for a person using verified company domain
 */
function generateEmail(name: string, domain: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length < 2) {
    return `${parts[0].toLowerCase()}@${domain}`;
  }

  const firstName = parts[0].toLowerCase();
  const lastName = parts[parts.length - 1].toLowerCase();

  // Use most common pattern: first.last@domain
  return `${firstName}.${lastName}@${domain}`;
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
    aiExtraction: { found: 0, method: "Claude tool_use" },
    verification: { verified: 0, failed: 0 }
  };

  // -------------------------------------------------------------------------
  // STAGE 1: AI-Powered Contact Extraction
  // -------------------------------------------------------------------------

  const { contacts: extractedContacts, domain: extractedDomain } =
    await extractContactsWithAI(companyName, companyResearch);

  stages.aiExtraction.found = extractedContacts.length;

  // Use provided domain or extracted domain
  const companyDomain = params.companyDomain || extractedDomain;

  // -------------------------------------------------------------------------
  // STAGE 2: Verify domain if we have one
  // -------------------------------------------------------------------------

  let domainVerified = false;
  if (companyDomain) {
    domainVerified = await verifyDomain(companyDomain);
    if (domainVerified) {
      console.log(`Domain verified: ${companyDomain}`);
    } else {
      console.log(`Domain verification failed: ${companyDomain}`);
    }
  }

  // -------------------------------------------------------------------------
  // STAGE 3: Process contacts - verify existing emails, generate for others
  // -------------------------------------------------------------------------

  const emailsToVerify: string[] = [];

  // Collect emails that need verification
  for (const contact of extractedContacts) {
    if (contact.email) {
      emailsToVerify.push(contact.email);
    }
  }

  // Verify all emails in parallel
  const verificationResults = await verifyEmails(emailsToVerify, 3000);

  // Process each contact
  let generatedCount = 0;
  for (const extracted of extractedContacts) {
    let email = extracted.email;
    let verified = false;
    let source = "AI Extraction";
    let confidence = extracted.confidence;

    if (email) {
      // Verify the email from document
      verified = verificationResults.get(email) ?? false;
      if (verified) {
        stages.verification.verified++;
        confidence = "high";
      } else {
        stages.verification.failed++;
      }
    } else if (companyDomain && domainVerified) {
      // Generate email for contacts without one
      email = generateEmail(extracted.name, companyDomain);
      verified = true; // Domain is already verified
      source = "Generated (verified domain)";
      confidence = "medium";
      generatedCount++;
    }

    // Only add contacts that have an email
    if (email) {
      contacts.push({
        name: extracted.name,
        email,
        role: extracted.role,
        confidence,
        source,
        verified
      });
    }
  }

  if (generatedCount > 0) {
    stages.emailGeneration = { generated: generatedCount };
  }

  // -------------------------------------------------------------------------
  // Build summary
  // -------------------------------------------------------------------------

  const durationMs = Date.now() - startTime;
  const verifiedCount = contacts.filter((c) => c.verified).length;

  let summary = `Found ${contacts.length} contact(s) for ${companyName}. `;
  summary += `AI extracted ${stages.aiExtraction.found} people from document. `;
  if (stages.emailGeneration) {
    summary += `Generated ${stages.emailGeneration.generated} email(s). `;
  }
  summary += `${verifiedCount} verified via MX lookup.`;

  return {
    contacts: contacts.slice(0, 10), // Limit to 10 contacts
    summary,
    stages,
    durationMs
  };
}
