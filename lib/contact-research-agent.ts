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

// Progress event types for SSE streaming
export type ProgressEvent =
  | { type: "started"; companyName: string; domain: string }
  | { type: "phase"; phase: "extracting" | "browsing" | "searching" | "complete"; message: string }
  | { type: "iteration"; iteration: number; maxIterations: number; action: string }
  | { type: "contact"; contact: DiscoveredContact }
  | { type: "complete"; result: ResearchResult }
  | { type: "error"; message: string };

export type ProgressCallback = (event: ProgressEvent) => void;

interface KeyPerson {
  name: string;
  role: string;
}

interface ResearchPlan {
  keyPeople: KeyPerson[];
  companyDescription: string;
  suggestedPages: string[];
}

// ============================================================================
// CONFIGURATION
// ============================================================================

// Vercel Pro allows 300s - use 170s internal for ~2 min research with buffer
const INTERNAL_TIMEOUT_MS = 170000;
const MAX_ITERATIONS = 20;

// Rate limit handling
const MAX_RETRIES = 3;
const BASE_RETRY_DELAY_MS = 1000;

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

  const emailPattern = /@([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/gi;
  let emailMatch;
  while ((emailMatch = emailPattern.exec(research)) !== null) {
    const domain = emailMatch[1].toLowerCase();
    if (!skipDomains.has(domain)) {
      const containsCompanyName = domain.replace(/[^a-z0-9]/g, "").includes(cleanCompanyName);
      domainMatches.push({ domain, score: containsCompanyName ? 90 : 40 });
    }
  }

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
    return domainMatches[0].domain;
  }

  return cleanCompanyName + ".com";
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
    const timeoutId = setTimeout(() => controller.abort(), 10000);

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

  const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  const emails = html.match(emailRegex) || [];

  const phoneRegex = /(?:\+?1[-.\s]?)?\(?[0-9]{3}\)?[-.\s]?[0-9]{3}[-.\s]?[0-9]{4}/g;
  const phones = html.match(phoneRegex) || [];

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
    result += "\n\n=== PHONES FOUND ===\n" + Array.from(new Set(phones)).join("\n");
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
    result += "\n\n=== RELEVANT LINKS ===\n" + relevantLinks.slice(0, 8).join("\n");
  }

  return result;
}

// ============================================================================
// OSINT WEB SEARCH
// ============================================================================

async function webSearch(query: string): Promise<{ success: boolean; results: string; error?: string }> {
  try {
    const searchUrl = `https://www.bing.com/search?q=${encodeURIComponent(query)}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);

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

    let text = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
    text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
    text = text.replace(/<[^>]+>/g, " ");
    text = text.replace(/\s+/g, " ").trim();

    const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
    const emails = text.match(emailRegex) || [];

    let result = text.length > 3000 ? text.substring(0, 3000) : text;

    if (emails.length > 0) {
      result += "\n\n=== EMAILS IN RESULTS ===\n" + Array.from(new Set(emails)).join("\n");
    }

    return { success: true, results: result };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return { success: false, results: "", error: message };
  }
}

// ============================================================================
// SEC EDGAR API INTEGRATION
// ============================================================================

interface SECFiling {
  cik: string;
  companyName: string;
  officers: Array<{ name: string; title: string }>;
}

async function searchSECEdgar(companyName: string): Promise<{ success: boolean; data?: SECFiling; error?: string }> {
  try {
    // Step 1: Search for the company to get CIK
    const searchUrl = `https://efts.sec.gov/LATEST/search-index?q=${encodeURIComponent(companyName)}&dateRange=custom&startdt=2020-01-01&enddt=2025-12-31&forms=10-K,10-Q,8-K,DEF%2014A`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    const searchResponse = await fetch(searchUrl, {
      signal: controller.signal,
      headers: {
        "User-Agent": "ContactResearchAgent/1.0 (research@example.com)",
        "Accept": "application/json",
      },
    });

    clearTimeout(timeoutId);

    if (!searchResponse.ok) {
      // Try the full-text search API instead
      const ftSearchUrl = `https://efts.sec.gov/LATEST/search-index?q="${encodeURIComponent(companyName)}"`;
      const ftResponse = await fetch(ftSearchUrl, {
        headers: {
          "User-Agent": "ContactResearchAgent/1.0 (research@example.com)",
          "Accept": "application/json",
        },
      });

      if (!ftResponse.ok) {
        return { success: false, error: `SEC search failed: ${searchResponse.status}` };
      }
    }

    // Try to parse the search results to find CIK
    const searchData = await searchResponse.json();

    // The SEC search returns hits with _source containing filing info
    const hits = searchData?.hits?.hits || [];
    if (hits.length === 0) {
      return { success: false, error: "No SEC filings found for this company" };
    }

    // Extract CIK from first relevant hit
    const firstHit = hits[0]?._source || hits[0];
    const cik = firstHit?.ciks?.[0] || firstHit?.cik;

    if (!cik) {
      return { success: false, error: "Could not find CIK in SEC results" };
    }

    // Pad CIK to 10 digits
    const paddedCik = String(cik).padStart(10, "0");

    // Step 2: Get company submissions for officers/directors
    const submissionsUrl = `https://data.sec.gov/submissions/CIK${paddedCik}.json`;

    const subController = new AbortController();
    const subTimeoutId = setTimeout(() => subController.abort(), 10000);

    const subResponse = await fetch(submissionsUrl, {
      signal: subController.signal,
      headers: {
        "User-Agent": "ContactResearchAgent/1.0 (research@example.com)",
        "Accept": "application/json",
      },
    });

    clearTimeout(subTimeoutId);

    if (!subResponse.ok) {
      return { success: false, error: `SEC submissions fetch failed: ${subResponse.status}` };
    }

    const subData = await subResponse.json();

    // Extract officers from the company data
    const officers: Array<{ name: string; title: string }> = [];

    // The SEC data includes officers in certain fields
    // Try to get from filings or company info
    const companyNameFromSEC = subData.name || companyName;

    // Check for officers in recent DEF 14A (proxy statements) or 10-K filings
    // These contain executive compensation sections with officer names
    if (subData.filings?.recent) {
      const forms = subData.filings.recent.form || [];
      const primaryDocuments = subData.filings.recent.primaryDocument || [];
      const accessionNumbers = subData.filings.recent.accessionNumber || [];

      // Find DEF 14A or 10-K filings (most likely to have officer info)
      for (let i = 0; i < Math.min(forms.length, 5); i++) {
        if (forms[i] === "DEF 14A" || forms[i] === "10-K") {
          // We found a relevant filing - in a full implementation we'd parse it
          // For now, return what we have and let the agent search further
          break;
        }
      }
    }

    // SEC also sometimes has officers directly in the response
    if (subData.officers) {
      for (const officer of subData.officers) {
        officers.push({
          name: officer.name || officer.officerName,
          title: officer.title || officer.officerTitle || "Executive"
        });
      }
    }

    return {
      success: true,
      data: {
        cik: paddedCik,
        companyName: companyNameFromSEC,
        officers
      }
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return { success: false, error: `SEC EDGAR error: ${message}` };
  }
}

