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

interface TargetPerson {
  name: string;
  role: string;
  firstName: string;
  lastName: string;
}

interface EmailPattern {
  pattern: string; // "first.last", "flast", "firstl", "first_last", "first"
  domain: string;
  example: string;
  confidence: number;
}

// ============================================================================
// DOMAIN EXTRACTION
// ============================================================================

function extractCompanyDomain(research: string, companyName: string): string | null {
  const cleanCompanyName = companyName
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .replace(/(inc|llc|ltd|corp|company|co|group|holdings)$/i, "")
    .trim();

  const skipDomains = new Set([
    "prnewswire.com", "businesswire.com", "globenewswire.com", "prweb.com",
    "marketwatch.com", "reuters.com", "bloomberg.com", "wsj.com", "nytimes.com",
    "forbes.com", "fortune.com", "cnbc.com", "yahoo.com", "google.com",
    "linkedin.com", "twitter.com", "facebook.com", "instagram.com", "youtube.com",
    "wikipedia.org", "medium.com", "substack.com", "github.com",
    "gmail.com", "hotmail.com", "outlook.com", "aol.com", "icloud.com",
    "sec.gov", "edgar.sec.gov", "crunchbase.com", "pitchbook.com",
    "bizjournals.com", "zoominfo.com", "apollo.io", "hunter.io",
  ]);

  const domainMatches: { domain: string; score: number }[] = [];

  // Pattern 1: Explicit website mentions
  const websitePatterns = [
    /(?:website|web site|homepage|visit us at|learn more at|visit)[:\s]+(?:https?:\/\/)?(?:www\.)?([a-zA-Z0-9-]+\.[a-zA-Z]{2,}(?:\.[a-zA-Z]{2,})?)/gi,
    /(?:www\.)([a-zA-Z0-9-]+\.[a-zA-Z]{2,}(?:\.[a-zA-Z]{2,})?)/gi,
  ];

  for (const pattern of websitePatterns) {
    let match;
    while ((match = pattern.exec(research)) !== null) {
      const domain = match[1].toLowerCase();
      if (!skipDomains.has(domain)) {
        const containsCompanyName = domain.replace(/[^a-z0-9]/g, "").includes(cleanCompanyName);
        domainMatches.push({ domain, score: containsCompanyName ? 100 : 50 });
      }
    }
  }

  // Pattern 2: Email domains
  const emailPattern = /@([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/gi;
  let emailMatch;
  while ((emailMatch = emailPattern.exec(research)) !== null) {
    const domain = emailMatch[1].toLowerCase();
    if (!skipDomains.has(domain)) {
      const containsCompanyName = domain.replace(/[^a-z0-9]/g, "").includes(cleanCompanyName);
      domainMatches.push({ domain, score: containsCompanyName ? 90 : 40 });
    }
  }

  // Pattern 3: URLs in text
  const urlPattern = /https?:\/\/(?:www\.)?([a-zA-Z0-9-]+\.[a-zA-Z]{2,}(?:\.[a-zA-Z]{2,})?)/gi;
  let urlMatch;
  while ((urlMatch = urlPattern.exec(research)) !== null) {
    const domain = urlMatch[1].toLowerCase();
    if (!skipDomains.has(domain)) {
      const containsCompanyName = domain.replace(/[^a-z0-9]/g, "").includes(cleanCompanyName);
      domainMatches.push({ domain, score: containsCompanyName ? 80 : 30 });
    }
  }

  domainMatches.sort((a, b) => b.score - a.score);

  if (domainMatches.length > 0) {
    console.log(`Domain candidates: ${JSON.stringify(domainMatches.slice(0, 5))}`);
    return domainMatches[0].domain;
  }

  const simpleDomain = cleanCompanyName + ".com";
  console.log(`No domain found, trying fallback: ${simpleDomain}`);
  return simpleDomain;
}

// ============================================================================
// KEY PEOPLE EXTRACTION FROM RESEARCH DOC
// ============================================================================

// Priority order for roles (lower = higher priority)
const ROLE_PRIORITY: Record<string, number> = {
  "CEO": 1,
  "President": 2,
  "Owner": 3,
  "Founder": 4,
  "Co-Founder": 5,
  "CFO": 6,
  "COO": 7,
  "CTO": 8,
  "CMO": 9,
};

const MAX_TARGETS = 4; // Reduced to prevent timeout

// Words that should NEVER be part of a name
const INVALID_NAME_WORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "from", "in", "on", "at", "by", "for", "with",
  "is", "are", "was", "were", "be", "been", "being", "have", "has", "had",
  "promoted", "transitioned", "appointed", "named", "became", "joined", "left",
  "new", "former", "current", "acting", "interim", "senior", "junior", "chief",
  "company", "business", "firm", "group", "inc", "llc", "corp", "corporation",
  "approval", "rating", "revenue", "growth", "market", "industry", "sector",
  "based", "located", "founded", "established", "headquartered",
  "their", "our", "his", "her", "its", "who", "which", "that", "this",
  "home", "care", "health", "services", "solutions", "management", "consulting",
  "pinnacle", "ai", "tech", "digital", "global", "national", "regional",
]);

