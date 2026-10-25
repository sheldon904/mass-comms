import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { prisma } from "@/lib/db";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { DraftForm } from "@/components/draft-form";
import { ArrowLeft } from "lucide-react";

async function getCompany(id: string) {
  const company = await prisma.company.findUnique({
    where: { id },
    include: {
      contacts: {
        orderBy: { name: "asc" },
      },
    },
  });

  return company;
}

export default async function DraftPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const company = await getCompany(id);

  if (!company) {
    notFound();
  }

  if (company.contacts.length === 0) {
    redirect(`/companies/${id}`);
  }

  return (
    <div className="space-y-8">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" asChild>
          <Link href={`/companies/${id}`}>
            <ArrowLeft className="h-5 w-5" />
          </Link>
        </Button>
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Draft Emails</h1>
          <p className="text-muted-foreground">
            Generate personalized emails for {company.name}
          </p>
        </div>
      </div>

      <div className="max-w-2xl">
        <Card>
          <CardHeader>
            <CardTitle>Email Campaign</CardTitle>
            <CardDescription>
              Describe the purpose of your outreach and Claude will draft
              personalized emails for each contact
            </CardDescription>
          </CardHeader>
          <CardContent>
            <DraftForm
              companyId={company.id}
              companyName={company.name}
              contacts={company.contacts}
            />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
