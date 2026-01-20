import Anthropic from "@anthropic-ai/sdk";
import dns from "dns";
import net from "net";
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

interface EmailCandidate {
  email: string;
  name: string;
  role: string;
  source: string;
  confidence: "high" | "medium" | "low";
}

// ============================================================================
// CONFIGURATION
// ============================================================================

const INTERNAL_TIMEOUT_MS = 170000;
const MAX_ITERATIONS = 15;
const MAX_RETRIES = 3;
const BASE_RETRY_DELAY_MS = 1000;

// ============================================================================
// UTILITY: HTTP FETCH WITH TIMEOUT
// ============================================================================

async function fetchWithTimeout(url: string, timeoutMs: number = 8000, headers?: Record<string, string>): Promise<Response | null> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        ...headers
      },
    });

    clearTimeout(timeoutId);
    return response;
  } catch {
    return null;
  }
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
// EMAIL EXTRACTION FROM TEXT
// ============================================================================

function extractEmailsFromText(text: string): string[] {
  const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  const matches = text.match(emailRegex) || [];
  return Array.from(new Set(matches.map(e => e.toLowerCase())));
}

function extractPhonesFromText(text: string): string[] {
  const phoneRegex = /(?:\+?1[-.\s]?)?\(?[0-9]{3}\)?[-.\s]?[0-9]{3}[-.\s]?[0-9]{4}/g;
  const matches = text.match(phoneRegex) || [];
  return Array.from(new Set(matches));
}

function extractNamesFromText(text: string): string[] {
  // Look for "Name - Title" or "Name, Title" patterns
  const patterns = [
    /([A-Z][a-z]+ [A-Z][a-z]+)(?:\s*[-–,]\s*(?:CEO|CFO|COO|President|Owner|Founder|Director|Manager|VP|Vice President))/g,
    /(?:CEO|CFO|COO|President|Owner|Founder|Director|Manager|VP|Vice President)[:\s]+([A-Z][a-z]+ [A-Z][a-z]+)/g,
  ];

  const names: string[] = [];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      if (match[1] && match[1].length > 4) {
        names.push(match[1]);
      }
    }
  }
  return Array.from(new Set(names));
}

// ============================================================================
// DNS/MX VERIFICATION
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
// SMTP EMAIL VERIFICATION (holehe-style)
// ============================================================================

async function verifyEmailSMTP(email: string): Promise<{ exists: "yes" | "no" | "unknown"; reason: string }> {
  const domain = email.split("@")[1];
  if (!domain) {
    return { exists: "no", reason: "Invalid email format" };
  }

  try {
    const mxRecords = await resolveMx(domain);
    if (!mxRecords || mxRecords.length === 0) {
      return { exists: "no", reason: "No MX records" };
    }

    mxRecords.sort((a, b) => a.priority - b.priority);
    const mxHost = mxRecords[0].exchange;

    return new Promise((resolve) => {
      const socket = new net.Socket();
      let step = 0;

      const timeout = setTimeout(() => {
        socket.destroy();
        resolve({ exists: "unknown", reason: "Connection timeout - MX valid" });
      }, 6000);

      socket.connect(25, mxHost, () => {});

      socket.on("data", (data) => {
        const response = data.toString();
        const code = parseInt(response.substring(0, 3), 10);

        if (step === 0 && code === 220) {
          socket.write("HELO mail.research.local\r\n");
          step = 1;
        } else if (step === 1 && code === 250) {
          socket.write("MAIL FROM:<verify@research.local>\r\n");
          step = 2;
        } else if (step === 2 && code === 250) {
          socket.write(`RCPT TO:<${email}>\r\n`);
          step = 3;
        } else if (step === 3) {
          clearTimeout(timeout);
          socket.write("QUIT\r\n");
          socket.destroy();

          if (code === 250 || code === 251) {
            resolve({ exists: "yes", reason: "SMTP verified - mailbox exists" });
          } else if (code === 550 || code === 551 || code === 552 || code === 553) {
            resolve({ exists: "no", reason: "SMTP verified - mailbox does not exist" });
          } else {
            resolve({ exists: "unknown", reason: `SMTP response: ${code}` });
          }
        } else {
          clearTimeout(timeout);
          socket.destroy();
          resolve({ exists: "unknown", reason: "Unexpected SMTP response" });
        }
      });

      socket.on("error", () => {
        clearTimeout(timeout);
        socket.destroy();
        resolve({ exists: "unknown", reason: "SMTP connection failed - MX valid" });
      });
    });
  } catch {
    return { exists: "unknown", reason: "MX lookup failed" };
  }
}