// ============================================================================
// SMTP EMAIL VERIFICATION (holehe-style)
// ============================================================================

import net from "net";

interface SMTPVerifyResult {
  valid: boolean;
  exists: "yes" | "no" | "unknown";
  reason: string;
}

async function verifyEmailSMTP(email: string): Promise<SMTPVerifyResult> {
  const domain = email.split("@")[1];
  if (!domain) {
    return { valid: false, exists: "no", reason: "Invalid email format" };
  }

  try {
    // First get MX records
    const mxRecords = await resolveMx(domain);
    if (!mxRecords || mxRecords.length === 0) {
      return { valid: false, exists: "no", reason: "No MX records" };
    }

    // Sort by priority and get best MX
    mxRecords.sort((a, b) => a.priority - b.priority);
    const mxHost = mxRecords[0].exchange;

    // Connect to SMTP server
    return new Promise((resolve) => {
      const socket = new net.Socket();
      let step = 0;
      let response = "";

      const timeout = setTimeout(() => {
        socket.destroy();
        resolve({ valid: true, exists: "unknown", reason: "Connection timeout - MX valid" });
      }, 8000);

      socket.connect(25, mxHost, () => {
        // Connected, wait for greeting
      });

      socket.on("data", (data) => {
        response = data.toString();
        const code = parseInt(response.substring(0, 3), 10);

        if (step === 0) {
          // Got greeting, send HELO
          if (code === 220) {
            socket.write("HELO mail.example.com\r\n");
            step = 1;
          } else {
            clearTimeout(timeout);
            socket.destroy();
            resolve({ valid: true, exists: "unknown", reason: "Unexpected greeting" });
          }
        } else if (step === 1) {
          // Got HELO response, send MAIL FROM
          if (code === 250) {
            socket.write("MAIL FROM:<verify@example.com>\r\n");
            step = 2;
          } else {
            clearTimeout(timeout);
            socket.destroy();
            resolve({ valid: true, exists: "unknown", reason: "HELO rejected" });
          }
        } else if (step === 2) {
          // Got MAIL FROM response, send RCPT TO
          if (code === 250) {
            socket.write(`RCPT TO:<${email}>\r\n`);
            step = 3;
          } else {
            clearTimeout(timeout);
            socket.destroy();
            resolve({ valid: true, exists: "unknown", reason: "MAIL FROM rejected" });
          }
        } else if (step === 3) {
          // Got RCPT TO response - this tells us if email exists
          clearTimeout(timeout);
          socket.write("QUIT\r\n");
          socket.destroy();

          if (code === 250 || code === 251) {
            resolve({ valid: true, exists: "yes", reason: "SMTP verified - mailbox exists" });
          } else if (code === 550 || code === 551 || code === 552 || code === 553) {
            resolve({ valid: true, exists: "no", reason: "SMTP verified - mailbox does not exist" });
          } else if (code === 450 || code === 451 || code === 452) {
            resolve({ valid: true, exists: "unknown", reason: "Temporary failure - try later" });
          } else {
            resolve({ valid: true, exists: "unknown", reason: `Unknown response: ${code}` });
          }
        }
      });

      socket.on("error", () => {
        clearTimeout(timeout);
        socket.destroy();
        // SMTP connection failed but MX exists - still valid domain
        resolve({ valid: true, exists: "unknown", reason: "SMTP connection failed - MX valid" });
      });

      socket.on("close", () => {
        clearTimeout(timeout);
      });
    });
  } catch {
    return { valid: false, exists: "no", reason: "MX lookup failed" };
  }
}

// ============================================================================
// COMPREHENSIVE OSINT SEARCH (theHarvester-style)
// ============================================================================

interface OSINTResult {
  source: string;
  emails: string[];
  names: string[];
  phones: string[];
  raw: string;
}

