import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { parseResearchFile } from "@/lib/parse-research";

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const filename = formData.get("filename") as string;
    const content = formData.get("content") as string;

    if (!filename || !content) {
      return NextResponse.json(
        { error: "Missing filename or content" },
        { status: 400 }
      );
    }

    // Check if company with same filename already exists
    const existing = await prisma.company.findFirst({
      where: { filename },
    });

    if (existing) {
      // Update existing company
      const parsed = parseResearchFile(filename, content);
      const company = await prisma.company.update({
        where: { id: existing.id },
        data: {
          name: parsed.name,
          research: parsed.content,
          summary: parsed.summary,
        },
      });
      return NextResponse.json({ company, updated: true });
    }

    // Create new company
    const parsed = parseResearchFile(filename, content);
    const company = await prisma.company.create({
      data: {
        name: parsed.name,
        filename,
        research: parsed.content,
        summary: parsed.summary,
      },
    });

    return NextResponse.json({ company, created: true });
  } catch (error) {
    console.error("Upload error:", error);
    return NextResponse.json(
      { error: "Failed to upload file" },
      { status: 500 }
    );
  }
}
