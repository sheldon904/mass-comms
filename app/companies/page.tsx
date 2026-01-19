import { prisma } from "@/lib/db";
import { FileUpload } from "@/components/file-upload";

export const dynamic = "force-dynamic";
import { CompanyCard } from "@/components/company-card";

async function getCompanies() {
  const companies = await prisma.company.findMany({
    include: {
      _count: {
        select: { contacts: true },
      },
      emails: {
        select: { status: true },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  return companies.map((company) => {
    const emailCounts = company.emails.reduce(
      (acc, email) => {
        acc[email.status as keyof typeof acc] =
          (acc[email.status as keyof typeof acc] || 0) + 1;
        return acc;
      },
      { draft: 0, approved: 0, sent: 0 } as Record<string, number>
    );

    return {
      id: company.id,
      name: company.name,
      contactCount: company._count.contacts,
      emailCounts: {
        draft: emailCounts.draft || 0,
        approved: emailCounts.approved || 0,
        sent: emailCounts.sent || 0,
      },
    };
  });
}

export default async function CompaniesPage() {
  const companies = await getCompanies();

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Companies</h1>
        <p className="text-muted-foreground">
          Upload research files and manage your target companies
        </p>
      </div>

      <div className="bg-card border rounded-lg p-6">
        <h2 className="text-lg font-semibold mb-4">Upload Research Files</h2>
        <FileUpload />
      </div>

      {companies.length > 0 ? (
        <div>
          <h2 className="text-lg font-semibold mb-4">
            Your Companies ({companies.length})
          </h2>
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {companies.map((company) => (
              <CompanyCard key={company.id} {...company} />
            ))}
          </div>
        </div>
      ) : (
        <div className="text-center py-12 text-muted-foreground">
          <p>No companies yet. Upload a research file to get started.</p>
        </div>
      )}
    </div>
  );
}
