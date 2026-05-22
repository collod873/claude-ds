import React from "react";
import {
  sampleContact,
  formatContact,
  type ContactFixture,
} from "@/design-system/_fixtures/contact-fixtures";

interface ContactCardProps {
  contact: ContactFixture;
  format?: (c: ContactFixture) => string;
}

export const meta = {
  kind: "composite" as const,
  examples: [
    {
      name: "default",
      props: {
        // Passing the whole fixture object exercises the direct carry path:
        // sampleContact is in importScope with rawSpec "@/..." so must be
        // carried as alias form. Also, sampleContact.formatAddress is an arrow
        // that references sampleAddress (from "./address-fixtures"), which
        // exercises the transitive carry path — the emitted spec must be the
        // alias "@/design-system/_fixtures/address-fixtures", not "./address-fixtures".
        contact: sampleContact,
        format: (c: ContactFixture) => formatContact(c),
      },
    },
  ],
};

export default function ContactCard({ contact, format }: ContactCardProps) {
  return (
    <div>
      <p>{contact.name}</p>
      {format && <p>{format(contact)}</p>}
    </div>
  );
}