function extractTargetPeople(research: string, companyName: string): TargetPerson[] {
  const targets: TargetPerson[] = [];
  const seen = new Set<string>();

  // Simple, strict pattern: "FirstName LastName, CEO" or "CEO FirstName LastName"
  // Only match proper names (capitalized, 2-15 chars each part)
  const patterns = [
    // Pattern: "John Smith, CEO" or "John Smith - CEO"
    /([A-Z][a-z]{1,14})\s+([A-Z][a-z]{1,14})[\s,\-–]+(?:the\s+)?(CEO|President|Owner|Founder|Co-Founder|CFO|COO|CTO)/gi,
    // Pattern: "CEO John Smith" or "CEO: John Smith"
    /(CEO|President|Owner|Founder|Co-Founder|CFO|COO|CTO)[:\s,\-–]+([A-Z][a-z]{1,14})\s+([A-Z][a-z]{1,14})/gi,
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(research)) !== null) {
      let firstName: string;
      let lastName: string;
      let role: string;

      if (/^(CEO|President|Owner|Founder|Co-Founder|CFO|COO|CTO)/i.test(match[1])) {
        // Pattern 2: Role FirstName LastName
        role = match[1];
        firstName = match[2];
        lastName = match[3];
      } else {
        // Pattern 1: FirstName LastName Role
        firstName = match[1];
        lastName = match[2];
        role = match[3];
      }

      // Strict validation
      const firstLower = firstName.toLowerCase();
      const lastLower = lastName.toLowerCase();

      // Skip if either part is an invalid word
      if (INVALID_NAME_WORDS.has(firstLower) || INVALID_NAME_WORDS.has(lastLower)) {
        continue;
      }

      // Skip if first name is too short or looks like initials
      if (firstName.length < 3) continue;

      // Skip if last name is too short
      if (lastName.length < 3) continue;

      const fullName = `${firstName} ${lastName}`;
      const nameKey = fullName.toLowerCase();
      if (seen.has(nameKey)) continue;
      seen.add(nameKey);

      // Normalize role
      role = normalizeRole(role);

      targets.push({
        name: fullName,
        role,
        firstName: firstLower,
        lastName: lastLower,
      });
    }
  }

  // Sort by role priority and limit
  targets.sort((a, b) => {
    const prioA = ROLE_PRIORITY[a.role] || 99;
    const prioB = ROLE_PRIORITY[b.role] || 99;
    return prioA - prioB;
  });

  const limited = targets.slice(0, MAX_TARGETS);
  console.log(`Extracted ${limited.length} target people (from ${targets.length} found):`, limited.map(t => `${t.name} (${t.role})`));
  return limited;
}

function normalizeRole(role: string): string {
  const roleMap: Record<string, string> = {
    "ceo": "CEO",
    "chief executive officer": "CEO",
    "cfo": "CFO",
    "chief financial officer": "CFO",
    "coo": "COO",
    "chief operating officer": "COO",
    "cto": "CTO",
    "chief technology officer": "CTO",
    "cmo": "CMO",
    "chief marketing officer": "CMO",
    "president": "President",
    "founder": "Founder",
    "co-founder": "Co-Founder",
    "owner": "Owner",
    "vp": "Vice President",
    "vice president": "Vice President",
    "director": "Director",
    "managing partner": "Managing Partner",
    "partner": "Partner",
    "general manager": "General Manager",
    "executive director": "Executive Director",
    "chairman": "Chairman",
    "board member": "Board Member",
  };

  const normalized = roleMap[role.toLowerCase()];
  return normalized || role;
}