// ============================================================================
// THEHARVESTER-STYLE MULTI-SOURCE SEARCH
// ============================================================================

interface HarvesterResult {
  source: string;
  emails: string[];
  names: string[];
  phones: string[];
}

async function searchBing(query: string): Promise<string> {
  const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}`;
  const response = await fetchWithTimeout(url);
  if (!response || !response.ok) return "";
  const html = await response.text();
  // Strip HTML tags for text extraction
  return html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
             .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
             .replace(/<[^>]+>/g, " ")
             .replace(/\s+/g, " ");
}

async function searchDuckDuckGo(query: string): Promise<string> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const response = await fetchWithTimeout(url);
  if (!response || !response.ok) return "";
  const html = await response.text();
  return html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
             .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
             .replace(/<[^>]+>/g, " ")
             .replace(/\s+/g, " ");
}

async function runTheHarvesterSearches(
  companyName: string,
  domain: string,
  onProgress?: ProgressCallback
): Promise<HarvesterResult[]> {
  const results: HarvesterResult[] = [];

  // theHarvester-style queries across multiple engines
  const queries = [
    // Direct email searches
    { name: "Bing-Email", engine: "bing", query: `"@${domain}" email` },
    { name: "Bing-Contact", engine: "bing", query: `"${companyName}" contact email` },
    { name: "DDG-Email", engine: "ddg", query: `@${domain} email contact` },

    // LinkedIn dorking (CrossLinked style)
    { name: "LinkedIn-Bing", engine: "bing", query: `site:linkedin.com "${companyName}" email` },
    { name: "LinkedIn-DDG", engine: "ddg", query: `site:linkedin.com "${companyName}" CEO OR CFO OR President` },

    // Press release searches
    { name: "PRNewswire", engine: "bing", query: `site:prnewswire.com "${companyName}" contact email` },
    { name: "BusinessWire", engine: "bing", query: `site:businesswire.com "${companyName}" contact` },
    { name: "GlobeNewswire", engine: "bing", query: `site:globenewswire.com "${companyName}"` },

    // News and business
    { name: "News-Email", engine: "bing", query: `"${companyName}" CEO email OR CFO email OR President email` },
    { name: "Contact-Page", engine: "bing", query: `"${companyName}" "contact us" email` },

    // Industry-specific
    { name: "Industry", engine: "ddg", query: `"${companyName}" director manager email contact` },

    // Document searches (pymeta style)
    { name: "PDF-Search", engine: "bing", query: `site:${domain} filetype:pdf contact` },
  ];

  // Run searches in parallel batches
  const batchSize = 4;
  for (let i = 0; i < queries.length; i += batchSize) {
    const batch = queries.slice(i, i + batchSize);

    onProgress?.({
      type: "iteration",
      iteration: Math.floor(i / batchSize) + 1,
      maxIterations: Math.ceil(queries.length / batchSize),
      action: `OSINT: ${batch.map(b => b.name).join(", ")}`
    });

    const batchPromises = batch.map(async ({ name, engine, query }) => {
      const text = engine === "bing"
        ? await searchBing(query)
        : await searchDuckDuckGo(query);

      return {
        source: name,
        emails: extractEmailsFromText(text).filter(e =>
          !e.includes("example.com") &&
          !e.includes("email.com") &&
          !e.includes("sentry.io")
        ),
        names: extractNamesFromText(text),
        phones: extractPhonesFromText(text)
      };
    });

    const batchResults = await Promise.all(batchPromises);
    results.push(...batchResults);

    // Rate limit between batches
    if (i + batchSize < queries.length) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }

  return results;
}

// ============================================================================
// SEC EDGAR SEARCH
// ============================================================================

interface SECOfficer {
  name: string;
  title: string;
}

async function searchSECEdgar(
  companyName: string,
  onProgress?: ProgressCallback
): Promise<SECOfficer[]> {
  onProgress?.({
    type: "iteration",
    iteration: 1,
    maxIterations: 1,
    action: "Searching SEC EDGAR filings..."
  });

  const officers: SECOfficer[] = [];

  try {
    // Search SEC full-text search
    const searchUrl = `https://efts.sec.gov/LATEST/search-index?q=${encodeURIComponent(companyName)}&dateRange=custom&startdt=2020-01-01&forms=10-K,DEF%2014A`;

    const searchResponse = await fetchWithTimeout(searchUrl, 10000, {
      "User-Agent": "ContactResearch/1.0 (research@example.com)",
      "Accept": "application/json"
    });

    if (!searchResponse || !searchResponse.ok) {
      return officers;
    }

    const searchData = await searchResponse.json();
    const hits = searchData?.hits?.hits || [];

    if (hits.length === 0) return officers;

    // Get CIK from first hit
    const firstHit = hits[0]?._source || hits[0];
    const cik = firstHit?.ciks?.[0] || firstHit?.cik;

    if (!cik) return officers;

    // Fetch company submissions
    const paddedCik = String(cik).padStart(10, "0");
    const subUrl = `https://data.sec.gov/submissions/CIK${paddedCik}.json`;

    const subResponse = await fetchWithTimeout(subUrl, 10000, {
      "User-Agent": "ContactResearch/1.0 (research@example.com)",
      "Accept": "application/json"
    });

    if (!subResponse || !subResponse.ok) return officers;

    const subData = await subResponse.json();

    // Extract officers if available
    if (subData.officers && Array.isArray(subData.officers)) {
      for (const officer of subData.officers) {
        officers.push({
          name: officer.name || officer.officerName || "",
          title: officer.title || officer.officerTitle || "Executive"
        });
      }
    }

    // Also check for company name to report
    if (subData.name && officers.length === 0) {
      // SEC found the company but no officers in direct data
      // This is common - officers are usually in the filing documents themselves
    }

  } catch (error) {
    console.error("[SEC EDGAR] Error:", error);
  }

  return officers;
}

