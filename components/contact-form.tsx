"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Plus, Trash2, Pencil, X, Check, Phone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface Contact {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  role: string | null;
}

interface ContactFormProps {
  companyId: string;
  contacts: Contact[];
}

export function ContactForm({ companyId, contacts }: ContactFormProps) {
  const [localContacts, setLocalContacts] = useState(contacts);
  const [isAdding, setIsAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const router = useRouter();

  const [newContact, setNewContact] = useState({
    name: "",
    email: "",
    phone: "",
    role: "",
  });

  const [editContact, setEditContact] = useState({
    name: "",
    email: "",
    phone: "",
    role: "",
  });

  const handleAddContact = async () => {
    if (!newContact.name || !newContact.email) return;

    setIsLoading(true);
    try {
      const response = await fetch("/api/contacts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...newContact,
          phone: newContact.phone || null,
          companyId,
        }),
      });

      if (!response.ok) throw new Error("Failed to add contact");

      const { contact } = await response.json();
      setLocalContacts((prev) => [...prev, contact]);
      setNewContact({ name: "", email: "", phone: "", role: "" });
      setIsAdding(false);
      router.refresh();
    } catch (error) {
      console.error("Error adding contact:", error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleEditContact = async (id: string) => {
    if (!editContact.name || !editContact.email) return;

    setIsLoading(true);
    try {
      const response = await fetch(`/api/contacts/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...editContact,
          phone: editContact.phone || null,
        }),
      });

      if (!response.ok) throw new Error("Failed to update contact");

      const { contact } = await response.json();
      setLocalContacts((prev) =>
        prev.map((c) => (c.id === id ? contact : c))
      );
      setEditingId(null);
      router.refresh();
    } catch (error) {
      console.error("Error updating contact:", error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleDeleteContact = async (id: string) => {
    if (!confirm("Are you sure you want to delete this contact?")) return;

    setIsLoading(true);
    try {
      const response = await fetch(`/api/contacts/${id}`, {
        method: "DELETE",
      });

      if (!response.ok) throw new Error("Failed to delete contact");

      setLocalContacts((prev) => prev.filter((c) => c.id !== id));
      router.refresh();
    } catch (error) {
      console.error("Error deleting contact:", error);
    } finally {
      setIsLoading(false);
    }
  };

  const startEditing = (contact: Contact) => {
    setEditingId(contact.id);
    setEditContact({
      name: contact.name,
      email: contact.email,
      phone: contact.phone || "",
      role: contact.role || "",
    });
  };

  return (
    <div className="space-y-4">
      {localContacts.length > 0 ? (
        <div className="space-y-2">
          {localContacts.map((contact) => (
            <div
              key={contact.id}
              className="flex items-center justify-between p-3 bg-muted rounded-lg"
            >
              {editingId === contact.id ? (
                <div className="flex-1 grid grid-cols-2 md:grid-cols-4 gap-2 mr-2">
                  <Input
                    value={editContact.name}
                    onChange={(e) =>
                      setEditContact((prev) => ({ ...prev, name: e.target.value }))
                    }
                    placeholder="Name"
                  />
                  <Input
                    value={editContact.email}
                    onChange={(e) =>
                      setEditContact((prev) => ({ ...prev, email: e.target.value }))
                    }
                    placeholder="Email"
                  />
                  <Input
                    value={editContact.phone}
                    onChange={(e) =>
                      setEditContact((prev) => ({ ...prev, phone: e.target.value }))
                    }
                    placeholder="Phone"
                  />
                  <Input
                    value={editContact.role}
                    onChange={(e) =>
                      setEditContact((prev) => ({ ...prev, role: e.target.value }))
                    }
                    placeholder="Role"
                  />
                </div>
              ) : (
                <div>
                  <p className="font-medium">{contact.name}</p>
                  <p className="text-sm text-muted-foreground">
                    {contact.email}
                    {contact.role && ` • ${contact.role}`}
                  </p>
                  {contact.phone && (
                    <p className="text-xs text-muted-foreground flex items-center gap-1">
                      <Phone className="h-3 w-3" />
                      {contact.phone}
                    </p>
                  )}
                </div>
              )}
              <div className="flex items-center gap-1">
                {editingId === contact.id ? (
                  <>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => handleEditContact(contact.id)}
                      disabled={isLoading}
                    >
                      {isLoading ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Check className="h-4 w-4" />
                      )}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => setEditingId(null)}
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </>
                ) : (
                  <>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => startEditing(contact)}
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-destructive hover:text-destructive"
                      onClick={() => handleDeleteContact(contact.id)}
                      disabled={isLoading}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground text-center py-4">
          No contacts yet. Add contacts to start drafting emails.
        </p>
      )}

      {isAdding ? (
        <div className="border rounded-lg p-4 space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="name">Name *</Label>
              <Input
                id="name"
                value={newContact.name}
                onChange={(e) =>
                  setNewContact((prev) => ({ ...prev, name: e.target.value }))
                }
                placeholder="John Doe"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="email">Email *</Label>
              <Input
                id="email"
                type="email"
                value={newContact.email}
                onChange={(e) =>
                  setNewContact((prev) => ({ ...prev, email: e.target.value }))
                }
                placeholder="john@company.com"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="phone">Phone (optional)</Label>
              <Input
                id="phone"
                type="tel"
                value={newContact.phone}
                onChange={(e) =>
                  setNewContact((prev) => ({ ...prev, phone: e.target.value }))
                }
                placeholder="(555) 123-4567"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="role">Role (optional)</Label>
              <Input
                id="role"
                value={newContact.role}
                onChange={(e) =>
                  setNewContact((prev) => ({ ...prev, role: e.target.value }))
                }
                placeholder="CEO, CTO, etc."
              />
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              onClick={() => {
                setIsAdding(false);
                setNewContact({ name: "", email: "", phone: "", role: "" });
              }}
            >
              Cancel
            </Button>
            <Button onClick={handleAddContact} disabled={isLoading}>
              {isLoading ? (
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
              ) : null}
              Add Contact
            </Button>
          </div>
        </div>
      ) : (
        <Button variant="outline" onClick={() => setIsAdding(true)}>
          <Plus className="h-4 w-4 mr-2" />
          Add Contact
        </Button>
      )}
    </div>
  );
}
