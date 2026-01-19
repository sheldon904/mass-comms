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
  phone: string | null;
  role: string;
  confidence: "high" | "medium" | "low";
  source: string;
  verified: boolean;
}

export interface ResearchResult {
  contacts: DiscoveredContact[];
  summary: string;
  stages: {
    pagesVisited: string[];
    contactsFound: number;
    emailsVerified: number;
    phonesFound: number;
  };
  durationMs: number;
}

export interface ContactResearchParams {
  companyName: string;
  companyResearch: string;
  companyDomain?: string;
}

// ============================================================================
// DOMAIN EXTRACTION - IMPROVED
// ============================================================================

/**
 * Extract company domain from research document - IMPROVED VERSION
 * Prioritizes actual company domains over press release sites
 */
function extractCompanyDomain(research: string, companyName: string): string | null {
  // Clean company name for matching
  const cleanCompanyName = companyName
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .replace(/(inc|llc|ltd|corp|company|co|group|holdings)$/i, "")
    .trim();

  // Domains to ALWAYS skip (press releases, social media, etc.)
  const skipDomains = new Set([
    "prnewswire.com", "businesswire.com", "globenewswire.com", "prweb.com",
    "marketwatch.com", "reuters.com", "bloomberg.com", "wsj.com", "nytimes.com",
    "forbes.com", "fortune.com", "cnbc.com", "yahoo.com", "google.com",
    "linkedin.com", "twitter.com", "facebook.com", "instagram.com", "youtube.com",
    "wikipedia.org", "medium.com", "substack.com", "github.com",
    "gmail.com", "hotmail.com", "outlook.com", "aol.com", "icloud.com",
    "sec.gov", "edgar.sec.gov", "crunchbase.com", "pitchbook.com",
  ]);

  // Extract all potential domains from the text
  const domainMatches: { domain: string; score: number }[] = [];

  // Pattern 1: Explicit website mentions (highest priority)
  const websitePatterns = [
    /(?:website|web site|homepage|visit us at|learn more at|visit)[:\s]+(?:https?:\/\/)?(?:www\.)?([a-zA-Z0-9-]+\.[a-zA-Z]{2,}(?:\.[a-zA-Z]{2,})?)/gi,
    /(?:www\.)([a-zA-Z0-9-]+\.[a-zA-Z]{2,}(?:\.[a-zA-Z]{2,})?)/gi,
  ];

  for (const pattern of websitePatterns) {
    let match;
    while ((match = pattern.exec(research)) !== null) {
      const domain = match[1].toLowerCase();
      if (!skipDomains.has(domain)) {
        // Higher score if domain contains company name
        const containsCompanyName = domain.replace(/[^a-z0-9]/g, "").includes(cleanCompanyName);
        domainMatches.push({
          domain,
          score: containsCompanyName ? 100 : 50
        });
      }
    }
  }

  // Pattern 2: Email domains (high priority)
  const emailPattern = /@([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/gi;
  let emailMatch;
  while ((emailMatch = emailPattern.exec(research)) !== null) {
    const domain = emailMatch[1].toLowerCase();
    if (!skipDomains.has(domain)) {
      const containsCompanyName = domain.replace(/[^a-z0-9]/g, "").includes(cleanCompanyName);
      domainMatches.push({
        domain,
        score: containsCompanyName ? 90 : 40
      });
    }
  }

  // Pattern 3: URLs in text (lower priority)
  const urlPattern = /https?:\/\/(?:www\.)?([a-zA-Z0-9-]+\.[a-zA-Z]{2,}(?:\.[a-zA-Z]{2,})?)/gi;
  let urlMatch;
  while ((urlMatch = urlPattern.exec(research)) !== null) {
    const domain = urlMatch[1].toLowerCase();
    if (!skipDomains.has(domain)) {
      const containsCompanyName = domain.replace(/[^a-z0-9]/g, "").includes(cleanCompanyName);
      domainMatches.push({
        domain,
        score: containsCompanyName ? 80 : 30
      });
    }
  }

  // Sort by score and return best match
  domainMatches.sort((a, b) => b.score - a.score);

  if (domainMatches.length > 0) {
    console.log(`Domain candidates: ${JSON.stringify(domainMatches.slice(0, 5))}`);
    return domainMatches[0].domain;
  }

  // Fallback: Try to construct domain from company name
  const simpleDomain = cleanCompanyName + ".com";
  console.log(`No domain found, trying fallback: ${simpleDomain}`);
  return simpleDomain;
}

// ============================================================================
// WEB BROWSING
// ============================================================================

async function fetchWebpage(url: string): Promise<{ success: boolean; content: string; error?: string }> {
  try {
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      url = "https://" + url;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000); // 8 second timeout

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      return { success: false, content: "", error: `HTTP ${response.status}` };
    }

    const html = await response.text();
    const content = extractTextFromHtml(html);
    const truncated = content.length > 12000
      ? content.substring(0, 12000) + "\n...[truncated]"
      : content;

    return { success: true, content: truncated };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return { success: false, content: "", error: message };
  }
}

