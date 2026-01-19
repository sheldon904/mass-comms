"use client";

import { useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Upload, FileText, X, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface UploadedFile {
  name: string;
  status: "pending" | "uploading" | "success" | "error";
  error?: string;
}

export function FileUpload() {
  const [files, setFiles] = useState<UploadedFile[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const router = useRouter();

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);

    const droppedFiles = Array.from(e.dataTransfer.files).filter((file) =>
      file.name.endsWith(".md")
    );

    if (droppedFiles.length === 0) {
      return;
    }

    setFiles((prev) => [
      ...prev,
      ...droppedFiles.map((f) => ({ name: f.name, status: "pending" as const })),
    ]);

    uploadFiles(droppedFiles);
  }, []);

  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const selectedFiles = Array.from(e.target.files || []).filter((file) =>
        file.name.endsWith(".md")
      );

      if (selectedFiles.length === 0) {
        return;
      }

      setFiles((prev) => [
        ...prev,
        ...selectedFiles.map((f) => ({
          name: f.name,
          status: "pending" as const,
        })),
      ]);

      uploadFiles(selectedFiles);
    },
    []
  );

  const uploadFiles = async (filesToUpload: File[]) => {
    setIsUploading(true);

    for (const file of filesToUpload) {
      setFiles((prev) =>
        prev.map((f) =>
          f.name === file.name ? { ...f, status: "uploading" } : f
        )
      );

      try {
        const content = await file.text();
        const formData = new FormData();
        formData.append("filename", file.name);
        formData.append("content", content);

        const response = await fetch("/api/upload", {
          method: "POST",
          body: formData,
        });

        if (!response.ok) {
          const error = await response.json();
          throw new Error(error.error || "Upload failed");
        }

        setFiles((prev) =>
          prev.map((f) =>
            f.name === file.name ? { ...f, status: "success" } : f
          )
        );
      } catch (error) {
        setFiles((prev) =>
          prev.map((f) =>
            f.name === file.name
              ? {
                  ...f,
                  status: "error",
                  error: error instanceof Error ? error.message : "Upload failed",
                }
              : f
          )
        );
      }
    }

    setIsUploading(false);
    router.refresh();
  };

  const removeFile = (name: string) => {
    setFiles((prev) => prev.filter((f) => f.name !== name));
  };

  return (
    <div className="space-y-4">
      <div
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={cn(
          "border-2 border-dashed rounded-lg p-8 text-center transition-colors",
          isDragging
            ? "border-primary bg-primary/5"
            : "border-muted-foreground/25 hover:border-muted-foreground/50"
        )}
      >
        <Upload className="mx-auto h-12 w-12 text-muted-foreground" />
        <p className="mt-4 text-sm text-muted-foreground">
          Drag and drop .md files here, or{" "}
          <label className="text-primary cursor-pointer hover:underline">
            browse
            <input
              type="file"
              multiple
              accept=".md"
              onChange={handleFileSelect}
              className="hidden"
            />
          </label>
        </p>
        <p className="mt-2 text-xs text-muted-foreground">
          Upload company research files in Markdown format
        </p>
      </div>

      {files.length > 0 && (
        <div className="space-y-2">
          {files.map((file) => (
            <div
              key={file.name}
              className="flex items-center justify-between p-3 bg-muted rounded-lg"
            >
              <div className="flex items-center gap-3">
                <FileText className="h-5 w-5 text-muted-foreground" />
                <div>
                  <p className="text-sm font-medium">{file.name}</p>
                  {file.error && (
                    <p className="text-xs text-destructive">{file.error}</p>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2">
                {file.status === "uploading" && (
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                )}
                {file.status === "success" && (
                  <span className="text-xs text-green-600">Uploaded</span>
                )}
                {file.status === "error" && (
                  <span className="text-xs text-destructive">Failed</span>
                )}
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  onClick={() => removeFile(file.name)}
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
