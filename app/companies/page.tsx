import { prisma } from "@/lib/db";
import { FileUpload } from "@/components/file-upload";

export const dynamic = "force-dynamic";
import { CompanyCard } from "@/components/company-card";

async function getCompanies() {
  // Use filtered _count to avoid fetching all email rows
  const companies = await prisma.company.findMany({
    include: {
      _count: {
        select: {
          contacts: true,
          emails: true,
        },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  // Get email counts by status using groupBy (more efficient than fetching all rows)
  const emailCounts = await prisma.email.groupBy({
    by: ["companyId", "status"],
    _count: { status: true },
  });

  // Build a map of company -> status -> count
  const countMap = new Map<string, Record<string, number>>();
  for (const row of emailCounts) {
    if (!countMap.has(row.companyId)) {
      countMap.set(row.companyId, { draft: 0, approved: 0, sent: 0 });
    }
    const counts = countMap.get(row.companyId)!;
    counts[row.status] = row._count.status;
  }

  return companies.map((company) => {
    const counts = countMap.get(company.id) || { draft: 0, approved: 0, sent: 0 };

    return {
      id: company.id,
      name: company.name,
      contactCount: company._count.contacts,
      emailCounts: {
        draft: counts.draft || 0,
        approved: counts.approved || 0,
        sent: counts.sent || 0,
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