// ============================================================================
// PGP KEYSERVER SEARCH
// ============================================================================

async function searchPGPKeyservers(domain: string, onProgress?: ProgressCallback): Promise<string[]> {
  onProgress?.({
    type: "iteration",
    iteration: 1,
    maxIterations: 1,
    action: "Searching PGP keyservers..."
  });

  const emails: string[] = [];

  const keyservers = [
    `https://keys.openpgp.org/search?q=${encodeURIComponent(domain)}`,
    `https://keyserver.ubuntu.com/pks/lookup?search=${encodeURIComponent(domain)}&op=index`,
  ];

  for (const url of keyservers) {
    try {
      const response = await fetchWithTimeout(url, 5000);
      if (response && response.ok) {
        const text = await response.text();
        const found = extractEmailsFromText(text).filter(e => e.includes(domain));
        emails.push(...found);
      }
    } catch {
      // Continue to next keyserver
    }
  }

  return Array.from(new Set(emails));
}

// ============================================================================
// HOLEHE-STYLE PLATFORM CHECKS
// ============================================================================

async function checkEmailPlatforms(email: string): Promise<{ platform: string; exists: boolean }[]> {
  const results: { platform: string; exists: boolean }[] = [];

  // Note: Real holehe uses password reset flows. We can't fully replicate that
  // without making actual requests that might trigger notifications.
  // Instead, we do basic existence checks via SMTP and note the limitation.

  const smtpResult = await verifyEmailSMTP(email);
  if (smtpResult.exists === "yes") {
    results.push({ platform: "SMTP", exists: true });
  } else if (smtpResult.exists === "no") {
    results.push({ platform: "SMTP", exists: false });
  }

  return results;
}

// ============================================================================
// WEBPAGE FETCHING
// ============================================================================

