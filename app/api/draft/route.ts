import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { draftEmail } from "@/lib/agent";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { companyId, contactId, purpose } = body;

    if (!companyId || !contactId || !purpose) {
      return NextResponse.json(
        { error: "Missing required fields" },
        { status: 400 }
      );
    }

    // Get company and contact data
    const company = await prisma.company.findUnique({
      where: { id: companyId },
    });

    const contact = await prisma.contact.findUnique({
      where: { id: contactId },
    });

    if (!company || !contact) {
      return NextResponse.json(
        { error: "Company or contact not found" },
        { status: 404 }
      );
    }

    // Generate email draft using Claude
    const draft = await draftEmail({
      companyName: company.name,
      companyResearch: company.research,
      contactName: contact.name,
      contactRole: contact.role,
      contactEmail: contact.email,
      purpose,
    });

    // Save the draft to the database
    const email = await prisma.email.create({
      data: {
        subject: draft.subject,
        body: draft.body,
        status: "draft",
        purpose,
        companyId,
        contactId,
      },
    });

    return NextResponse.json({ email });
  } catch (error) {
    console.error("Error drafting email:", error);
    return NextResponse.json(
      { error: "Failed to draft email" },
      { status: 500 }
    );
  }
}