// ============================================================================
// EMAIL PATTERN DETECTION
// ============================================================================

function detectEmailPatterns(emails: string[], domain: string): EmailPattern[] {
  const patterns: EmailPattern[] = [];

  for (const email of emails) {
    const [localPart, emailDomain] = email.toLowerCase().split("@");
    if (emailDomain !== domain.toLowerCase()) continue;

    // Try to detect pattern from local part
    // Common patterns: first.last, flast, firstl, first_last, first-last, first

    // Check for first.last pattern (most common)
    if (/^[a-z]+\.[a-z]+$/.test(localPart)) {
      patterns.push({
        pattern: "first.last",
        domain: emailDomain,
        example: email,
        confidence: 0.9
      });
    }
    // Check for flast pattern
    else if (/^[a-z][a-z]+$/.test(localPart) && localPart.length >= 4 && localPart.length <= 12) {
      patterns.push({
        pattern: "flast",
        domain: emailDomain,
        example: email,
        confidence: 0.7
      });
    }
    // Check for first_last pattern
    else if (/^[a-z]+_[a-z]+$/.test(localPart)) {
      patterns.push({
        pattern: "first_last",
        domain: emailDomain,
        example: email,
        confidence: 0.85
      });
    }
    // Check for first-last pattern
    else if (/^[a-z]+-[a-z]+$/.test(localPart)) {
      patterns.push({
        pattern: "first-last",
        domain: emailDomain,
        example: email,
        confidence: 0.85
      });
    }
    // Check for firstl pattern
    else if (/^[a-z]+[a-z]$/.test(localPart) && localPart.length >= 4 && localPart.length <= 10) {
      patterns.push({
        pattern: "firstl",
        domain: emailDomain,
        example: email,
        confidence: 0.6
      });
    }
  }

  // Deduplicate and sort by confidence
  const uniquePatterns = new Map<string, EmailPattern>();
  for (const p of patterns) {
    const existing = uniquePatterns.get(p.pattern);
    if (!existing || p.confidence > existing.confidence) {
      uniquePatterns.set(p.pattern, p);
    }
  }

  const result = Array.from(uniquePatterns.values()).sort((a, b) => b.confidence - a.confidence);
  console.log(`Detected email patterns:`, result);
  return result;
}

function applyEmailPattern(pattern: EmailPattern, person: TargetPerson): string {
  const { firstName, lastName } = person;

  switch (pattern.pattern) {
    case "first.last":
      return `${firstName}.${lastName}@${pattern.domain}`;
    case "flast":
      return `${firstName[0]}${lastName}@${pattern.domain}`;
    case "firstl":
      return `${firstName}${lastName[0]}@${pattern.domain}`;
    case "first_last":
      return `${firstName}_${lastName}@${pattern.domain}`;
    case "first-last":
      return `${firstName}-${lastName}@${pattern.domain}`;
    case "first":
      return `${firstName}@${pattern.domain}`;
    default:
      return `${firstName}.${lastName}@${pattern.domain}`;
  }
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
    const timeoutId = setTimeout(() => controller.abort(), 8000);

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
    const truncated = content.length > 15000
      ? content.substring(0, 15000) + "\n...[truncated]"
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

  let result = "=== PAGE CONTENT ===\n" + text.substring(0, 10000);

  if (emails.length > 0) {
    result += "\n\n=== EMAILS FOUND ===\n" + Array.from(new Set(emails)).join("\n");
  }

  if (phones.length > 0) {
    result += "\n\n=== PHONE NUMBERS FOUND ===\n" + Array.from(new Set(phones)).join("\n");
  }

  const relevantLinks = links.filter(link => {
    const lower = link.toLowerCase();
    return lower.includes("team") || lower.includes("about") ||
           lower.includes("contact") || lower.includes("leadership") ||
           lower.includes("staff") || lower.includes("people") ||
           lower.includes("management") || lower.includes("executive") ||
           lower.includes("our-team") || lower.includes("who-we-are");
  });

  if (relevantLinks.length > 0) {
    result += "\n\n=== RELEVANT LINKS ===\n" + relevantLinks.slice(0, 20).join("\n");
  }

  return result;
}