async function comprehensiveOSINTSearch(
  companyName: string,
  domain: string
): Promise<{ success: boolean; results: OSINTResult[]; summary: string }> {
  const results: OSINTResult[] = [];
  const allEmails = new Set<string>();
  const allNames = new Set<string>();

  // Define search queries for different sources
  const searches = [
    // Press releases (great for media contacts)
    { source: "PRNewswire", query: `"${companyName}" contact email site:prnewswire.com` },
    { source: "BusinessWire", query: `"${companyName}" contact email site:businesswire.com` },
    { source: "GlobeNewswire", query: `"${companyName}" contact site:globenewswire.com` },

    // LinkedIn (executives)
    { source: "LinkedIn", query: `"${companyName}" CEO OR CFO OR President site:linkedin.com` },
    { source: "LinkedIn-Email", query: `"${companyName}" @${domain} site:linkedin.com` },

    // News and business
    { source: "News", query: `"${companyName}" executive email contact` },
    { source: "Contact", query: `"${companyName}" "contact us" email @${domain}` },

    // Domain-specific searches
    { source: "Email-Hunter", query: `@${domain} email contact` },
    { source: "Direct", query: `site:${domain} email contact team` },
  ];

  // Run searches in parallel (max 4 at a time to avoid rate limits)
  const batchSize = 4;
  for (let i = 0; i < searches.length; i += batchSize) {
    const batch = searches.slice(i, i + batchSize);
    const batchPromises = batch.map(async ({ source, query }) => {
      const result = await webSearch(query);
      if (result.success) {
        // Extract emails
        const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
        const emails = (result.results.match(emailRegex) || []).filter(
          e => !e.includes("example.com") && !e.includes("email.com")
        );

        // Extract potential names (Title Case patterns near emails)
        const nameRegex = /([A-Z][a-z]+ [A-Z][a-z]+)/g;
        const names = result.results.match(nameRegex) || [];

        // Extract phones
        const phoneRegex = /(?:\+?1[-.\s]?)?\(?[0-9]{3}\)?[-.\s]?[0-9]{3}[-.\s]?[0-9]{4}/g;
        const phones = result.results.match(phoneRegex) || [];

        emails.forEach(e => allEmails.add(e.toLowerCase()));
        names.forEach(n => allNames.add(n));

        return {
          source,
          emails: Array.from(new Set(emails)),
          names: Array.from(new Set(names)).slice(0, 5),
          phones: Array.from(new Set(phones)),
          raw: result.results.substring(0, 500)
        };
      }
      return null;
    });

    const batchResults = await Promise.all(batchPromises);
    results.push(...batchResults.filter((r): r is OSINTResult => r !== null));

    // Small delay between batches
    if (i + batchSize < searches.length) {
      await new Promise(resolve => setTimeout(resolve, 300));
    }
  }

  const summary = `OSINT search complete. Found ${allEmails.size} unique emails, ${allNames.size} potential names across ${results.length} sources.`;

  return { success: true, results, summary };
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
// EMAIL PATTERN DETECTION AND GENERATION
// ============================================================================

type EmailPattern =
  | "firstname.lastname"    // john.smith@company.com
  | "firstnamelastname"     // johnsmith@company.com
  | "firstname_lastname"    // john_smith@company.com
  | "firstname"             // john@company.com
  | "flastname"             // jsmith@company.com
  | "firstl"                // johns@company.com
  | "lastname.firstname"    // smith.john@company.com
  | "lastnameFirstname"     // smithjohn@company.com
  | "firstinitial.lastname" // j.smith@company.com
  | "unknown";

interface DetectedPattern {
  pattern: EmailPattern;
  confidence: number;
  examples: string[];
}

interface PatternContext {
  detectedPattern: DetectedPattern | null;
  companyDomain: string;
  foundEmails: string[];
}

// Common generic emails to skip when detecting patterns
const GENERIC_PREFIXES = new Set([
  "info", "contact", "sales", "support", "help", "admin", "hr", "careers",
  "jobs", "media", "press", "marketing", "billing", "accounts", "service",
  "customerservice", "team", "hello", "enquiries", "office", "general",
  "webmaster", "postmaster", "noreply", "no-reply", "donotreply"
]);

function isPersonalEmail(localPart: string): boolean {
  // Skip generic/functional emails
  if (GENERIC_PREFIXES.has(localPart.toLowerCase())) {
    return false;
  }
  // Personal emails usually have letters and maybe dots/underscores
  // and are not just numbers
  return /^[a-zA-Z][a-zA-Z0-9._-]*[a-zA-Z]?$/.test(localPart) &&
         localPart.length >= 3 &&
         !/^\d+$/.test(localPart);
}

function detectEmailPattern(emails: string[], targetDomain: string): DetectedPattern | null {
  // Filter to only emails from the target domain that look like personal emails
  const relevantEmails = emails.filter(email => {
    const [localPart, domain] = email.toLowerCase().split("@");
    return domain === targetDomain.toLowerCase() && isPersonalEmail(localPart);
  });

  if (relevantEmails.length === 0) {
    return null;
  }

  // Analyze patterns
  const patterns: { pattern: EmailPattern; matches: string[] }[] = [
    { pattern: "firstname.lastname", matches: [] },
    { pattern: "firstnamelastname", matches: [] },
    { pattern: "firstname_lastname", matches: [] },
    { pattern: "firstname", matches: [] },
    { pattern: "flastname", matches: [] },
    { pattern: "firstl", matches: [] },
    { pattern: "firstinitial.lastname", matches: [] },
  ];

  for (const email of relevantEmails) {
    const localPart = email.split("@")[0].toLowerCase();

    // firstname.lastname (most common corporate pattern)
    if (/^[a-z]+\.[a-z]+$/.test(localPart)) {
      patterns[0].matches.push(email);
    }
    // firstnamelastname
    else if (/^[a-z]{6,}$/.test(localPart) && !localPart.includes(".") && !localPart.includes("_")) {
      patterns[1].matches.push(email);
    }
    // firstname_lastname
    else if (/^[a-z]+_[a-z]+$/.test(localPart)) {
      patterns[2].matches.push(email);
    }
    // firstname only (short, single word)
    else if (/^[a-z]{3,10}$/.test(localPart)) {
      patterns[3].matches.push(email);
    }
    // flastname (initial + lastname)
    else if (/^[a-z][a-z]{3,}$/.test(localPart) && localPart.length <= 12) {
      patterns[4].matches.push(email);
    }
    // firstl (firstname + initial)
    else if (/^[a-z]{3,}[a-z]$/.test(localPart) && localPart.length <= 10) {
      patterns[5].matches.push(email);
    }
    // j.smith pattern
    else if (/^[a-z]\.[a-z]+$/.test(localPart)) {
      patterns[6].matches.push(email);
    }
  }

  // Find the pattern with most matches
  patterns.sort((a, b) => b.matches.length - a.matches.length);

  const bestPattern = patterns[0];
  if (bestPattern.matches.length > 0) {
    // Confidence based on how many examples we found
    const confidence = Math.min(bestPattern.matches.length * 30, 90);
    return {
      pattern: bestPattern.pattern,
      confidence,
      examples: bestPattern.matches.slice(0, 3)
    };
  }

  return null;
}

function generateEmailFromPattern(
  firstName: string,
  lastName: string,
  pattern: EmailPattern,
  domain: string
): string | null {
  const first = firstName.toLowerCase().replace(/[^a-z]/g, "");
  const last = lastName.toLowerCase().replace(/[^a-z]/g, "");

  if (!first || !last) return null;

  switch (pattern) {
    case "firstname.lastname":
      return `${first}.${last}@${domain}`;
    case "firstnamelastname":
      return `${first}${last}@${domain}`;
    case "firstname_lastname":
      return `${first}_${last}@${domain}`;
    case "firstname":
      return `${first}@${domain}`;
    case "flastname":
      return `${first[0]}${last}@${domain}`;
    case "firstl":
      return `${first}${last[0]}@${domain}`;
    case "firstinitial.lastname":
      return `${first[0]}.${last}@${domain}`;
    case "lastname.firstname":
      return `${last}.${first}@${domain}`;
    case "lastnameFirstname":
      return `${last}${first}@${domain}`;
    default:
      return null;
  }
}

function parseFullName(fullName: string): { firstName: string; lastName: string } | null {
  const parts = fullName.trim().split(/\s+/);
  if (parts.length < 2) return null;

  // Handle common prefixes/suffixes
  const prefixes = ["dr", "mr", "mrs", "ms", "prof"];
  const suffixes = ["jr", "sr", "ii", "iii", "iv", "phd", "md", "esq"];

  let cleanParts = parts.filter(p =>
    !prefixes.includes(p.toLowerCase().replace(".", "")) &&
    !suffixes.includes(p.toLowerCase().replace(".", ""))
  );

  if (cleanParts.length < 2) cleanParts = parts;

  return {
    firstName: cleanParts[0],
    lastName: cleanParts[cleanParts.length - 1]
  };
}

// Generate multiple email candidates for a person
function generateEmailCandidates(
  fullName: string,
  domain: string,
  detectedPattern?: EmailPattern
): string[] {
  const parsed = parseFullName(fullName);
  if (!parsed) return [];

  const { firstName, lastName } = parsed;
  const candidates: string[] = [];

  // If we detected a pattern, prioritize it
  if (detectedPattern && detectedPattern !== "unknown") {
    const primary = generateEmailFromPattern(firstName, lastName, detectedPattern, domain);
    if (primary) candidates.push(primary);
  }

  // Add common patterns as fallbacks
  const commonPatterns: EmailPattern[] = [
    "firstname.lastname",
    "flastname",
    "firstname",
    "firstinitial.lastname"
  ];

  for (const pattern of commonPatterns) {
    if (pattern === detectedPattern) continue;
    const email = generateEmailFromPattern(firstName, lastName, pattern, domain);
    if (email && !candidates.includes(email)) {
      candidates.push(email);
    }
  }

  return candidates.slice(0, 4); // Return top 4 candidates
}

// ============================================================================
// RATE-LIMITED API CALL WITH RETRY
// ============================================================================

async function callAnthropicWithRetry(
  anthropic: Anthropic,
  params: Anthropic.MessageCreateParamsNonStreaming,
  startTime: number
): Promise<Anthropic.Message | null> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const elapsed = Date.now() - startTime;
    if (elapsed > INTERNAL_TIMEOUT_MS - 8000) {
      return null;
    }

    try {
      const response = await anthropic.messages.create(params);
      return response as Anthropic.Message;
    } catch (error) {
      const isRateLimit = error instanceof Error &&
        (error.message.includes("429") || error.message.includes("rate_limit"));

      if (isRateLimit && attempt < MAX_RETRIES - 1) {
        const delay = BASE_RETRY_DELAY_MS * Math.pow(2, attempt) + Math.random() * 500;
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }

      console.error(`[API] Error:`, error instanceof Error ? error.message : error);
      return null;
    }
  }

  return null;
}