function extractTextFromHtml(html: string): string {
  let text = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
  text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
  text = text.replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, "");

  // Extract emails
  const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  const emails = html.match(emailRegex) || [];

  // Extract phone numbers
  const phoneRegex = /(?:\+?1[-.\s]?)?\(?[0-9]{3}\)?[-.\s]?[0-9]{3}[-.\s]?[0-9]{4}/g;
  const phones = html.match(phoneRegex) || [];

  // Extract links for navigation
  const links: string[] = [];
  const linkRegex = /<a[^>]+href=["']([^"']+)["'][^>]*>([^<]*)<\/a>/gi;
  let match;
  while ((match = linkRegex.exec(html)) !== null) {
    const href = match[1];
    const linkText = match[2].trim();
    if (linkText && href && !href.startsWith("#") && !href.startsWith("javascript:")) {
      links.push(`[${linkText}](${href})`);
    }
  }

  // Convert HTML to text
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<\/p>/gi, "\n\n");
  text = text.replace(/<\/div>/gi, "\n");
  text = text.replace(/<\/h[1-6]>/gi, "\n\n");
  text = text.replace(/<li[^>]*>/gi, "\n• ");
  text = text.replace(/<[^>]+>/g, " ");
  text = text.replace(/&nbsp;/g, " ");
  text = text.replace(/&amp;/g, "&");
  text = text.replace(/&lt;/g, "<");
  text = text.replace(/&gt;/g, ">");
  text = text.replace(/&quot;/g, '"');
  text = text.replace(/&#39;/g, "'");
  text = text.replace(/\s+/g, " ");
  text = text.replace(/\n\s+/g, "\n");
  text = text.trim();

  let result = "=== PAGE CONTENT ===\n" + text.substring(0, 8000);

  if (emails.length > 0) {
    result += "\n\n=== EMAILS FOUND ===\n" + Array.from(new Set(emails)).join("\n");
  }

  if (phones.length > 0) {
    result += "\n\n=== PHONE NUMBERS FOUND ===\n" + Array.from(new Set(phones)).join("\n");
  }

  // Filter to relevant links
  const relevantLinks = links.filter(link => {
    const lower = link.toLowerCase();
    return lower.includes("team") || lower.includes("about") ||
           lower.includes("contact") || lower.includes("leadership") ||
           lower.includes("staff") || lower.includes("people") ||
           lower.includes("management") || lower.includes("executive");
  });

  if (relevantLinks.length > 0) {
    result += "\n\n=== RELEVANT LINKS ===\n" + relevantLinks.slice(0, 15).join("\n");
  }

  return result;
}

// ============================================================================
// DNS VERIFICATION
// ============================================================================

const mxCache = new Map<string, boolean>();

async function verifyEmailDomain(email: string): Promise<boolean> {
  const domain = email.split("@")[1];
  if (!domain) return false;

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

async function verifyDomainExists(domain: string): Promise<boolean> {
  if (mxCache.has(domain)) {
    return mxCache.get(domain)!;
  }

  try {
    const records = await resolveMx(domain);
    const exists = records && records.length > 0;
    mxCache.set(domain, exists);
    return exists;
  } catch {
    mxCache.set(domain, false);
    return false;
  }
}

// ============================================================================
// SIMPLIFIED AGENTIC RESEARCH
// ============================================================================

const agentTools: Anthropic.Tool[] = [
  {
    name: "browse_webpage",
    description: "Fetch and read a webpage. Returns text content, emails, phones, and relevant links.",
    input_schema: {
      type: "object" as const,
      properties: {
        url: { type: "string", description: "The URL to fetch" }
      },
      required: ["url"]
    }
  },
  {
    name: "submit_contacts",
    description: "Submit discovered contacts. Only use REAL emails found on pages, never generate patterns.",
    input_schema: {
      type: "object" as const,
      properties: {
        contacts: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              email: { type: "string" },
              phone: { type: ["string", "null"] },
              role: { type: "string" },
              source_url: { type: "string" }
            },
            required: ["name", "email", "role", "source_url"]
          }
        }
      },
      required: ["contacts"]
    }
  }
];

