import type { OrderAddress } from "@woolrus/contracts";

/** An address on one line: name, company, street, city, country. */
export function formatAddress(address: OrderAddress): string {
  const cityLine = [address.city, [address.state, address.postalCode].filter(Boolean).join(" ")]
    .filter(Boolean)
    .join(", ");
  return [address.name, address.company, address.address1, address.address2, cityLine]
    .concat(address.country ?? [])
    .filter(Boolean)
    .join(" · ");
}
