// Direct fixture imported by the composite via @/ alias.
// Also imports from a sibling fixture via a relative path (transitive case).
import { sampleAddress } from "./address-fixtures";

export interface ContactFixture {
  name: string;
  city: string;
  // A method on the fixture object — resolved as an FnMarker.
  // The FnMarker body references sampleAddress, which is in this file's
  // importScope with rawSpec "./address-fixtures". Without the fix this would
  // be carried into the showcase verbatim, anchored to _fixtures/ not composites/.
  formatAddress: () => string;
}

export const sampleContact: ContactFixture = {
  name: "Jane Doe",
  city: "Springfield",
  formatAddress: () => sampleAddress.street,
};

export const formatContact = (c: ContactFixture) => c.formatAddress();
