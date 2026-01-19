import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { researchContacts } from "@/lib/contact-research-agent";

export const maxDuration = 60; // Allow up to 60 seconds for research

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { companyId } = body;

    if (!companyId) {
      return NextResponse.json(
        { error: "Company ID is required" },
        { status: 400 }
      );
    }

    // Get company data
    const company = await prisma.company.findUnique({
      where: { id: companyId },
    });

    if (!company) {
      return NextResponse.json(
        { error: "Company not found" },
        { status: 404 }
      );
    }

    // Extract domain from research if possible
    const domainMatch = company.research.match(
      /(?:website|domain|url|@)[:\s]*(?:https?:\/\/)?(?:www\.)?([a-zA-Z0-9-]+\.[a-zA-Z]{2,})/i
    );
    const companyDomain = domainMatch ? domainMatch[1] : undefined;

    // Run the research agent
    const result = await researchContacts({
      companyName: company.name,
      companyResearch: company.research,
      companyDomain,
    });

    return NextResponse.json({
      success: true,
      companyId,
      companyName: company.name,
      discoveredContacts: result.contacts,
      summary: result.summary,
      searchesPerformed: result.searchesPerformed,
    });
  } catch (error) {
    console.error("Error researching contacts:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to research contacts",
      },
      { status: 500 }
    );
  }
}