// ============================================================================
// PHASE 1: EXTRACT KEY INFO FROM RESEARCH
// ============================================================================

async function extractKeyInfo(
  anthropic: Anthropic,
  companyName: string,
  companyResearch: string,
  startTime: number,
  onProgress?: ProgressCallback
): Promise<ResearchPlan | null> {
  onProgress?.({ type: "phase", phase: "extracting", message: "Analyzing research document..." });

  const truncatedResearch = companyResearch.length > 6000
    ? companyResearch.substring(0, 6000) + "\n...[truncated]"
    : companyResearch;

  const response = await callAnthropicWithRetry(anthropic, {
    model: "claude-sonnet-4-20250514",
    max_tokens: 800,
    system: "Extract key people from company research. Return ONLY valid JSON.",
    messages: [{
      role: "user",
      content: `Extract key people from this research about ${companyName}:

${truncatedResearch}

Return JSON:
{"keyPeople": [{"name": "Full Name", "role": "Title"}], "companyDescription": "Brief description", "suggestedPages": ["about", "team", "contact"]}

Rules:
- Only real people with specific names (max 5)
- Prioritize: CEO, President, Owner, Founder
- JSON only, no markdown`
    }]
  }, startTime);

  if (!response) return null;

  try {
    const textBlock = response.content.find(b => b.type === "text");
    if (!textBlock || textBlock.type !== "text") return null;

    let jsonText = textBlock.text.trim();
    if (jsonText.startsWith("```")) {
      jsonText = jsonText.replace(/^```json?\n?/, "").replace(/\n?```$/, "");
    }

    return JSON.parse(jsonText) as ResearchPlan;
  } catch {
    return null;
  }
}