// ============================================================================
// OSINT WEB SEARCH
// ============================================================================

async function osintWebSearch(query: string): Promise<{ success: boolean; results: string; error?: string }> {
  // Use a search-friendly approach - search for the person's email on business directories
  const searchUrls = [
    `https://www.bing.com/search?q=${encodeURIComponent(query)}`,
  ];

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 6000);

    const response = await fetch(searchUrls[0], {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      return { success: false, results: "", error: `HTTP ${response.status}` };
    }

    const html = await response.text();

    // Extract search results text
    let text = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
    text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
    text = text.replace(/<[^>]+>/g, " ");
    text = text.replace(/\s+/g, " ").trim();

    // Check if the email appears in results
    const truncated = text.length > 5000 ? text.substring(0, 5000) : text;

    return { success: true, results: truncated };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return { success: false, results: "", error: message };
  }
}

async function verifyEmailOnline(email: string, personName: string, companyName: string): Promise<boolean> {
  // Search for the email to see if it appears online
  const searchQuery = `"${email}" OR ("${personName}" "${companyName}" email)`;

  const result = await osintWebSearch(searchQuery);

  if (result.success) {
    // Check if the email appears in the search results
    const emailLower = email.toLowerCase();
    const resultsLower = result.results.toLowerCase();

    if (resultsLower.includes(emailLower)) {
      console.log(`OSINT verified: ${email} found online`);
      return true;
    }

    // Also check for partial matches that suggest the email exists
    const [localPart] = email.split("@");
    if (resultsLower.includes(localPart) && resultsLower.includes(personName.toLowerCase().split(" ")[1])) {
      console.log(`OSINT partial match for: ${email}`);
      return true;
    }
  }

  return false;
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

// ============================================================================
// AGENTIC RESEARCH WITH PATTERN MATCHING
// ============================================================================

// Simplified agent tools - NO OSINT (too slow for serverless)
const agentTools: Anthropic.Tool[] = [
  {
    name: "browse_webpage",
    description: "Fetch a webpage. Returns text content, emails found, phones found, and links.",
    input_schema: {
      type: "object" as const,
      properties: {
        url: { type: "string", description: "URL to fetch (must be on company domain)" }
      },
      required: ["url"]
    }
  },
  {
    name: "submit_contacts",
    description: "Submit discovered contacts. ONLY submit contacts with REAL emails found on pages.",
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
  const allEmailsFound: string[] = [];

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      contacts: [],
      summary: "No API key configured",
      stages: { pagesVisited: [], contactsFound: 0, emailsVerified: 0, phonesFound: 0 },
      durationMs: Date.now() - startTime
    };
  }

  // PHASE 1: Extract target people from research document (max 6)
  const targetPeople = extractTargetPeople(companyResearch, companyName);
  console.log(`Target executives to find: ${targetPeople.length}`);

  // Extract company domain
  const domain = params.companyDomain || extractCompanyDomain(companyResearch, companyName);
  console.log(`Company domain: ${domain}`);

  if (!domain) {
    return {
      contacts: [],
      summary: `Could not determine website for ${companyName}`,
      stages: { pagesVisited: [], contactsFound: 0, emailsVerified: 0, phonesFound: 0 },
      durationMs: Date.now() - startTime
    };
  }

  const anthropic = new Anthropic({ apiKey });

  // Create target list for the agent
  const targetList = targetPeople.length > 0
    ? `\n\nTARGET EXECUTIVES FROM RESEARCH:\n${targetPeople.map(p => `- ${p.name} (${p.role})`).join("\n")}`
    : "";

  const systemPrompt = `You are a fast contact research agent. Find REAL emails on the company website.

COMPANY: ${companyName}
DOMAIN: ${domain}
${targetList}

RULES:
1. Browse ONLY ${domain} - no other domains
2. Look for: team page, about page, contact page, leadership page
3. Extract REAL emails found on pages - never guess or make up emails
4. You have MAX 3 page visits - be strategic
5. Submit contacts when you find emails

Submit ALL contacts with real emails - departmental emails are valuable too.`;

  const userPrompt = `Find contacts for ${companyName} at https://${domain}

Browse the homepage first, then check team/about/contact pages.
Submit any contacts you find with real emails.`;

  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: userPrompt }
  ];

  // Agentic loop - VERY fast to avoid Vercel timeout
  const maxIterations = 4;
  let iteration = 0;
  let shouldContinue = true;

  while (shouldContinue && iteration < maxIterations) {
    iteration++;
    console.log(`Agent iteration ${iteration}...`);

    // Check timeout (18 seconds - must leave time for response)
    if (Date.now() - startTime > 18000) {
      console.log("Agent timeout - returning results");
      break;
    }

    try {
      const response = await anthropic.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 2000,
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
            const mxVerified = await verifyEmailDomain(contact.email);

            finalContacts.push({
              name: contact.name,
              email: contact.email,
              phone: contact.phone || null,
              role: contact.role,
              confidence: mxVerified ? "high" : "medium",
              source: contact.source_url,
              verified: mxVerified
            });
          }

          toolResults.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: `Submitted ${input.contacts?.length || 0} contacts.`
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
              content: `Error: Can only browse ${domain}.`
            });
            continue;
          }

          pagesVisited.push(url);
          console.log(`Browsing: ${url}`);
          const result = await fetchWebpage(url);

          // Collect emails for pattern detection
          if (result.success) {
            const emailMatches = result.content.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g);
            if (emailMatches) {
              allEmailsFound.push(...emailMatches);
            }
          }

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

  // POST-PROCESSING: Apply patterns to unfound targets (NO OSINT - too slow)
  // Must complete quickly to avoid Vercel timeout
  if (targetPeople.length > 0 && allEmailsFound.length > 0 && Date.now() - startTime < 30000) {
    console.log("Post-processing: Applying email patterns...");

    // Detect patterns from found emails
    const patterns = detectEmailPatterns(Array.from(new Set(allEmailsFound)), domain);

    if (patterns.length > 0) {
      const bestPattern = patterns[0];
      console.log(`Best pattern: ${bestPattern.pattern} (from ${bestPattern.example})`);

      // Find targets that weren't already found
      const foundNames = new Set(finalContacts.map(c => c.name.toLowerCase()));
      const unfoundTargets = targetPeople.filter(t => !foundNames.has(t.name.toLowerCase()));

      for (const target of unfoundTargets) {
        // Quick bail if running low on time
        if (Date.now() - startTime > 35000) break;

        const candidateEmail = applyEmailPattern(bestPattern, target);
        const mxVerified = await verifyEmailDomain(candidateEmail);

        finalContacts.push({
          name: target.name,
          email: candidateEmail,
          phone: null,
          role: target.role,
          confidence: "low", // Pattern-matched = low confidence
          source: `Pattern from ${bestPattern.example}`,
          verified: mxVerified
        });

        console.log(`Added ${target.name}: ${candidateEmail} (low - pattern)`);
      }
    }
  }

  const durationMs = Date.now() - startTime;
  const phonesFound = finalContacts.filter(c => c.phone).length;
  const emailsVerified = finalContacts.filter(c => c.verified).length;
  const highConfidence = finalContacts.filter(c => c.confidence === "high").length;
  const mediumConfidence = finalContacts.filter(c => c.confidence === "medium").length;
  const lowConfidence = finalContacts.filter(c => c.confidence === "low").length;

  let summary = `Found ${finalContacts.length} contact(s) for ${companyName}. `;
  summary += `Browsed ${pagesVisited.length} page(s). `;
  summary += `Confidence: ${highConfidence} high, ${mediumConfidence} medium, ${lowConfidence} low. `;
  if (phonesFound > 0) summary += `${phonesFound} phone(s).`;

  return {
    contacts: finalContacts.slice(0, 15),
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