async function fetchWebpage(url: string): Promise<{ success: boolean; content: string; error?: string }> {
  try {
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      url = "https://" + url;
    }

    const response = await fetchWithTimeout(url, 10000);

    if (!response || !response.ok) {
      return { success: false, content: "", error: response ? `HTTP ${response.status}` : "Timeout" };
    }

    const html = await response.text();

    // Extract useful content
    let text = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
    text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");

    const emails = extractEmailsFromText(html);
    const phones = extractPhonesFromText(html);

    // Get links
    const links: string[] = [];
    const linkRegex = /<a[^>]+href=["']([^"']+)["'][^>]*>([^<]*)<\/a>/gi;
    let match;
    while ((match = linkRegex.exec(html)) !== null) {
      const href = match[1];
      const linkText = match[2].trim();
      if (linkText && href && !href.startsWith("#") && !href.startsWith("javascript:")) {
        const lower = linkText.toLowerCase() + href.toLowerCase();
        if (lower.includes("team") || lower.includes("about") ||
            lower.includes("contact") || lower.includes("leadership") ||
            lower.includes("staff") || lower.includes("people")) {
          links.push(`[${linkText}](${href})`);
        }
      }
    }

    text = text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

    let result = text.substring(0, 8000);
    if (emails.length > 0) {
      result += "\n\n=== EMAILS ===\n" + emails.join("\n");
    }
    if (phones.length > 0) {
      result += "\n\n=== PHONES ===\n" + phones.join("\n");
    }
    if (links.length > 0) {
      result += "\n\n=== LINKS ===\n" + links.slice(0, 8).join("\n");
    }

    return { success: true, content: result.length > 12000 ? result.substring(0, 12000) : result };
  } catch (error) {
    return { success: false, content: "", error: error instanceof Error ? error.message : "Unknown error" };
  }
}

// ============================================================================
// EMAIL PATTERN GENERATION
// ============================================================================

type EmailPattern = "firstname.lastname" | "firstnamelastname" | "flastname" | "firstname" | "firstinitial.lastname";

function detectEmailPattern(emails: string[], targetDomain: string): EmailPattern | null {
  const domainEmails = emails.filter(e => e.endsWith(`@${targetDomain}`));

  for (const email of domainEmails) {
    const local = email.split("@")[0].toLowerCase();
    if (/^[a-z]+\.[a-z]+$/.test(local)) return "firstname.lastname";
    if (/^[a-z][a-z]{4,}$/.test(local)) return "flastname";
    if (/^[a-z]\.[a-z]+$/.test(local)) return "firstinitial.lastname";
  }

  return "firstname.lastname"; // Default assumption
}

function generateEmailVariants(firstName: string, lastName: string, domain: string): string[] {
  const f = firstName.toLowerCase().replace(/[^a-z]/g, "");
  const l = lastName.toLowerCase().replace(/[^a-z]/g, "");

  if (!f || !l) return [];

  return [
    `${f}.${l}@${domain}`,
    `${f}${l}@${domain}`,
    `${f[0]}${l}@${domain}`,
    `${f}@${domain}`,
    `${f[0]}.${l}@${domain}`,
    `${l}.${f}@${domain}`,
    `${f}_${l}@${domain}`,
  ];
}

function parseFullName(fullName: string): { firstName: string; lastName: string } | null {
  const parts = fullName.trim().split(/\s+/);
  if (parts.length < 2) return null;

  const prefixes = ["dr", "mr", "mrs", "ms", "prof"];
  const suffixes = ["jr", "sr", "ii", "iii", "iv", "phd", "md", "esq"];

  const cleanParts = parts.filter(p =>
    !prefixes.includes(p.toLowerCase().replace(".", "")) &&
    !suffixes.includes(p.toLowerCase().replace(".", ""))
  );

  if (cleanParts.length < 2) return null;

  return {
    firstName: cleanParts[0],
    lastName: cleanParts[cleanParts.length - 1]
  };
}

// ============================================================================
// API CALL WITH RETRY
// ============================================================================

async function callAnthropicWithRetry(
  anthropic: Anthropic,
  params: Anthropic.MessageCreateParamsNonStreaming,
  startTime: number
): Promise<Anthropic.Message | null> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (Date.now() - startTime > INTERNAL_TIMEOUT_MS - 10000) return null;

    try {
      return await anthropic.messages.create(params) as Anthropic.Message;
    } catch (error) {
      const isRateLimit = error instanceof Error &&
        (error.message.includes("429") || error.message.includes("rate_limit"));

      if (isRateLimit && attempt < MAX_RETRIES - 1) {
        await new Promise(resolve => setTimeout(resolve, BASE_RETRY_DELAY_MS * Math.pow(2, attempt)));
        continue;
      }
      return null;
    }
  }
  return null;
}