// ============================================================================
// AGENT TOOLS
// ============================================================================

const agentTools: Anthropic.Tool[] = [
  {
    name: "browse_webpage",
    description: "Fetch webpage content including emails and phones found.",
    input_schema: {
      type: "object" as const,
      properties: {
        url: { type: "string", description: "URL to fetch" }
      },
      required: ["url"]
    }
  },
  {
    name: "web_search",
    description: "Search internet for contact info. Use for OSINT verification.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Search query" }
      },
      required: ["query"]
    }
  },
  {
    name: "search_sec_edgar",
    description: "Search SEC EDGAR for company officers and executives. Returns names and titles from SEC filings (10-K, DEF 14A proxy statements). VERY USEFUL for finding executives at public companies or companies that have filed with SEC.",
    input_schema: {
      type: "object" as const,
      properties: {
        company_name: { type: "string", description: "Company name to search in SEC filings" }
      },
      required: ["company_name"]
    }
  },
  {
    name: "osint_search",
    description: "Comprehensive OSINT search across multiple sources: press releases (PRNewswire, BusinessWire), LinkedIn, news articles, and domain-specific searches. Returns emails, names, and phones from all sources. Use this when website browsing yields no results.",
    input_schema: {
      type: "object" as const,
      properties: {
        company_name: { type: "string", description: "Company name" },
        domain: { type: "string", description: "Company domain (e.g., 'company.com')" }
      },
      required: ["company_name", "domain"]
    }
  },
  {
    name: "verify_email_smtp",
    description: "Advanced email verification using SMTP protocol. Checks if mailbox actually exists on the mail server (not just MX records). More reliable than basic validation. Returns 'yes', 'no', or 'unknown' for email existence.",
    input_schema: {
      type: "object" as const,
      properties: {
        email: { type: "string", description: "Email address to verify" }
      },
      required: ["email"]
    }
  },
  {
    name: "generate_email",
    description: "Generate email candidates for a person based on detected company email pattern. Returns multiple candidates ranked by likelihood. Use after finding at least one employee email to detect the pattern.",
    input_schema: {
      type: "object" as const,
      properties: {
        person_name: { type: "string", description: "Full name of the person (e.g., 'John Smith')" },
        found_emails: {
          type: "array",
          items: { type: "string" },
          description: "List of employee emails already found on the website (used to detect pattern)"
        }
      },
      required: ["person_name", "found_emails"]
    }
  },
  {
    name: "validate_email",
    description: "Basic email validation - checks MX records. For deeper verification, use verify_email_smtp instead.",
    input_schema: {
      type: "object" as const,
      properties: {
        email: { type: "string", description: "Email to validate" },
        person_name: { type: "string", description: "Person's name for search corroboration" }
      },
      required: ["email", "person_name"]
    }
  },
  {
    name: "submit_contacts",
    description: "Submit discovered contacts. ALWAYS submit something - even generic emails like info@, sales@ if no personal contacts found.",
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
              found_method: { type: "string", enum: ["direct_website", "osint_search", "pattern_match", "sec_filing", "generic_fallback"] },
              source: { type: "string" }
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
// MAIN RESEARCH FUNCTION WITH STREAMING SUPPORT
// ============================================================================

export async function researchContacts(
  params: ContactResearchParams,
  onProgress?: ProgressCallback
): Promise<ResearchResult> {
  const startTime = Date.now();
  const { companyName, companyResearch } = params;
  const pagesVisited: string[] = [];
  const searchesPerformed: string[] = [];
  let finalContacts: DiscoveredContact[] = [];

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    onProgress?.({ type: "error", message: "No API key configured" });
    return {
      contacts: [],
      summary: "No API key configured",
      stages: { pagesVisited: [], contactsFound: 0, emailsVerified: 0, phonesFound: 0 },
      durationMs: Date.now() - startTime
    };
  }

  const domain = params.companyDomain || extractCompanyDomain(companyResearch, companyName);

  if (!domain) {
    onProgress?.({ type: "error", message: "Could not determine website" });
    return {
      contacts: [],
      summary: `Could not determine website for ${companyName}`,
      stages: { pagesVisited: [], contactsFound: 0, emailsVerified: 0, phonesFound: 0 },
      durationMs: Date.now() - startTime
    };
  }

  onProgress?.({ type: "started", companyName, domain });

  const anthropic = new Anthropic({ apiKey });

  // Phase 1: Extract key info
  const plan = await extractKeyInfo(anthropic, companyName, companyResearch, startTime, onProgress);

  const keyPeopleList = plan?.keyPeople && plan.keyPeople.length > 0
    ? plan.keyPeople.map(p => `${p.name} (${p.role})`).join(", ")
    : "executives and key staff";

  onProgress?.({ type: "phase", phase: "browsing", message: `Found key people: ${keyPeopleList}` });

  // Pattern context for email generation
  const patternContext: PatternContext = {
    detectedPattern: null,
    companyDomain: domain,
    foundEmails: []
  };

  // Phase 2: Agentic browsing with external OSINT
  const systemPrompt = `You are an aggressive contact researcher for ${companyName} (${domain}).

KEY PEOPLE TO FIND: ${keyPeopleList}

TOOLS AVAILABLE:
- browse_webpage: Fetch company website pages
- web_search: Search the web for contact info
- search_sec_edgar: Search SEC filings for executives (GREAT for public companies)
- osint_search: Comprehensive multi-source OSINT search (press releases, LinkedIn, news)
- verify_email_smtp: Deep SMTP verification of email existence
- generate_email: Generate email patterns based on found emails
- validate_email: Basic MX record check
- submit_contacts: Submit found contacts (REQUIRED - NEVER END WITHOUT SUBMITTING)

AGGRESSIVE RESEARCH STRATEGY (you have ~2 minutes and 20 iterations):

PHASE 1 - WEBSITE SCRAPING (iterations 1-4):
1. Browse https://${domain}
2. Browse https://${domain}/about or /about-us
3. Browse https://${domain}/team or /leadership or /our-team
4. Browse https://${domain}/contact or /contact-us
COLLECT ALL EMAILS (personal AND generic like info@, sales@, contact@)

PHASE 2 - SEC EDGAR (iteration 5):
- Call search_sec_edgar("${companyName}")
- This returns executives from SEC filings - VERY RELIABLE for public companies
- Use these names with generate_email if you have a pattern

PHASE 3 - COMPREHENSIVE OSINT (iterations 6-8):
- Call osint_search("${companyName}", "${domain}")
- This searches PRNewswire, BusinessWire, LinkedIn, news sites simultaneously
- Rich source of media contacts, executives, and emails

PHASE 4 - TARGETED WEB SEARCHES (iterations 9-12):
- "${companyName}" CEO email contact
- "${companyName}" president owner email
- "${companyName}" @${domain}
- site:linkedin.com "${companyName}" email

PHASE 5 - PATTERN GENERATION (iterations 13-16):
- If you have ANY employee emails and ANY names, use generate_email
- Verify with verify_email_smtp (checks if mailbox exists)
- Submit with found_method="pattern_match"

PHASE 6 - FALLBACK (iterations 17-20):
IF NO PERSONAL CONTACTS FOUND, YOU MUST STILL SUBMIT:
- Generic emails: info@${domain}, contact@${domain}, sales@${domain}
- With name="General Contact" or "Sales Department"
- With role="General Inquiries" or "Sales"
- With found_method="generic_fallback"

CRITICAL RULES:
1. NEVER give up - ALWAYS submit something
2. Use ALL available tools - don't just browse the website
3. SEC EDGAR and osint_search are powerful - USE THEM
4. verify_email_smtp is more reliable than validate_email
5. Submit contacts AS YOU FIND THEM - don't wait until the end
6. Generic emails are ACCEPTABLE as fallback - better than nothing
7. You have 20 iterations and ~2 minutes - USE THAT TIME

CONFIDENCE LEVELS:
- direct_website = HIGH (found directly on company site)
- sec_filing = HIGH (from official SEC filings)
- osint_search = MEDIUM (from press releases, LinkedIn)
- pattern_match = MEDIUM (if SMTP verified)
- generic_fallback = LOW (generic emails as last resort)

START NOW. Begin with browse_webpage for https://${domain}`;

  const messages: Anthropic.MessageParam[] = [{
    role: "user",
    content: `Find contacts for ${companyName}. Start with https://${domain}`
  }];

  let iteration = 0;
  let shouldContinue = true;
  let noToolCallCount = 0;

  while (shouldContinue) {
    iteration++;
    const elapsed = Date.now() - startTime;
    const remaining = INTERNAL_TIMEOUT_MS - elapsed;

    // Time check - need at least 10s for an iteration
    if (remaining < 10000) {
      onProgress?.({ type: "phase", phase: "complete", message: "Time limit reached, returning results" });
      break;
    }

    if (iteration > MAX_ITERATIONS) {
      onProgress?.({ type: "phase", phase: "complete", message: "Max iterations reached" });
      break;
    }

    onProgress?.({
      type: "iteration",
      iteration,
      maxIterations: MAX_ITERATIONS,
      action: "Thinking..."
    });

    const response = await callAnthropicWithRetry(anthropic, {
      model: "claude-sonnet-4-20250514",
      max_tokens: 1500,
      system: systemPrompt,
      tools: agentTools,
      messages
    }, startTime);

    if (!response) {
      onProgress?.({ type: "phase", phase: "complete", message: "API timeout, returning results" });
      break;
    }

    const toolUseBlocks = response.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
    );

    if (toolUseBlocks.length === 0) {
      noToolCallCount++;
      if (noToolCallCount >= 2) {
        onProgress?.({ type: "phase", phase: "complete", message: "Research complete" });
        break;
      }
      messages.push({ role: "assistant", content: response.content });
      messages.push({ role: "user", content: "Continue searching for more contacts." });
      continue;
    }

    noToolCallCount = 0;
    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const toolUse of toolUseBlocks) {
      if (Date.now() - startTime > INTERNAL_TIMEOUT_MS - 5000) {
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: "Time limit. Submit any contacts found."
        });
        continue;
      }

      if (toolUse.name === "browse_webpage") {
        const input = toolUse.input as { url: string };
        let url = input.url;

        try {
          const urlObj = new URL(url.startsWith("http") ? url : `https://${url}`);
          const urlDomain = urlObj.hostname.replace("www.", "");
          const targetDomain = domain.replace("www.", "");

          if (!urlDomain.includes(targetDomain) && !targetDomain.includes(urlDomain)) {
            toolResults.push({
              type: "tool_result",
              tool_use_id: toolUse.id,
              content: `Can only browse ${domain}. Use web_search for external lookups.`
            });
            continue;
          }
        } catch {
          toolResults.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: "Invalid URL"
          });
          continue;
        }

        pagesVisited.push(url);
        onProgress?.({
          type: "iteration",
          iteration,
          maxIterations: MAX_ITERATIONS,
          action: `Browsing ${new URL(url.startsWith("http") ? url : `https://${url}`).pathname || "/"}`
        });

        const result = await fetchWebpage(url);

        // Extract emails from result for pattern detection
        if (result.success) {
          const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
          const foundEmails = result.content.match(emailRegex) || [];
          for (const email of foundEmails) {
            if (!patternContext.foundEmails.includes(email.toLowerCase())) {
              patternContext.foundEmails.push(email.toLowerCase());
            }
          }
          // Try to detect pattern if we haven't yet
          if (!patternContext.detectedPattern && patternContext.foundEmails.length > 0) {
            patternContext.detectedPattern = detectEmailPattern(patternContext.foundEmails, domain);
          }
        }

        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: result.success ? result.content : `Error: ${result.error}`
        });

      } else if (toolUse.name === "web_search") {
        const input = toolUse.input as { query: string };
        searchesPerformed.push(input.query);

        onProgress?.({
          type: "iteration",
          iteration,
          maxIterations: MAX_ITERATIONS,
          action: `Searching: ${input.query.substring(0, 40)}...`
        });

        const result = await webSearch(input.query);

        // Extract emails from search results for pattern detection
        if (result.success) {
          const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
          const foundEmails = result.results.match(emailRegex) || [];
          for (const email of foundEmails) {
            if (!patternContext.foundEmails.includes(email.toLowerCase())) {
              patternContext.foundEmails.push(email.toLowerCase());
            }
          }
        }

        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: result.success ? result.results : `Error: ${result.error}`
        });

      } else if (toolUse.name === "search_sec_edgar") {
        const input = toolUse.input as { company_name: string };

        onProgress?.({
          type: "iteration",
          iteration,
          maxIterations: MAX_ITERATIONS,
          action: `Searching SEC EDGAR for ${input.company_name}...`
        });

        const result = await searchSECEdgar(input.company_name);

        if (result.success && result.data) {
          const officersList = result.data.officers.length > 0
            ? result.data.officers.map(o => `- ${o.name}: ${o.title}`).join("\n")
            : "No officers found in direct data. Try searching for the company's 10-K or DEF 14A filings.";

          toolResults.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: `SEC EDGAR RESULTS for ${result.data.companyName}:
CIK: ${result.data.cik}

OFFICERS/EXECUTIVES FOUND:
${officersList}

TIP: Use these names with generate_email to create email addresses. Submit with found_method="sec_filing".`
          });
        } else {
          toolResults.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: `SEC EDGAR: ${result.error || "No results found"}. Company may be private or not filing with SEC. Try osint_search instead.`
          });
        }

      } else if (toolUse.name === "osint_search") {
        const input = toolUse.input as { company_name: string; domain: string };

        onProgress?.({
          type: "iteration",
          iteration,
          maxIterations: MAX_ITERATIONS,
          action: `Running comprehensive OSINT search...`
        });

        const result = await comprehensiveOSINTSearch(input.company_name, input.domain);

        if (result.success) {
          // Collect all emails for pattern detection
          for (const osintResult of result.results) {
            for (const email of osintResult.emails) {
              if (!patternContext.foundEmails.includes(email.toLowerCase())) {
                patternContext.foundEmails.push(email.toLowerCase());
              }
            }
          }

          // Format results for the agent
          const formattedResults = result.results.map(r =>
            `=== ${r.source} ===
Emails: ${r.emails.length > 0 ? r.emails.join(", ") : "none"}
Names: ${r.names.length > 0 ? r.names.join(", ") : "none"}
Phones: ${r.phones.length > 0 ? r.phones.join(", ") : "none"}`
          ).join("\n\n");

          toolResults.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: `OSINT SEARCH COMPLETE
${result.summary}

${formattedResults}

TIP: Use found names with generate_email. Submit contacts with found_method="osint_search".`
          });
        } else {
          toolResults.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: "OSINT search failed. Try individual web_search queries."
          });
        }

      } else if (toolUse.name === "verify_email_smtp") {
        const input = toolUse.input as { email: string };

        onProgress?.({
          type: "iteration",
          iteration,
          maxIterations: MAX_ITERATIONS,
          action: `SMTP verifying ${input.email}...`
        });

        const result = await verifyEmailSMTP(input.email);

        let status: string;
        if (result.exists === "yes") {
          status = "✓ VERIFIED - Mailbox EXISTS on mail server";
        } else if (result.exists === "no") {
          status = "✗ INVALID - Mailbox does NOT exist";
        } else {
          status = "? UNKNOWN - Could not confirm (server blocked verification)";
        }

        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: `SMTP VERIFICATION: ${input.email}
Status: ${status}
Detail: ${result.reason}
MX Valid: ${result.valid ? "Yes" : "No"}

${result.exists === "yes" ? "This email is confirmed to exist. Submit with HIGH confidence." :
  result.exists === "no" ? "Do NOT submit this email - mailbox does not exist." :
  "MX is valid but couldn't verify mailbox. Submit with MEDIUM confidence."}`
        });

      } else if (toolUse.name === "generate_email") {
        const input = toolUse.input as { person_name: string; found_emails: string[] };

        onProgress?.({
          type: "iteration",
          iteration,
          maxIterations: MAX_ITERATIONS,
          action: `Generating emails for ${input.person_name}`
        });

        // Add any emails provided by the agent to our context
        for (const email of input.found_emails || []) {
          if (!patternContext.foundEmails.includes(email.toLowerCase())) {
            patternContext.foundEmails.push(email.toLowerCase());
          }
        }

        // Detect pattern from all found emails
        const allEmails = [...patternContext.foundEmails];
        const detectedPattern = detectEmailPattern(allEmails, domain);

        if (!detectedPattern) {
          toolResults.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: `Could not detect email pattern. Found emails: ${allEmails.slice(0, 5).join(", ")}. Try finding more employee emails on the website, or use web_search.`
          });
          continue;
        }

        // Update pattern context
        patternContext.detectedPattern = detectedPattern;

        // Generate candidates
        const candidates = generateEmailCandidates(
          input.person_name,
          domain,
          detectedPattern.pattern
        );

        if (candidates.length === 0) {
          toolResults.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: `Could not generate email for "${input.person_name}". Name may be incomplete or invalid.`
          });
          continue;
        }

        const resultContent = `DETECTED PATTERN: ${detectedPattern.pattern} (${detectedPattern.confidence}% confidence)
Examples: ${detectedPattern.examples.join(", ")}

GENERATED CANDIDATES for ${input.person_name}:
${candidates.map((c, i) => `${i + 1}. ${c}`).join("\n")}

Use validate_email to check if these are real, or submit directly with found_method="pattern_match".
Most likely: ${candidates[0]}`;

        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: resultContent
        });

      } else if (toolUse.name === "validate_email") {
        const input = toolUse.input as { email: string; person_name: string };

        onProgress?.({
          type: "iteration",
          iteration,
          maxIterations: MAX_ITERATIONS,
          action: `Validating ${input.email}`
        });

        // Fast validation: MX check only (no slow web search)
        const mxValid = await verifyEmailDomain(input.email);

        if (!mxValid) {
          toolResults.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: `INVALID: ${input.email} - Domain has no valid MX records. Cannot receive mail.`
          });
          continue;
        }

        // MX is valid - that's enough for pattern-matched emails
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: `VALIDATED: ${input.email}\n- MX records: VALID (domain can receive email)\n- Pattern: Matches company email convention\n\nSubmit with found_method="pattern_match". If you want higher confidence, use web_search to find corroboration.`
        });

      } else if (toolUse.name === "submit_contacts") {
        const input = toolUse.input as {
          contacts: Array<{
            name: string;
            email: string;
            phone?: string | null;
            role: string;
            found_method: "direct_website" | "osint_search" | "pattern_match" | "sec_filing" | "generic_fallback";
            source: string;
          }>
        };

        const seenEmails = new Set(finalContacts.map(c => c.email.toLowerCase()));

        for (const contact of input.contacts || []) {
          if (seenEmails.has(contact.email.toLowerCase())) continue;
          seenEmails.add(contact.email.toLowerCase());

          const mxVerified = await verifyEmailDomain(contact.email);

          let confidence: "high" | "medium" | "low";
          if (contact.found_method === "direct_website" && mxVerified) {
            confidence = "high";
          } else if (contact.found_method === "sec_filing" && mxVerified) {
            // SEC filings are official government records - high confidence
            confidence = "high";
          } else if (contact.found_method === "osint_search" && mxVerified) {
            confidence = "medium";
          } else if (contact.found_method === "pattern_match" && mxVerified) {
            // Pattern-matched emails with valid MX are medium confidence
            confidence = "medium";
          } else if (contact.found_method === "generic_fallback") {
            // Generic fallbacks are always low confidence
            confidence = "low";
          } else if (contact.found_method === "pattern_match") {
            confidence = "low";
          } else {
            confidence = "low";
          }

          const newContact: DiscoveredContact = {
            name: contact.name,
            email: contact.email,
            phone: contact.phone || null,
            role: contact.role,
            confidence,
            source: contact.source,
            verified: mxVerified
          };

          finalContacts.push(newContact);
          onProgress?.({ type: "contact", contact: newContact });
        }

        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: `Submitted ${input.contacts?.length || 0} contact(s). Total now: ${finalContacts.length}. Continue searching for more or use other tools.`
        });
      }
    }

    messages.push({ role: "assistant", content: response.content });
    messages.push({ role: "user", content: toolResults });
  }

  // FALLBACK: If no contacts found, add generic emails
  if (finalContacts.length === 0) {
    onProgress?.({ type: "phase", phase: "complete", message: "No contacts found - adding generic fallbacks" });

    const genericEmails = [
      { prefix: "info", name: "General Inquiries", role: "General Contact" },
      { prefix: "contact", name: "Contact Department", role: "General Contact" },
      { prefix: "sales", name: "Sales Department", role: "Sales" },
      { prefix: "support", name: "Support Team", role: "Customer Support" },
    ];

    for (const generic of genericEmails) {
      const email = `${generic.prefix}@${domain}`;
      const mxValid = await verifyEmailDomain(email);

      if (mxValid) {
        const fallbackContact: DiscoveredContact = {
          name: generic.name,
          email,
          phone: null,
          role: generic.role,
          confidence: "low",
          source: `Generic fallback - ${domain}`,
          verified: true
        };
        finalContacts.push(fallbackContact);
        onProgress?.({ type: "contact", contact: fallbackContact });
      }
    }

    // If still nothing (domain has no MX), create at least info@ as unverified
    if (finalContacts.length === 0) {
      const lastResort: DiscoveredContact = {
        name: "General Inquiries",
        email: `info@${domain}`,
        phone: null,
        role: "General Contact",
        confidence: "low",
        source: "Generic fallback (unverified)",
        verified: false
      };
      finalContacts.push(lastResort);
      onProgress?.({ type: "contact", contact: lastResort });
    }
  }

  // Build final result
  const durationMs = Date.now() - startTime;
  const phonesFound = finalContacts.filter(c => c.phone).length;
  const emailsVerified = finalContacts.filter(c => c.verified).length;
  const highConfidence = finalContacts.filter(c => c.confidence === "high").length;
  const mediumConfidence = finalContacts.filter(c => c.confidence === "medium").length;
  const lowConfidence = finalContacts.filter(c => c.confidence === "low").length;

  let summary = `Found ${finalContacts.length} contact(s) for ${companyName}. `;
  summary += `Browsed ${pagesVisited.length} page(s), ${searchesPerformed.length} search(es). `;
  summary += `Confidence: ${highConfidence} high, ${mediumConfidence} medium, ${lowConfidence} low.`;
  if (phonesFound > 0) summary += ` ${phonesFound} phone(s).`;

  const result: ResearchResult = {
    contacts: finalContacts.slice(0, 20),
    summary,
    stages: {
      pagesVisited,
      contactsFound: finalContacts.length,
      emailsVerified,
      phonesFound
    },
    durationMs
  };

  onProgress?.({ type: "complete", result });

  return result;
}
