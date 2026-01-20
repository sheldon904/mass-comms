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
// CONFIGURATION - Time management for Vercel serverless
// ============================================================================

// Vercel has 55s max, we use 45s internal to leave buffer for response
const INTERNAL_TIMEOUT_MS = 45000;
const ITERATION_TIME_CHECK_MS = 5000; // Check time every iteration

// ============================================================================
// DOMAIN EXTRACTION - Smart domain detection from research doc
// ============================================================================

function extractCompanyDomain(research: string, companyName: string): string | null {
  const cleanCompanyName = companyName
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .replace(/(inc|llc|ltd|corp|company|co|group|holdings)$/i, "")
    .trim();

  // Domains to skip (news sites, social media, etc.)
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
// WEB BROWSING - Fetch webpage content
// ============================================================================

async function fetchWebpage(url: string): Promise<{ success: boolean; content: string; error?: string }> {
  try {
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      url = "https://" + url;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s timeout per page

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
    const truncated = content.length > 20000
      ? content.substring(0, 20000) + "\n...[truncated]"
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

  let result = "=== PAGE CONTENT ===\n" + text.substring(0, 12000);

  if (emails.length > 0) {
    result += "\n\n=== EMAILS FOUND ON PAGE ===\n" + Array.from(new Set(emails)).join("\n");
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
    result += "\n\n=== RELEVANT LINKS TO EXPLORE ===\n" + relevantLinks.slice(0, 15).join("\n");
  }

  return result;
}

// ============================================================================
// OSINT WEB SEARCH - Search for person's email online
// ============================================================================

async function webSearch(query: string): Promise<{ success: boolean; results: string; error?: string }> {
  try {
    const searchUrl = `https://www.bing.com/search?q=${encodeURIComponent(query)}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000); // 8s timeout for search

    const response = await fetch(searchUrl, {
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

    // Extract search results text and any emails found
    let text = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
    text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
    text = text.replace(/<[^>]+>/g, " ");
    text = text.replace(/\s+/g, " ").trim();

    // Find any emails in search results
    const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
    const emails = text.match(emailRegex) || [];

    let result = text.length > 6000 ? text.substring(0, 6000) : text;

    if (emails.length > 0) {
      result += "\n\n=== EMAILS FOUND IN SEARCH RESULTS ===\n" + Array.from(new Set(emails)).join("\n");
    }

    return { success: true, results: result };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return { success: false, results: "", error: message };
  }
}

// ============================================================================
// DNS / MX VERIFICATION
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
// AGENT TOOLS - Multi-tool agent architecture
// ============================================================================

const agentTools: Anthropic.Tool[] = [
  {
    name: "browse_webpage",
    description: "Fetch and read the content of a webpage. Returns the page text, any emails found, phone numbers found, and links to explore. Use this to browse the company website.",
    input_schema: {
      type: "object" as const,
      properties: {
        url: {
          type: "string",
          description: "Full URL to fetch (e.g., https://example.com/about)"
        }
      },
      required: ["url"]
    }
  },
  {
    name: "web_search",
    description: "Search the internet for information. Use this to verify contacts exist, find email addresses, or research specific people. Good for OSINT verification.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Search query (e.g., 'John Smith Acme Corp email' or '\"john.smith@acme.com\"')"
        }
      },
      required: ["query"]
    }
  },
  {
    name: "submit_contacts",
    description: "Submit discovered contacts. Include HOW you found each contact (found_method). Submit as you find contacts - don't wait until the end.",
    input_schema: {
      type: "object" as const,
      properties: {
        contacts: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string", description: "Full name of the contact" },
              email: { type: "string", description: "Email address" },
              phone: { type: ["string", "null"], description: "Phone number if found" },
              role: { type: "string", description: "Job title or role" },
              found_method: {
                type: "string",
                enum: ["direct_website", "osint_search", "pattern_match"],
                description: "How this contact was discovered: direct_website (found on company site), osint_search (found via web search), pattern_match (email guessed from pattern)"
              },
              source: { type: "string", description: "Where the contact was found (URL or search query)" }
            },
            required: ["name", "email", "role", "found_method", "source"]
          }
        }
      },
      required: ["contacts"]
    }
  }
];

// ============================================================================
// MAIN RESEARCH FUNCTION - Full context agent architecture
// ============================================================================

export async function researchContacts(params: ContactResearchParams): Promise<ResearchResult> {
  const startTime = Date.now();
  const { companyName, companyResearch } = params;
  const pagesVisited: string[] = [];
  const searchesPerformed: string[] = [];
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

  // =========================================================================
  // SYSTEM PROMPT - Full research document as context (NO regex preprocessing)
  // =========================================================================
  const systemPrompt = `You are an expert contact researcher. Your job is to find real, verified contact information for key people at ${companyName}.

## COMPANY RESEARCH DOCUMENT
The following is the complete research document about this company. Read it carefully to understand who the key people are:

---
${companyResearch}
---

## YOUR MISSION
1. Identify the KEY PEOPLE from the research document above (executives, founders, owners, key staff)
2. Find their REAL contact information using the tools available
3. Submit verified contacts as you find them

## COMPANY WEBSITE
Domain: ${domain}
Start browsing at: https://${domain}

## TOOLS AVAILABLE
- browse_webpage: Fetch pages from the company website
- web_search: Search the internet for contact info (OSINT)
- submit_contacts: Submit discovered contacts

## STRATEGY
1. Browse the company homepage first
2. Look for team/about/contact/leadership pages
3. For any key people mentioned but without emails, use web_search to find their email
4. When you find departmental contacts (info@, sales@, recruiting@), submit those too - they're valuable

## CONFIDENCE LEVELS (based on found_method)
- direct_website: HIGH confidence - found directly on company website
- osint_search: MEDIUM confidence - verified via web search
- pattern_match: LOW confidence - guessed from email pattern

## RULES
- NEVER invent or hallucinate email addresses
- If you can't find an email, don't submit that contact
- Submit contacts AS YOU FIND THEM - don't wait
- Departmental emails (info@, hr@, etc.) are valuable - submit them
- You have about 40 seconds total - work efficiently

## TIME MANAGEMENT
Work efficiently. Prioritize:
1. Direct finds on website (highest value)
2. OSINT verification for key executives
3. Pattern matching only as last resort`;

  const userPrompt = `Find contacts for ${companyName}.

Start by browsing https://${domain} to understand the company and find any contact information.
Then explore relevant pages (team, about, contact, leadership).
Use web_search to verify or find emails for key people.
Submit contacts as you find them.`;

  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: userPrompt }
  ];

  // =========================================================================
  // AGENTIC LOOP - Time-based iteration management
  // =========================================================================
  let iteration = 0;
  let shouldContinue = true;
  let noToolCallCount = 0;

  while (shouldContinue) {
    iteration++;
    const elapsed = Date.now() - startTime;
    const remaining = INTERNAL_TIMEOUT_MS - elapsed;

    console.log(`[Agent] Iteration ${iteration}, elapsed: ${Math.round(elapsed/1000)}s, remaining: ${Math.round(remaining/1000)}s`);

    // Time-based bailout
    if (remaining < ITERATION_TIME_CHECK_MS) {
      console.log("[Agent] Time limit approaching - stopping");
      break;
    }

    // Safety: max iterations
    if (iteration > 15) {
      console.log("[Agent] Max iterations reached");
      break;
    }

    try {
      const response = await anthropic.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 4000,
        system: systemPrompt,
        tools: agentTools,
        messages
      });

      const toolUseBlocks = response.content.filter(
        (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
      );

      // If no tool calls, agent is done
      if (toolUseBlocks.length === 0) {
        noToolCallCount++;
        if (noToolCallCount >= 2) {
          console.log("[Agent] No tool calls - agent finished");
          shouldContinue = false;
          break;
        }
        // Add message and continue
        messages.push({ role: "assistant", content: response.content });
        messages.push({ role: "user", content: "Continue searching for contacts. Use the tools to browse pages or search for people." });
        continue;
      }

      noToolCallCount = 0;
      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      for (const toolUse of toolUseBlocks) {
        // Check time before each tool call
        if (Date.now() - startTime > INTERNAL_TIMEOUT_MS - 3000) {
          console.log("[Agent] Time limit - skipping remaining tools");
          toolResults.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: "Time limit reached. Please submit any contacts you've found."
          });
          continue;
        }

        if (toolUse.name === "browse_webpage") {
          const input = toolUse.input as { url: string };
          let url = input.url;

          // Security: Validate URL is on company domain
          try {
            const urlObj = new URL(url.startsWith("http") ? url : `https://${url}`);
            const urlDomain = urlObj.hostname.replace("www.", "");
            const targetDomain = domain.replace("www.", "");

            if (!urlDomain.includes(targetDomain) && !targetDomain.includes(urlDomain)) {
              console.log(`[Agent] Blocked: ${url} (not on ${domain})`);
              toolResults.push({
                type: "tool_result",
                tool_use_id: toolUse.id,
                content: `Error: Can only browse ${domain}. Use web_search for external lookups.`
              });
              continue;
            }
          } catch {
            toolResults.push({
              type: "tool_result",
              tool_use_id: toolUse.id,
              content: "Error: Invalid URL format"
            });
            continue;
          }

          pagesVisited.push(url);
          console.log(`[Agent] Browsing: ${url}`);
          const result = await fetchWebpage(url);

          toolResults.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: result.success ? result.content : `Error fetching page: ${result.error}`
          });

        } else if (toolUse.name === "web_search") {
          const input = toolUse.input as { query: string };
          searchesPerformed.push(input.query);
          console.log(`[Agent] Searching: ${input.query}`);

          const result = await webSearch(input.query);

          toolResults.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: result.success ? result.results : `Search error: ${result.error}`
          });

        } else if (toolUse.name === "submit_contacts") {
          const input = toolUse.input as {
            contacts: Array<{
              name: string;
              email: string;
              phone?: string | null;
              role: string;
              found_method: "direct_website" | "osint_search" | "pattern_match";
              source: string;
            }>
          };

          let addedCount = 0;
          const seenEmails = new Set(finalContacts.map(c => c.email.toLowerCase()));

          for (const contact of input.contacts || []) {
            // Skip duplicates
            if (seenEmails.has(contact.email.toLowerCase())) {
              continue;
            }
            seenEmails.add(contact.email.toLowerCase());

            // Verify MX records
            const mxVerified = await verifyEmailDomain(contact.email);

            // Determine confidence based on found_method
            let confidence: "high" | "medium" | "low";
            if (contact.found_method === "direct_website" && mxVerified) {
              confidence = "high";
            } else if (contact.found_method === "osint_search") {
              confidence = "medium";
            } else {
              confidence = "low";
            }

            finalContacts.push({
              name: contact.name,
              email: contact.email,
              phone: contact.phone || null,
              role: contact.role,
              confidence,
              source: contact.source,
              verified: mxVerified
            });
            addedCount++;

            console.log(`[Agent] Added: ${contact.name} <${contact.email}> (${confidence})`);
          }

          toolResults.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: `Submitted ${addedCount} new contact(s). Total contacts: ${finalContacts.length}. Continue searching for more contacts if you haven't exhausted all options.`
          });
        }
      }

      messages.push({ role: "assistant", content: response.content });
      messages.push({ role: "user", content: toolResults });

    } catch (error) {
      console.error("[Agent] Error:", error);
      // On error, try to continue if we have time
      if (Date.now() - startTime < INTERNAL_TIMEOUT_MS - 10000) {
        messages.push({ role: "user", content: "There was an error. Please continue with your search." });
      } else {
        shouldContinue = false;
      }
    }
  }

  // =========================================================================
  // FINAL RESULTS
  // =========================================================================
  const durationMs = Date.now() - startTime;
  const phonesFound = finalContacts.filter(c => c.phone).length;
  const emailsVerified = finalContacts.filter(c => c.verified).length;
  const highConfidence = finalContacts.filter(c => c.confidence === "high").length;
  const mediumConfidence = finalContacts.filter(c => c.confidence === "medium").length;
  const lowConfidence = finalContacts.filter(c => c.confidence === "low").length;

  let summary = `Found ${finalContacts.length} contact(s) for ${companyName}. `;
  summary += `Browsed ${pagesVisited.length} page(s), ${searchesPerformed.length} OSINT search(es). `;
  summary += `Confidence: ${highConfidence} high, ${mediumConfidence} medium, ${lowConfidence} low. `;
  if (phonesFound > 0) summary += `${phonesFound} phone number(s).`;

  console.log(`[Research] Complete in ${Math.round(durationMs/1000)}s - ${finalContacts.length} contacts`);

  return {
    contacts: finalContacts.slice(0, 20), // Max 20 contacts
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