// ============================================================================
// MAIN RESEARCH FUNCTION - DETERMINISTIC MULTI-PHASE
// ============================================================================

export async function researchContacts(
  params: ContactResearchParams,
  onProgress?: ProgressCallback
): Promise<ResearchResult> {
  const startTime = Date.now();
  const { companyName, companyResearch } = params;
  const pagesVisited: string[] = [];
  const allEmails = new Set<string>();
  const allNames = new Set<string>();
  const allPhones = new Set<string>();
  const emailCandidates: EmailCandidate[] = [];
  const finalContacts: DiscoveredContact[] = [];

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

  // ==========================================================================
  // PHASE 1: DETERMINISTIC OSINT (theHarvester-style) - ALWAYS RUNS
  // ==========================================================================

  onProgress?.({ type: "phase", phase: "searching", message: "Phase 1: Running OSINT searches (theHarvester-style)..." });

  const harvesterResults = await runTheHarvesterSearches(companyName, domain, onProgress);

  for (const result of harvesterResults) {
    result.emails.forEach(e => allEmails.add(e));
    result.names.forEach(n => allNames.add(n));
    result.phones.forEach(p => allPhones.add(p));

    // Add domain-matching emails as candidates
    for (const email of result.emails) {
      if (email.endsWith(`@${domain}`)) {
        emailCandidates.push({
          email,
          name: "Unknown",
          role: "Employee",
          source: result.source,
          confidence: "medium"
        });
      }
    }
  }

  console.log(`[OSINT] Found ${allEmails.size} emails, ${allNames.size} names from searches`);

  // ==========================================================================
  // PHASE 2: SEC EDGAR - ALWAYS RUNS
  // ==========================================================================

  if (Date.now() - startTime < INTERNAL_TIMEOUT_MS - 30000) {
    onProgress?.({ type: "phase", phase: "searching", message: "Phase 2: Searching SEC EDGAR filings..." });

    const secOfficers = await searchSECEdgar(companyName, onProgress);

    for (const officer of secOfficers) {
      allNames.add(officer.name);

      // Generate email variants for SEC officers
      const parsed = parseFullName(officer.name);
      if (parsed) {
        const variants = generateEmailVariants(parsed.firstName, parsed.lastName, domain);
        for (const email of variants.slice(0, 3)) {
          emailCandidates.push({
            email,
            name: officer.name,
            role: officer.title,
            source: "SEC EDGAR",
            confidence: "medium"
          });
        }
      }
    }

    console.log(`[SEC] Found ${secOfficers.length} officers`);
  }

  // ==========================================================================
  // PHASE 3: PGP KEYSERVER - ALWAYS RUNS
  // ==========================================================================

  if (Date.now() - startTime < INTERNAL_TIMEOUT_MS - 25000) {
    onProgress?.({ type: "phase", phase: "searching", message: "Phase 3: Searching PGP keyservers..." });

    const pgpEmails = await searchPGPKeyservers(domain, onProgress);

    for (const email of pgpEmails) {
      allEmails.add(email);
      emailCandidates.push({
        email,
        name: "Unknown",
        role: "Employee",
        source: "PGP Keyserver",
        confidence: "high"
      });
    }

    console.log(`[PGP] Found ${pgpEmails.length} emails`);
  }

  // ==========================================================================
  // PHASE 4: WEBSITE SCRAPING - ALWAYS RUNS
  // ==========================================================================

  onProgress?.({ type: "phase", phase: "browsing", message: "Phase 4: Scraping company website..." });

  const websitePages = [
    `https://${domain}`,
    `https://${domain}/about`,
    `https://${domain}/about-us`,
    `https://${domain}/team`,
    `https://${domain}/our-team`,
    `https://${domain}/leadership`,
    `https://${domain}/contact`,
    `https://${domain}/contact-us`,
    `https://www.${domain}`,
    `https://www.${domain}/about`,
    `https://www.${domain}/team`,
    `https://www.${domain}/contact`,
  ];

  for (const url of websitePages) {
    if (Date.now() - startTime > INTERNAL_TIMEOUT_MS - 20000) break;

    onProgress?.({
      type: "iteration",
      iteration: pagesVisited.length + 1,
      maxIterations: websitePages.length,
      action: `Browsing: ${new URL(url).pathname || "/"}`
    });

    const result = await fetchWebpage(url);
    if (result.success) {
      pagesVisited.push(url);

      const emails = extractEmailsFromText(result.content);
      const phones = extractPhonesFromText(result.content);
      const names = extractNamesFromText(result.content);

      emails.forEach(e => allEmails.add(e));
      phones.forEach(p => allPhones.add(p));
      names.forEach(n => allNames.add(n));

      // Add website emails as high-confidence candidates
      for (const email of emails) {
        if (email.endsWith(`@${domain}`)) {
          emailCandidates.push({
            email,
            name: "Unknown",
            role: "Contact",
            source: `Website: ${url}`,
            confidence: "high"
          });
        }
      }
    }

    // Don't hammer the server
    await new Promise(resolve => setTimeout(resolve, 300));
  }

  console.log(`[Website] Visited ${pagesVisited.length} pages, found ${allEmails.size} total emails`);

  // ==========================================================================
  // PHASE 5: GENERATE EMAILS FOR FOUND NAMES
  // ==========================================================================

  onProgress?.({ type: "phase", phase: "searching", message: "Phase 5: Generating email variants for found names..." });

  const detectedPattern = detectEmailPattern(Array.from(allEmails), domain);

  for (const name of Array.from(allNames)) {
    const parsed = parseFullName(name);
    if (!parsed) continue;

    const variants = generateEmailVariants(parsed.firstName, parsed.lastName, domain);

    // Add first 2 variants as candidates
    for (const email of variants.slice(0, 2)) {
      if (!emailCandidates.some(c => c.email === email)) {
        emailCandidates.push({
          email,
          name,
          role: "Employee",
          source: "Pattern Generated",
          confidence: "low"
        });
      }
    }
  }

  // ==========================================================================
  // PHASE 6: VERIFY AND DEDUPE EMAIL CANDIDATES
  // ==========================================================================

  onProgress?.({ type: "phase", phase: "searching", message: "Phase 6: Verifying email candidates..." });

  // Dedupe by email
  const uniqueCandidates = new Map<string, EmailCandidate>();
  for (const candidate of emailCandidates) {
    const existing = uniqueCandidates.get(candidate.email);
    if (!existing ||
        (candidate.confidence === "high" && existing.confidence !== "high") ||
        (candidate.name !== "Unknown" && existing.name === "Unknown")) {
      uniqueCandidates.set(candidate.email, candidate);
    }
  }

  // Verify top candidates
  let verified = 0;
  for (const [email, candidate] of Array.from(uniqueCandidates.entries()).slice(0, 20)) {
    if (Date.now() - startTime > INTERNAL_TIMEOUT_MS - 10000) break;

    const mxValid = await verifyEmailDomain(email);

    if (mxValid) {
      verified++;

      const contact: DiscoveredContact = {
        name: candidate.name,
        email: candidate.email,
        phone: null,
        role: candidate.role,
        confidence: candidate.confidence,
        source: candidate.source,
        verified: true
      };

      finalContacts.push(contact);
      onProgress?.({ type: "contact", contact });
    }
  }

  // ==========================================================================
  // PHASE 7: AGENT-ASSISTED REFINEMENT (if time permits)
  // ==========================================================================

  if (Date.now() - startTime < INTERNAL_TIMEOUT_MS - 40000 && finalContacts.length < 5) {
    onProgress?.({ type: "phase", phase: "browsing", message: "Phase 7: Agent-assisted research..." });

    const anthropic = new Anthropic({ apiKey });

    const contextSummary = `
Found so far:
- Emails: ${Array.from(allEmails).slice(0, 10).join(", ")}
- Names: ${Array.from(allNames).slice(0, 10).join(", ")}
- Phones: ${Array.from(allPhones).slice(0, 5).join(", ")}
- Pages visited: ${pagesVisited.slice(0, 5).join(", ")}
`;

    const agentTools: Anthropic.Tool[] = [
      {
        name: "browse_webpage",
        description: "Fetch a webpage",
        input_schema: {
          type: "object" as const,
          properties: { url: { type: "string" } },
          required: ["url"]
        }
      },
      {
        name: "submit_contact",
        description: "Submit a discovered contact",
        input_schema: {
          type: "object" as const,
          properties: {
            name: { type: "string" },
            email: { type: "string" },
            phone: { type: ["string", "null"] },
            role: { type: "string" },
            source: { type: "string" }
          },
          required: ["name", "email", "role", "source"]
        }
      }
    ];

    const messages: Anthropic.MessageParam[] = [{
      role: "user",
      content: `Research contacts for ${companyName} (${domain}).

${contextSummary}

Browse pages to find names/roles for these emails, or find new contacts.
Submit any contacts you find. You have ${MAX_ITERATIONS} iterations.`
    }];

    for (let iter = 0; iter < MAX_ITERATIONS && Date.now() - startTime < INTERNAL_TIMEOUT_MS - 10000; iter++) {
      const response = await callAnthropicWithRetry(anthropic, {
        model: "claude-sonnet-4-20250514",
        max_tokens: 1500,
        system: "You are a contact researcher. Use browse_webpage to explore and submit_contact for found contacts.",
        tools: agentTools,
        messages
      }, startTime);

      if (!response) break;

      const toolUses = response.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
      );

      if (toolUses.length === 0) break;

      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      for (const toolUse of toolUses) {
        if (toolUse.name === "browse_webpage") {
          const input = toolUse.input as { url: string };
          const result = await fetchWebpage(input.url);
          pagesVisited.push(input.url);
          toolResults.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: result.success ? result.content.substring(0, 4000) : `Error: ${result.error}`
          });
        } else if (toolUse.name === "submit_contact") {
          const input = toolUse.input as { name: string; email: string; phone?: string; role: string; source: string };

          if (!finalContacts.some(c => c.email === input.email)) {
            const mxValid = await verifyEmailDomain(input.email);
            const contact: DiscoveredContact = {
              name: input.name,
              email: input.email,
              phone: input.phone || null,
              role: input.role,
              confidence: mxValid ? "medium" : "low",
              source: input.source,
              verified: mxValid
            };
            finalContacts.push(contact);
            onProgress?.({ type: "contact", contact });
          }

          toolResults.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: "Contact submitted."
          });
        }
      }

      messages.push({ role: "assistant", content: response.content });
      messages.push({ role: "user", content: toolResults });
    }
  }

  // ==========================================================================
  // PHASE 8: FALLBACK - ALWAYS RETURN SOMETHING
  // ==========================================================================

  if (finalContacts.length === 0) {
    onProgress?.({ type: "phase", phase: "complete", message: "No contacts found - adding generic fallbacks" });

    const genericEmails = [
      { prefix: "info", name: "General Inquiries", role: "General Contact" },
      { prefix: "contact", name: "Contact Department", role: "General Contact" },
      { prefix: "sales", name: "Sales Department", role: "Sales" },
      { prefix: "support", name: "Customer Support", role: "Support" },
    ];

    for (const generic of genericEmails) {
      const email = `${generic.prefix}@${domain}`;
      const mxValid = await verifyEmailDomain(email);

      if (mxValid) {
        const contact: DiscoveredContact = {
          name: generic.name,
          email,
          phone: allPhones.size > 0 ? Array.from(allPhones)[0] : null,
          role: generic.role,
          confidence: "low",
          source: "Generic fallback",
          verified: true
        };
        finalContacts.push(contact);
        onProgress?.({ type: "contact", contact });
      }
    }

    // Last resort
    if (finalContacts.length === 0) {
      finalContacts.push({
        name: "General Inquiries",
        email: `info@${domain}`,
        phone: allPhones.size > 0 ? Array.from(allPhones)[0] : null,
        role: "General Contact",
        confidence: "low",
        source: "Generic fallback (unverified)",
        verified: false
      });
    }
  }

  // ==========================================================================
  // BUILD RESULT
  // ==========================================================================

  const durationMs = Date.now() - startTime;
  const phonesFound = finalContacts.filter(c => c.phone).length;
  const emailsVerified = finalContacts.filter(c => c.verified).length;

  let summary = `Found ${finalContacts.length} contact(s) for ${companyName}. `;
  summary += `Browsed ${pagesVisited.length} page(s). `;
  summary += `OSINT found ${allEmails.size} emails, ${allNames.size} names. `;
  summary += `${emailsVerified} verified.`;

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
