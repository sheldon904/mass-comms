import matter from "gray-matter";

interface ParsedResearch {
  name: string;
  content: string;
  summary?: string;
}

export function parseResearchFile(
  filename: string,
  fileContent: string
): ParsedResearch {
  const { data: frontmatter, content } = matter(fileContent);

  // Try to get company name from frontmatter, or derive from filename
  let name = frontmatter.company || frontmatter.name || frontmatter.title;

  if (!name) {
    // Remove .md extension and convert dashes/underscores to spaces
    name = filename
      .replace(/\.md$/i, "")
      .replace(/[-_]/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  return {
    name,
    content: content.trim(),
    summary: frontmatter.summary,
  };
}