export async function researchContacts(params: ContactResearchParams): Promise<ResearchResult> {
  const startTime = Date.now();
  const { companyName, companyResearch } = params;
  const pagesVisited: string[] = [];
  let finalContacts: DiscoveredContact[] = [];

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      contacts: [],
      summary: "No API key configured",
      stages: { pagesVisited: [], contactsFound: 0, emailsVerified: 0, phonesFound: 0 },
      durationMs: Date.now() - startTime
    };
  }

  // Extract and verify company domain FIRST
  const domain = params.companyDomain || extractCompanyDomain(companyResearch, companyName);
  console.log(`Extracted domain for ${companyName}: ${domain}`);

  if (!domain) {
    return {
      contacts: [],
      summary: `Could not determine website for ${companyName}`,
      stages: { pagesVisited: [], contactsFound: 0, emailsVerified: 0, phonesFound: 0 },
      durationMs: Date.now() - startTime
    };
  }

  // Verify domain exists before browsing
  const domainExists = await verifyDomainExists(domain);
  if (!domainExists) {
    console.log(`Domain ${domain} does not have MX records, might not exist`);
  }

  const anthropic = new Anthropic({ apiKey });

  const systemPrompt = `You are a contact research agent. Find REAL contact info by browsing the company website.

RULES:
1. ONLY browse the company domain: ${domain}
2. Start at the homepage, find team/about/contact pages
3. Extract REAL emails and phones from pages - NEVER guess or generate patterns
4. You have MAX 4 page visits - be strategic
5. Submit contacts when you have real data

DO NOT:
- Browse other domains
- Make up email addresses
- Guess email patterns`;

  const userPrompt = `Research contacts for: ${companyName}
Website: https://${domain}

Start by browsing the homepage at https://${domain} and find their team/contact pages.
Extract real email addresses and phone numbers for key contacts.`;

  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: userPrompt }
  ];

  // Simplified agentic loop - max 5 iterations, 25s timeout
  const maxIterations = 5;
  let iteration = 0;
  let shouldContinue = true;

  while (shouldContinue && iteration < maxIterations) {
    iteration++;
    console.log(`Agent iteration ${iteration}...`);

    // Check timeout (25 seconds)
    if (Date.now() - startTime > 25000) {
      console.log("Agent timeout - returning partial results");
      break;
    }

    try {
      const response = await anthropic.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1500,
        system: systemPrompt,
        tools: agentTools,
        messages
      });

      const toolUseBlocks = response.content.filter(
        (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
      );

      if (toolUseBlocks.length === 0) {
        shouldContinue = false;
        break;
      }

      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      for (const toolUse of toolUseBlocks) {
        if (toolUse.name === "submit_contacts") {
          const input = toolUse.input as { contacts: Array<{
            name: string; email: string; phone?: string | null;
            role: string; source_url: string;
          }> };

          for (const contact of input.contacts || []) {
            const verified = await verifyEmailDomain(contact.email);
            finalContacts.push({
              name: contact.name,
              email: contact.email,
              phone: contact.phone || null,
              role: contact.role,
              confidence: verified ? "high" : "medium",
              source: contact.source_url,
              verified
            });
          }

          toolResults.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: "Contacts submitted."
          });
          shouldContinue = false;
        } else if (toolUse.name === "browse_webpage") {
          const input = toolUse.input as { url: string };
          let url = input.url;

          // Security: Only allow browsing the company domain
          const urlDomain = url.replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];
          if (!urlDomain.includes(domain.replace("www.", ""))) {
            console.log(`Blocked browse to different domain: ${url}`);
            toolResults.push({
              type: "tool_result",
              tool_use_id: toolUse.id,
              content: `Error: Can only browse ${domain}. Try a URL on that domain.`
            });
            continue;
          }

          pagesVisited.push(url);
          console.log(`Browsing: ${url}`);
          const result = await fetchWebpage(url);

          toolResults.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: result.success ? result.content : `Error: ${result.error}`
          });
        }
      }

      messages.push({ role: "assistant", content: response.content });
      messages.push({ role: "user", content: toolResults });

    } catch (error) {
      console.error("Agent error:", error);
      shouldContinue = false;
    }
  }

  const durationMs = Date.now() - startTime;
  const phonesFound = finalContacts.filter(c => c.phone).length;
  const emailsVerified = finalContacts.filter(c => c.verified).length;

  let summary = `Found ${finalContacts.length} contact(s) for ${companyName}. `;
  summary += `Browsed ${pagesVisited.length} page(s) on ${domain}. `;
  if (emailsVerified > 0) summary += `${emailsVerified} verified. `;
  if (phonesFound > 0) summary += `${phonesFound} phone(s).`;

  return {
    contacts: finalContacts.slice(0, 10),
    summary,
    stages: {
      pagesVisited,
      contactsFound: finalContacts.length,
      emailsVerified,
      phonesFound
    },
    durationMs
  };
}
