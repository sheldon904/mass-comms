import { notFound } from "next/navigation";
import Link from "next/link";
import { prisma } from "@/lib/db";
import { marked } from "marked";
import sanitizeHtml from "sanitize-html";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ContactForm } from "@/components/contact-form";
import { ContactResearch } from "@/components/contact-research";
import { ArrowLeft, Mail, FileText } from "lucide-react";

async function getCompany(id: string) {
  const company = await prisma.company.findUnique({
    where: { id },
    include: {
      contacts: {
        orderBy: { name: "asc" },
      },
      emails: {
        select: { status: true },
      },
    },
  });

  return company;
}

export default async function CompanyDetailPage({
  params,
}: {
  params: { id: string };
}) {
  const company = await getCompany(params.id);

  if (!company) {
    notFound();
  }

  const emailCounts = company.emails.reduce(
    (acc, email) => {
      acc[email.status as keyof typeof acc] =
        (acc[email.status as keyof typeof acc] || 0) + 1;
      return acc;
    },
    { draft: 0, approved: 0, sent: 0 } as Record<string, number>
  );

  const researchHtml = sanitizeHtml(await marked(company.research), {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat(['img']),
    allowedAttributes: {
      ...sanitizeHtml.defaults.allowedAttributes,
      img: ['src', 'alt', 'title'],
    },
  });

  return (
    <div className="space-y-8">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" asChild>
          <Link href="/companies">
            <ArrowLeft className="h-5 w-5" />
          </Link>
        </Button>
        <div>
          <h1 className="text-3xl font-bold tracking-tight">{company.name}</h1>
          <p className="text-muted-foreground">
            Uploaded from {company.filename}
          </p>
        </div>
      </div>

      <div className="flex gap-4">
        {emailCounts.draft > 0 && (
          <Badge variant="warning">{emailCounts.draft} draft emails</Badge>
        )}
        {emailCounts.approved > 0 && (
          <Badge variant="secondary">{emailCounts.approved} approved</Badge>
        )}
        {emailCounts.sent > 0 && (
          <Badge variant="success">{emailCounts.sent} sent</Badge>
        )}
      </div>

      <div className="grid gap-8 lg:grid-cols-3">
        <div className="lg:col-span-2 space-y-6">
          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <FileText className="h-5 w-5 text-muted-foreground" />
                <CardTitle>Company Research</CardTitle>
              </div>
              <CardDescription>
                Research document for personalized outreach
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div
                className="prose prose-sm max-w-none dark:prose-invert"
                dangerouslySetInnerHTML={{ __html: researchHtml }}
              />
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Contacts</CardTitle>
              <CardDescription>
                People to reach out to at this company
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ContactForm companyId={company.id} contacts={company.contacts} />
            </CardContent>
          </Card>

          <ContactResearch companyId={company.id} companyName={company.name} />

          <Card>
            <CardHeader>
              <CardTitle>Actions</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <Button asChild className="w-full" disabled={company.contacts.length === 0}>
                <Link href={`/companies/${company.id}/draft`}>
                  <Mail className="h-4 w-4 mr-2" />
                  Draft Emails
                </Link>
              </Button>
              {company.contacts.length === 0 && (
                <p className="text-xs text-muted-foreground text-center">
                  Add contacts to enable email drafting
                </p>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
