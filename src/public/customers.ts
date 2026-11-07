/**
 * Customers (lld/payments.md §4, §6.1, §12, §17) — Stage 2.
 *
 * A customer is the merchant's record of a payer: receipt email, name and known wallets. Email and
 * name are personal data: envelope-encrypted at rest, returned to the merchant, never in events.
 * Attach a customer to a checkout session or payment intent with `customer`.
 */
import { id } from "../common/ids.js";
import { createdFilterShape, listOf, listQueryShape } from "../common/pagination.js";
import { ChainAddress, ChainId, Livemode, Metadata, UnixTime } from "../common/primitives.js";
import { route } from "../common/route.js";
import { inp, out, z } from "../common/schema.js";

export const CustomerWallet = out({
  chain: ChainId.describe("Chain of the wallet (`near:mainnet` for NEAR and Intents accounts)."),
  address: ChainAddress.describe("Wallet address or NEAR account."),
}).meta({ id: "CustomerWallet", description: "A wallet the customer pays from." });

const WalletInput = inp({
  chain: ChainId.describe("Chain of the wallet."),
  address: ChainAddress.describe("Wallet address or NEAR account."),
});

export const Customer = out({
  id: id("cus"),
  object: z.literal("customer").describe("Always `customer`."),
  created: UnixTime,
  livemode: Livemode,
  email: z.email().nullable().describe("Receipt email."),
  name: z.string().nullable().describe("Name."),
  description: z.string().nullable().describe("Internal description."),
  wallets: z
    .array(CustomerWallet)
    .describe("Known wallets (informational; refunds always use the payment's refund address)."),
  metadata: Metadata,
}).meta({ id: "Customer", description: "A payer the merchant knows." });
export type Customer = z.infer<typeof Customer>;

export const DeletedCustomer = out({
  id: id("cus"),
  object: z.literal("customer").describe("Always `customer`."),
  deleted: z.literal(true).describe("Always `true`."),
}).meta({ id: "DeletedCustomer", description: "A deleted customer." });

const CustomerParams = inp({ id: id("cus") });
const WRITE = ["secret_key", "restricted_key:customers.write", "session"] as const;
const READ = ["secret_key", "restricted_key:customers.read", "session"] as const;
const CUSTOMER_ROLES = ["owner", "admin", "finance", "support"] as const;

const customerFields = {
  email: z.email().max(254).describe("Receipt email."),
  name: z.string().min(1).max(200).describe("Name."),
  description: z.string().max(500).describe("Internal description."),
  wallets: z.array(WalletInput).max(20).describe("Known wallets."),
};

export const createCustomer = route({
  id: "createCustomer",
  method: "POST",
  path: "/v1/customers",
  service: "payments",
  visibility: "public",
  summary: "Create a customer.",
  auth: WRITE,
  roles: CUSTOMER_ROLES,
  idempotent: true,
  body: inp({
    email: customerFields.email.optional(),
    name: customerFields.name.optional(),
    description: customerFields.description.optional(),
    wallets: customerFields.wallets.optional(),
    metadata: Metadata.optional(),
  }).meta({ id: "CustomerCreate", description: "Parameters to create a customer." }),
  response: Customer,
  status: 201,
  errors: [],
  stage: 2,
});

export const getCustomer = route({
  id: "getCustomer",
  method: "GET",
  path: "/v1/customers/{id}",
  service: "payments",
  visibility: "public",
  summary: "Retrieve a customer.",
  auth: READ,
  idempotent: false,
  params: CustomerParams,
  response: Customer,
  status: 200,
  errors: [],
  stage: 2,
});

export const listCustomers = route({
  id: "listCustomers",
  method: "GET",
  path: "/v1/customers",
  service: "payments",
  visibility: "public",
  summary: "List customers.",
  auth: READ,
  idempotent: false,
  query: inp({
    ...listQueryShape,
    ...createdFilterShape,
    email: z.email().max(254).optional().describe("Only customers with this email (exact, case-insensitive)."),
  }),
  response: listOf(Customer, "CustomerList", "A page of customers."),
  status: 200,
  errors: [],
  stage: 2,
});

export const updateCustomer = route({
  id: "updateCustomer",
  method: "PATCH",
  path: "/v1/customers/{id}",
  service: "payments",
  visibility: "public",
  summary: "Update a customer (`null` clears a field).",
  auth: WRITE,
  roles: CUSTOMER_ROLES,
  idempotent: true,
  params: CustomerParams,
  body: inp({
    email: customerFields.email.nullable().optional(),
    name: customerFields.name.nullable().optional(),
    description: customerFields.description.nullable().optional(),
    wallets: customerFields.wallets.optional().describe("Replaces the wallet list."),
    metadata: Metadata.optional(),
  }).meta({ id: "CustomerUpdate", description: "Customer fields to change." }),
  response: Customer,
  status: 200,
  errors: ["customer_deleted"],
  stage: 2,
});

export const deleteCustomer = route({
  id: "deleteCustomer",
  method: "DELETE",
  path: "/v1/customers/{id}",
  service: "payments",
  visibility: "public",
  summary: "Delete a customer (personal data is erased; payments keep the customer id).",
  auth: WRITE,
  roles: CUSTOMER_ROLES,
  idempotent: false,
  params: CustomerParams,
  response: DeletedCustomer,
  status: 200,
  errors: [],
  stage: 2,
});
